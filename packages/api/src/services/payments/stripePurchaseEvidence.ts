/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import { freezePurchaseSnapshot } from './contracts';
import { assertPurchaseReceipt, majorToCents, type StripeScope } from './purchaseFacts';

export function assertStripePurchasePrice(input: {
  price: Stripe.Price;
  priceId: string;
  snapshot: unknown;
  scope: StripeScope;
  walletMethod?: 'wechat_pay' | 'alipay';
}) {
  const snapshot = freezePurchaseSnapshot(input.snapshot);
  const price = input.price;
  const recurring = snapshot.billing_cycle !== 'one_time' && !input.walletMethod;
  if (input.walletMethod && input.scope.mode !== 'test') throw new Error('PAY_WAFFO_LIVE_DISABLED');
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

function objectId(value: string | { id: string } | null) {
  return typeof value === 'string' ? value : value?.id ?? null;
}

async function readClosureEvidence<T>(request: PromiseLike<T>): Promise<T> {
  try { return await request; } catch (cause) {
    throw new Error('PAY_COMMON_ATTEMPT_EVIDENCE_UNAVAILABLE', { cause });
  }
}

async function assertUnpaidIntent(input: {
  stripe: Pick<Stripe, 'paymentIntents' | 'charges'>;
  session: Stripe.Checkout.Session;
  order: CheckoutEvidenceOrder;
  scope: StripeScope;
  beforeExpiration?: boolean;
}) {
  const { stripe, session, order, scope } = input;
  const intentId = objectId(session.payment_intent);
  if (!intentId) throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  // Use the same authenticated client as the original scoped Checkout read. Expanded
  // objects, last_payment_error and a browser cancellation are not payment evidence.
  const intent = await readClosureEvidence(stripe.paymentIntents.retrieve(intentId));
  if (intent.id !== intentId || intent.object !== 'payment_intent'
    || intent.metadata?.orderId !== order.id || intent.metadata?.userId !== order.user_id
    || intent.customer === undefined || session.customer === undefined || intent.latest_charge === undefined
    || objectId(intent.customer) !== objectId(session.customer)) {
    throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  }
  assertPurchaseReceipt({ snapshot: order.purchase_snapshot, amount: intent.amount,
    currency: intent.currency, livemode: intent.livemode, scope });
  if (!(intent.status === 'canceled' || ((session.status === 'expired' || input.beforeExpiration) && intent.status === 'requires_payment_method'))
    || intent.amount_received !== 0 || intent.amount_capturable !== 0) {
    throw new Error('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  }
  const snapshot = freezePurchaseSnapshot(order.purchase_snapshot);
  if (intent.metadata.itemId !== snapshot.item_id || intent.metadata.itemType !== snapshot.item_type
    || intent.metadata.billingCycle !== snapshot.billing_cycle
    || !intent.metadata.priceId || intent.metadata.priceId !== session.metadata?.priceId) {
    throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  }
  const latestCharge = objectId(intent.latest_charge);
  let latestSeen = latestCharge === null;
  let cursor: string | undefined;
  // A failed latest charge alone does not prove the absence of earlier successful charges.
  // Bound the scan; an incomplete or malformed response leaves the purchase unresolved.
  for (let page = 0; page < 10; page++) {
    const charges = await readClosureEvidence(stripe.charges.list({ payment_intent: intentId, limit: 100,
      ...(cursor ? { starting_after: cursor } : {}) }));
    if (charges.object !== 'list' || !Array.isArray(charges.data) || typeof charges.has_more !== 'boolean'
      || (latestCharge === null && charges.data.length > 0)) break;
    for (const charge of charges.data) {
      if (charge.object !== 'charge' || !charge.id || objectId(charge.payment_intent) !== intentId
        || charge.livemode !== (scope.mode === 'live') || charge.currency !== intent.currency
        || charge.amount !== intent.amount || charge.customer === undefined
        || objectId(charge.customer) !== objectId(intent.customer)
        || charge.status !== 'failed' || charge.paid !== false || charge.amount_captured !== 0) {
        throw new Error('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
      }
      if (charge.id === latestCharge) latestSeen = true;
    }
    if (!charges.has_more) {
      if (latestSeen) return;
      break;
    }
    const next = charges.data.at(-1)?.id;
    if (!next || next === cursor) break;
    cursor = next;
  }
  throw new Error('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
}

// Check monetary facts before the provider mutation, then closeExpiredStripeCheckout reads again.
// Stripe's open-session-only expiration arbitrates a payment racing the preflight.
export async function expireUnpaidStripeCheckout(input: {
  stripe: Pick<Stripe, 'checkout' | 'paymentIntents' | 'charges'>;
  session: Stripe.Checkout.Session;
  order: CheckoutEvidenceOrder;
  scope: StripeScope;
}) {
  const { session, order, scope } = input;
  if (session.status !== 'open' || session.payment_status !== 'unpaid' || session.subscription
    || session.metadata?.orderId !== order.id || session.metadata?.userId !== order.user_id
    || session.client_reference_id !== order.user_id) throw new Error('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  assertPurchaseReceipt({ snapshot: order.purchase_snapshot, amount: session.amount_total,
    currency: session.currency, livemode: session.livemode, scope });
  if (session.payment_intent) await assertUnpaidIntent({ ...input, beforeExpiration: true });
  await input.stripe.checkout.sessions.expire(session.id);
}

// The caller supplies the original order and its mapped external session, never a browser's
// claim that checkout was canceled. Network failure leaves the original intent unresolved.
export async function closeExpiredStripeCheckout(input: {
  stripe: Pick<Stripe, 'checkout' | 'paymentIntents' | 'charges'>;
  supabase: EvidenceDb;
  order: CheckoutEvidenceOrder;
  mappedSessionId: string;
  scope: StripeScope;
}) {
  const { order, scope } = input;
  if (order.payment_channel !== 'stripe' || order.merchant_namespace !== scope.merchant
    || order.payment_mode !== scope.mode) throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  const session = await readClosureEvidence(input.stripe.checkout.sessions.retrieve(input.mappedSessionId));
  if (session.id !== input.mappedSessionId || session.object !== 'checkout.session'
    || session.client_reference_id !== order.user_id || session.metadata?.orderId !== order.id
    || session.metadata?.userId !== order.user_id || session.status !== 'expired'
    || session.payment_status !== 'unpaid' || session.subscription) {
    throw new Error('PAY_COMMON_ATTEMPT_NOT_TERMINAL');
  }
  const snapshot = assertPurchaseReceipt({ snapshot: order.purchase_snapshot, amount: session.amount_total,
    currency: session.currency, livemode: session.livemode, scope });
  if (session.mode !== (snapshot.item_type === 'membership_plan' ? 'subscription' : 'payment')) {
    throw new Error('PAY_COMMON_ATTEMPT_IDENTITY_MISMATCH');
  }
  if (session.payment_intent) await assertUnpaidIntent({ ...input, session });
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
