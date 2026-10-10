/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { assertPurchaseReceipt, type StripeScope } from './purchaseFacts';

const id = (value: string | { id: string } | null) => typeof value === 'string' ? value : value?.id;

/** Called with the original scoped client and a server-loaded order, never browser payment facts.
 * Async Checkout completion alone is not a successful payment. */
export async function readWalletPaymentEvidence(input: {
  stripe: Pick<Stripe, 'checkout' | 'paymentIntents' | 'charges'>; scope: StripeScope;
  order: { id: string; user_id: string; purchase_snapshot: unknown; payment_method: 'wechat_pay' | 'alipay';
    payment_channel: string; merchant_namespace: string; payment_mode: string };
  sessionId: string;
}) {
  const { stripe, scope, order } = input;
  if (scope.mode !== 'test') throw new Error('PAY_WAFFO_LIVE_DISABLED');
  if (order.payment_channel !== 'stripe' || order.payment_mode !== scope.mode
    || order.merchant_namespace !== scope.merchant) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  const session = await stripe.checkout.sessions.retrieve(input.sessionId);
  if (session.object !== 'checkout.session' || session.id !== input.sessionId || session.mode !== 'payment' || session.livemode
    || session.client_reference_id !== order.user_id || session.metadata?.userId !== order.user_id
    || session.metadata?.orderId !== order.id || session.payment_method_types.length !== 1
    || session.payment_method_types[0] !== order.payment_method) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  assertPurchaseReceipt({ snapshot: order.purchase_snapshot, scope, amount: session.amount_total,
    currency: session.currency, livemode: session.livemode });
  if (session.payment_status !== 'paid') return null;
  const intentId = id(session.payment_intent);
  if (!intentId) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const chargeId = id(intent.latest_charge);
  if (intent.object !== 'payment_intent' || intent.id !== intentId || intent.livemode || intent.status !== 'succeeded' || !chargeId
    || intent.metadata.orderId !== order.id || intent.metadata.userId !== order.user_id
    || id(intent.customer) !== id(session.customer)) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  assertPurchaseReceipt({ snapshot: order.purchase_snapshot, scope, amount: intent.amount_received,
    currency: intent.currency, livemode: intent.livemode });
  const charge = await stripe.charges.retrieve(chargeId);
  if (charge.object !== 'charge' || charge.id !== chargeId || charge.livemode || !charge.paid || !charge.captured || charge.status !== 'succeeded'
    || id(charge.payment_intent) !== intentId || charge.payment_method_details?.type !== order.payment_method
    || charge.refunded || charge.amount_refunded !== 0 || id(charge.customer) !== id(session.customer)) {
    throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  }
  assertPurchaseReceipt({ snapshot: order.purchase_snapshot, scope, amount: charge.amount_captured,
    currency: charge.currency, livemode: charge.livemode });
  if (!Number.isSafeInteger(charge.created) || charge.created <= 0) throw new Error('PAY_WAFFO_PAYMENT_CONFLICT');
  return { paymentId: intentId, chargeId, checkoutId: session.id, amount: charge.amount_captured,
    currency: charge.currency, paidAt: new Date(charge.created * 1000).toISOString() };
}
