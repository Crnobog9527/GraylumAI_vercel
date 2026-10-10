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
  if (!refs.data?.order_id) return false;
  const result = await db.from('payment_orders').select('*').eq('id', refs.data.order_id).maybeSingle();
  if (result.error || !result.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const order = result.data;
  if (!order.payment_method) return false;
  if (scope.mode !== 'test' || !['wechat_pay', 'alipay'].includes(order.payment_method)) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  const cash = await readWalletPaymentEvidence({ stripe, scope, order, sessionId });
  if (!cash) return true;
  // Renewal requires the locked original-term transaction; never invent a new start from payment time.
  if (order.method_transition) throw new Error('PAY_WAFFO_TRANSITION_NOT_READY');
  const term = order.item_type === 'membership_plan'
    ? walletMembershipTerm({ paidAt: cash.paidAt, term: order.entitlement_term }) : null;
  const applied = await db.rpc('pay_waffo_fulfill_payment', {
    p_order: order.id, p_merchant: scope.merchant, p_checkout: cash.checkoutId, p_payment: cash.paymentId,
    p_amount: cash.amount, p_currency: cash.currency, p_paid_at: cash.paidAt, p_subscription: null,
    p_start: term?.start ?? null, p_end: term?.end ?? null,
  });
  if (applied.error || !applied.data) throw new Error('PAY_WAFFO_FULFILLMENT_UNAVAILABLE');
  return true;
}
