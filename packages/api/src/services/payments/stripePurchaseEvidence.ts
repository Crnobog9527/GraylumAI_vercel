/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { freezePurchaseSnapshot } from './contracts';
import { assertPurchaseReceipt, majorToCents, type StripeScope } from './purchaseFacts';

export function assertStripePurchasePrice(input: {
  price: Stripe.Price;
  priceId: string;
  snapshot: unknown;
  scope: StripeScope;
}) {
  const snapshot = freezePurchaseSnapshot(input.snapshot);
  const price = input.price;
  const recurring = snapshot.billing_cycle !== 'one_time';
  if (price.id !== input.priceId || price.object !== 'price' || !price.active
    || price.livemode !== (input.scope.mode === 'live') || price.currency !== snapshot.currency
    || price.unit_amount !== majorToCents(snapshot.price) || price.billing_scheme !== 'per_unit'
    || price.custom_unit_amount || price.transform_quantity || price.tiers_mode
    || (price.tax_behavior ?? 'unspecified') !== snapshot.tax_behavior
    || price.type !== (recurring ? 'recurring' : 'one_time')
    || (recurring && (price.recurring?.interval !== (snapshot.billing_cycle === 'yearly' ? 'year' : 'month')
      || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed'))
    || (!recurring && price.recurring !== null)) {
    throw new Error('PAY_COMMON_PRICE_MISMATCH');
  }
  return price;
}

export type CheckoutEvidenceOrder = {
  id: string;
  user_id: string;
  payment_channel: string;
  merchant_namespace: string;
  payment_mode: 'test' | 'live';
  purchase_snapshot: unknown;
};

type EvidenceDb = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

// The caller supplies the original order and its mapped external session, never a browser's
// claim that checkout was canceled. Network failure leaves the original intent unresolved.
export async function closeExpiredStripeCheckout(input: {
  stripe: Pick<Stripe, 'checkout'>;
  supabase: EvidenceDb;
  order: CheckoutEvidenceOrder;
  mappedSessionId: string;
  scope: StripeScope;
}) {
  const { order, scope } = input;
  if (order.payment_channel !== 'stripe' || order.merchant_namespace !== scope.merchant
    || order.payment_mode !== scope.mode) throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  const session = await input.stripe.checkout.sessions.retrieve(input.mappedSessionId);
  if (session.id !== input.mappedSessionId || session.object !== 'checkout.session'
    || session.client_reference_id !== order.user_id || session.metadata?.orderId !== order.id
    || session.metadata?.userId !== order.user_id || session.status !== 'expired'
    || session.payment_status !== 'unpaid' || session.payment_intent || session.subscription) {
    throw new Error('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  }
  const snapshot = assertPurchaseReceipt({ snapshot: order.purchase_snapshot, amount: session.amount_total,
    currency: session.currency, livemode: session.livemode, scope });
  if (session.mode !== (snapshot.item_type === 'membership_plan' ? 'subscription' : 'payment')) {
    throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  }
  const result = await input.supabase.rpc('pay_common_close_checkout', {
    p_user_id: order.user_id, p_order_id: order.id, p_session_id: session.id,
    p_merchant_namespace: scope.merchant, p_payment_mode: scope.mode,
    p_checkout_status: session.status, p_payment_status: session.payment_status,
  });
  if (result.error) throw new Error('PAY_COMMON_ATTEMPT_CLOSE_FAILED', { cause: result.error });
  if (typeof result.data !== 'boolean') throw new Error('PAY_COMMON_ATTEMPT_CLOSE_FAILED');
  return result.data;
}

export function isExpectedRecurringUpgradePrice(price: Stripe.Price, input: {
  mode: 'test' | 'live';
  priceId: string;
  amount: number;
  currency: string;
  billingCycle: 'monthly' | 'yearly';
}) {
  return price.id === input.priceId && price.object === 'price' && price.livemode === (input.mode === 'live')
    && price.billing_scheme === 'per_unit' && !price.custom_unit_amount && !price.transform_quantity && !price.tiers_mode
    && (price.tax_behavior ?? 'unspecified') === 'unspecified' && price.recurring?.usage_type === 'licensed'
    && price.type === 'recurring'
    && price.currency === input.currency
    && price.unit_amount === input.amount
    && price.recurring?.interval === (input.billingCycle === 'yearly' ? 'year' : 'month')
    && price.recurring.interval_count === 1;
}
