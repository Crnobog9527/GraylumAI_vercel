/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { readWalletPaymentEvidence } from './walletPaymentEvidence';
import { walletMembershipTerm } from './methodMembershipTerm';

/** Resolve ownership from the original checkout mapping. Event metadata cannot choose an account.
 * The same entry supports callback retry and original-session recovery after a timeout. */
export async function recoverWalletCheckout(db: SupabaseClient, stripe: Stripe, sessionId: string) {
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
    if (!originalId || !/^[0-9a-f-]{36}$/i.test(originalId)) return false;
    orderId = originalId;
  }
  const result = await db.from('payment_orders').select('*').eq('id', orderId).maybeSingle();
  if (result.error || !result.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const order = result.data;
  if (!order.payment_method) return false;
  if (scope.mode !== 'test' || !['wechat_pay', 'alipay'].includes(order.payment_method)) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  let observed: { status: string | null; payment_status: string } | null = null;
  const cash = await readWalletPaymentEvidence({ stripe, scope, order, sessionId,
    onValidatedSession: value => { observed = value; } });
  if (recoveredSession) {
    const bound = await db.rpc('pay_waffo_bind_checkout', { p_user: order.user_id, p_order: order.id, p_merchant: scope.merchant,
      p_checkout: recoveredSession.id, p_expires: new Date(recoveredSession.expires_at * 1000).toISOString() });
    if (bound.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  }
  const validated = observed as { status: string | null; payment_status: string } | null;
  if (!cash) {
    if (validated?.status === 'expired' && validated.payment_status === 'unpaid') {
      const closed = await db.rpc('pay_waffo_observe_qualification', { p_order: order.id, p_merchant: scope.merchant,
        p_mode: 'test', p_checkout: sessionId, p_state: 'closed_unpaid', p_payment: null, p_amount: 0, p_currency: 'usd', p_paid_at: null });
      if (closed.error) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
    }
    return true;
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
  const term = order.item_type === 'membership_plan'
    ? walletMembershipTerm({ paidAt: cash.paidAt, term: order.entitlement_term, founderRenewal: renewal }) : null;
  const applied = await db.rpc('pay_waffo_fulfill_payment', {
    p_order: order.id, p_merchant: scope.merchant, p_checkout: cash.checkoutId, p_payment: cash.paymentId,
    p_amount: cash.amount, p_currency: cash.currency, p_paid_at: cash.paidAt, p_subscription: null,
    p_start: term?.start ?? null, p_end: term?.end ?? null,
  });
  if (applied.error || !applied.data) throw new Error('PAY_WAFFO_FULFILLMENT_UNAVAILABLE');
  return true;
}
