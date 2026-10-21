/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { readWalletPaymentEvidence } from './walletPaymentEvidence';
import { walletMembershipTerm } from './methodMembershipTerm';
import { logger } from '../../lib/logger';
import { readCardPaymentEvidence, recordCardPaymentTax, type CardOrder, type CardPaymentEvidence } from './cardPaymentEvidence';
import { stopPriorAfterUpgrade } from './cardUpgrade';
import { stopUndeliveredSubscription } from './cardSubscriptionStop';
import { readDisputePayment } from './disputePayment';
import { resumeOrderDisputes, type DisputeAlert } from './disputes';
import { reportGaPurchase } from '../analytics/gaPurchase';

const isCard = (method: string) => method === 'card' || method === 'card_cn';

/** The price this order was admitted with, from the same mapping admission used. */
async function orderPriceId(db: SupabaseClient, order: { price_ref_id: string; merchant_namespace: string; payment_mode: string }) {
  const price = await db.from('payment_provider_refs').select('external_id').eq('id', order.price_ref_id).eq('channel', 'stripe')
    .eq('merchant_namespace', order.merchant_namespace).eq('mode', order.payment_mode).eq('object_type', 'price').maybeSingle();
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
  verifiedEventType?: string, disputeAlert?: DisputeAlert) {
  return Boolean(await recoverMethodCheckout(db, stripe, sessionId, verifiedEventType, disputeAlert));
}

/** New-method orders (wallet one-time, PAY-STRIPE-MP card / card_cn): resolve ownership from the original
 * checkout mapping, never event metadata. Supports callback retry, browser return and original-session
 * recovery after a timeout. Returns null for orders of the legacy path, and { orderId: null } for an unpaid
 * session that is not ours (acknowledged, nothing to do). */
export async function recoverMethodCheckout(db: SupabaseClient, stripe: Stripe, sessionId: string,
  verifiedEventType?: string, disputeAlert?: DisputeAlert): Promise<{ orderId: string | null; checkoutStatus?: Stripe.Checkout.Session['status'];
    paymentStatus?: Stripe.Checkout.Session['payment_status'] | null } | null> {
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
  // R7 (0296): the order was admitted in this Stripe account's mode; a test order never settles in live, or the reverse.
  if (order.payment_mode !== scope.mode || !['wechat_pay', 'alipay', 'card', 'card_cn'].includes(order.payment_method)) {
    throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  }
  let observed: Pick<Stripe.Checkout.Session, 'status' | 'payment_status'> | null = null;
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
  const validated = observed as Pick<Stripe.Checkout.Session, 'status' | 'payment_status'> | null;
  if (!cash) {
    if (validated?.payment_status === 'unpaid' && (validated.status === 'expired'
      || validated.status === 'complete' && verifiedEventType === 'checkout.session.async_payment_failed')) {
      const closed = await db.rpc('pay_waffo_observe_qualification', { p_order: order.id, p_merchant: scope.merchant,
        p_mode: scope.mode, p_checkout: sessionId,
        p_state: validated.status === 'complete' && !isCard(order.payment_method) ? 'failed_unpaid' : 'closed_unpaid',
        p_payment: null, p_amount: 0, p_currency: 'usd', p_paid_at: null });
      if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');

    }
    // The session as this recovery validated it (newer than the caller's copy): a browser return reports it.
    return { orderId: order.id, checkoutStatus: validated?.status ?? null, paymentStatus: validated?.payment_status ?? null };
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
  const payment = await readDisputePayment(stripe, scope, { paymentIntentId: cash.paymentId.startsWith('pi_') ? cash.paymentId : null,
    invoiceId: cash.paymentId.startsWith('in_') ? cash.paymentId : null });
  const applied = await db.rpc('pay_dispute_fulfill', { p_facts: {
    orderId: order.id, merchant: scope.merchant, mode: scope.mode, checkoutId: cash.checkoutId, paymentId: cash.paymentId,
    paymentIntentId: payment.paymentIntentId, amount: cash.amount, currency: cash.currency, paidAt: cash.paidAt,
    subscriptionId: card?.id ?? null, start: term?.start ?? null, end: term?.end ?? null,
  } });
  if (applied.error || !applied.data) throw new Error('PAY_WAFFO_FULFILLMENT_UNAVAILABLE');
  // A delivered Pro -> Gold upgrade stops the prior card subscription at period end (PAY-STRIPE-MP step 4a). Every
  // replay of a delivered payment comes back 'fulfilled' and repeats both steps; neither failure skips the other, so
  // a tax bookkeeping failure can never leave the replaced Pro renewing next to the Gold.
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<unknown>) => { try { await step(); } catch (error) { failures.push(error); } };
  const fulfillment = applied.data as { state?: string; disputeFrozen?: boolean; duplicate?: unknown };
  // Dispute receipt and fulfillment serialize in pay_dispute_fulfill. A payment can therefore be recorded as
  // fulfilled while its newly granted source is already frozen; that is review, not a delivered upgrade.
  const delivered = fulfillment.state === 'fulfilled' && fulfillment.disputeFrozen !== true;
  await attempt(() => resumeOrderDisputes(db, stripe, order.id, disputeAlert));
  if (delivered) await attempt(() => stopPriorAfterUpgrade(db, stripe, order));
  // Paid but kept for review (not delivered): its card subscription must not renew; the prior Pro is kept.
  else if (card) await attempt(() => stopUndeliveredSubscription(stripe, card.id));
  if ('tax' in cash) await attempt(() => recordCardPaymentTax(db, scope.merchant, order.id, cash));
  // ANALYTICS: only the call that newly delivered the order (duplicate false) reports, whichever caller wins
  // (webhook, browser return, reconciliation). Statistics only: it never throws and never blocks delivery.
  if (delivered && (applied.data as { duplicate?: unknown }).duplicate === false) await reportGaPurchase(db, order);
  if (failures.length) throw failures[0];
  return { orderId: order.id, checkoutStatus: validated?.status ?? null, paymentStatus: 'paid' as const };
}
