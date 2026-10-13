/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { readWalletPaymentEvidence } from './walletPaymentEvidence';
import { walletMembershipTerm } from './methodMembershipTerm';
import { logger } from '../../lib/logger';
import { readCardPaymentEvidence, recordCardPaymentTax, type CardOrder, type CardPaymentEvidence } from './cardPaymentEvidence';

const isCard = (method: string) => method === 'card' || method === 'card_cn';

/** The price this order was admitted with, from the same mapping admission used. */
async function orderPriceId(db: SupabaseClient, order: { price_ref_id: string; merchant_namespace: string }) {
  const price = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id).eq('channel', 'stripe')
    .eq('merchant_namespace', order.merchant_namespace).eq('mode', 'test').eq('object_type', 'price').maybeSingle();
  if (price.error || !price.data?.external_id) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  return price.data.external_id as string;
}

/** A session we never created an order for (the test sandbox is shared with other tools, e.g. the
 * PAY-STRIPE-MP probes): orders are committed before their session exists, so an unknown or missing order
 * means the session is not ours. Unpaid ones are acknowledged so Stripe stops retrying; a paid one still
 * fails loudly because money must never be silently dropped. */
function foreignSession(session: Stripe.Checkout.Session, reason: string) {
  if (session.payment_status === 'paid') return false;
  logger.warn('billing', 'stripe_checkout_foreign_session_ignored', { reason, status: session.status, mode: session.mode });
  return true;
}

export async function recoverWalletCheckout(db: SupabaseClient, stripe: Stripe, sessionId: string,
  verifiedEventType?: string) {
  return Boolean(await recoverMethodCheckout(db, stripe, sessionId, verifiedEventType));
}

/** New-method orders (wallet one-time, PAY-STRIPE-MP card / card_cn): resolve ownership from the original
 * checkout mapping, never event metadata. Supports callback retry, browser return and original-session
 * recovery after a timeout. Returns null for orders of the legacy path, and { orderId: null } for an unpaid
 * session that is not ours (acknowledged, nothing to do). */
export async function recoverMethodCheckout(db: SupabaseClient, stripe: Stripe, sessionId: string,
  verifiedEventType?: string): Promise<{ orderId: string | null } | null> {
  const scope = await resolveStripeScope(stripe);
  const refs = await db.from('payment_provider_refs').select('order_id').eq('channel', 'stripe')
    .eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).eq('object_type', 'checkout').eq('external_id', sessionId).maybeSingle();
  if (refs.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  let orderId = refs.data?.order_id;
  let recoveredSession: Stripe.Checkout.Session | null = null;
  if (!orderId) {
    // A provider success can arrive before bind_checkout commits (or after its timeout).
    // Use the authenticated original Session, never the event's customer/order metadata.
    recoveredSession = await stripe.checkout.sessions.retrieve(sessionId);
    if (recoveredSession.object !== 'checkout.session' || recoveredSession.id !== sessionId) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
    const originalId = recoveredSession.metadata?.orderId;
    if (!originalId || !/^[0-9a-f-]{36}$/i.test(originalId)) return foreignSession(recoveredSession, 'no_order') ? { orderId: null } : null;
    orderId = originalId;
  }
  const result = await db.from('payment_orders').select('*').eq('id', orderId).maybeSingle();
  if (!result.error && !result.data && recoveredSession && foreignSession(recoveredSession, 'unknown_order')) return { orderId: null };
  if (result.error || !result.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const order = result.data;
  if (!order.payment_method) return null;
  if (scope.mode !== 'test' || !['wechat_pay', 'alipay', 'card', 'card_cn'].includes(order.payment_method)) {
    throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  }
  let observed: { status: string | null; payment_status: string } | null = null;
  const onValidatedSession = (value: Stripe.Checkout.Session) => { observed = value; };
  const cash: CardPaymentEvidence | Awaited<ReturnType<typeof readWalletPaymentEvidence>> = isCard(order.payment_method)
    ? await readCardPaymentEvidence({ stripe, scope, order: order as CardOrder, sessionId, onValidatedSession,
      priceId: await orderPriceId(db, order) })
    : await readWalletPaymentEvidence({ stripe, scope, order, sessionId, onValidatedSession });
  if (recoveredSession) {
    const bound = await db.rpc('pay_waffo_bind_checkout', { p_user: order.user_id, p_order: order.id, p_merchant: scope.merchant,
      p_checkout: recoveredSession.id, p_expires: new Date(recoveredSession.expires_at * 1000).toISOString() });
    if (bound.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  }
  const validated = observed as { status: string | null; payment_status: string } | null;
  if (!cash) {
    if (validated?.payment_status === 'unpaid' && (validated.status === 'expired'
      || validated.status === 'complete' && verifiedEventType === 'checkout.session.async_payment_failed')) {
      const closed = await db.rpc('pay_waffo_observe_qualification', { p_order: order.id, p_merchant: scope.merchant,
        p_mode: 'test', p_checkout: sessionId, p_state: 'closed_unpaid', p_payment: null, p_amount: 0, p_currency: 'usd', p_paid_at: null });
      if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    }
    return { orderId: order.id };
  }
  let renewal: { originalEnd: string; eligibleUntil: string } | undefined;
  if (order.method_transition === 'founder_renewal') {
    const original = await db.from('payment_orders').select('entitlement_end').eq('id', order.source_order_id)
      .eq('user_id', order.user_id).maybeSingle();
    const deadline = await db.rpc('pay_waffo_founder_deadline', { p_order: order.source_order_id });
    if (original.error || !original.data?.entitlement_end || deadline.error || typeof deadline.data !== 'string') {
      throw new Error('PAY_WAFFO_FOUNDER_UNAVAILABLE');
    }
    renewal = { originalEnd: new Date(original.data.entitlement_end).toISOString(), eligibleUntil: new Date(deadline.data).toISOString() };
  }
  // A card subscription's term is the Stripe subscription's own current period (calendar month or year).
  const card = 'subscription' in cash ? cash.subscription : null;
  const term = card ? { start: card.start, end: card.end } : order.item_type === 'membership_plan'
    ? walletMembershipTerm({ paidAt: cash.paidAt, term: order.entitlement_term, founderRenewal: renewal }) : null;
  const applied = await db.rpc('pay_waffo_fulfill_payment', {
    p_order: order.id, p_merchant: scope.merchant, p_checkout: cash.checkoutId, p_payment: cash.paymentId,
    p_amount: cash.amount, p_currency: cash.currency, p_paid_at: cash.paidAt, p_subscription: card?.id ?? null,
    p_start: term?.start ?? null, p_end: term?.end ?? null,
  });
  if (applied.error || !applied.data) throw new Error('PAY_WAFFO_FULFILLMENT_UNAVAILABLE');
  if ('tax' in cash) await recordCardPaymentTax(db, scope.merchant, order.id, cash);
  return { orderId: order.id };
}
