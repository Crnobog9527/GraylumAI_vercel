/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { freezePurchaseSnapshot } from './contracts';
import { assertPurchaseReceipt, snapshotAmountDue, stripePreTaxAmount, type StripeScope } from './purchaseFacts';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
const iso = (seconds: number | null | undefined) => {
  if (!Number.isSafeInteger(seconds) || (seconds as number) <= 0) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  return new Date((seconds as number) * 1000).toISOString();
};

export type CardOrder = {
  id: string; user_id: string; purchase_snapshot: unknown; payment_method: 'card' | 'card_cn'; item_type: string;
  payment_channel: string; merchant_namespace: string; payment_mode: string; stripe_managed_payments: boolean | null;
};
export type CardPaymentEvidence = {
  paymentId: string; checkoutId: string; amount: number; tax: number; currency: string; paidAt: string;
  subscription: { id: string; start: string; end: string } | null;
};

/** Managed Payments tax is kept as its own fact on the order; the pre-tax amount grants the entitlement. */
export async function recordCardPaymentTax(db: Pick<SupabaseClient, 'rpc'>, merchant: string, orderId: string,
  evidence: Pick<CardPaymentEvidence, 'paymentId' | 'tax'>) {
  const recorded = await db.rpc('pay_stripe_mp_record_tax', { p_order: orderId, p_merchant: merchant,
    p_payment: evidence.paymentId, p_tax: evidence.tax });
  if (recorded.error) throw new Error('PAY_WAFFO_FULFILLMENT_UNAVAILABLE', { cause: recorded.error });
}

/** PAY-STRIPE-MP first payment of a card / card_cn order. Called with the original scoped client and a
 * server-loaded order, never browser or event payment facts. Amounts are pre-tax: Managed Payments adds
 * tax on top and reports it separately. Returns null while the Checkout Session is not paid. */
export async function readCardPaymentEvidence(input: {
  stripe: Pick<Stripe, 'checkout' | 'subscriptions' | 'invoices' | 'paymentIntents' | 'charges'>; scope: StripeScope;
  order: CardOrder; priceId: string; sessionId: string;
  onValidatedSession?: (session: Stripe.Checkout.Session) => void;
  testClock?: { customerId: string; clockId: string };
}): Promise<CardPaymentEvidence | null> {
  const { stripe, scope, order } = input;
  if (order.payment_channel !== 'stripe' || order.payment_mode !== scope.mode || order.merchant_namespace !== scope.merchant
    || order.stripe_managed_payments !== (order.payment_method === 'card')) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const snapshot = freezePurchaseSnapshot(order.purchase_snapshot);
  const membership = order.item_type === 'membership_plan';
  const session = await stripe.checkout.sessions.retrieve(input.sessionId);
  const managed = session.managed_payments?.enabled === true;
  if (session.object !== 'checkout.session' || session.id !== input.sessionId || session.livemode !== (scope.mode === 'live')
    || session.client_reference_id !== order.user_id || session.metadata?.userId !== order.user_id
    || session.metadata?.orderId !== order.id || session.mode !== (membership ? 'subscription' : 'payment')
    || (input.testClock && id(session.customer) !== input.testClock.customerId)
    || managed !== (order.payment_method === 'card')
    || (order.payment_method === 'card_cn' && (session.payment_method_types.length !== 1 || session.payment_method_types[0] !== 'card'))) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  const tax = session.total_details?.amount_tax;
  assertPurchaseReceipt({ snapshot, scope, amount: session.amount_total, tax, currency: session.currency, livemode: session.livemode });
  input.onValidatedSession?.(session);
  if (session.payment_status !== 'paid') return null;
  return membership ? readSubscriptionPayment(input, session, snapshotAmountDue(snapshot))
    : readOneTimePayment(input, session, tax);
}

async function readSubscriptionPayment(input: Parameters<typeof readCardPaymentEvidence>[0], session: Stripe.Checkout.Session,
  due: number): Promise<CardPaymentEvidence> {
  const { stripe, scope, order } = input;
  const subscriptionId = id(session.subscription), invoiceId = id(session.invoice);
  if (!subscriptionId || !invoiceId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const item = subscription.items?.data?.length === 1 ? subscription.items.data[0] : null;
  if (subscription.object !== 'subscription' || subscription.id !== subscriptionId
    || subscription.livemode !== (scope.mode === 'live')
    || subscription.metadata?.orderId !== order.id || subscription.metadata?.userId !== order.user_id
    || (input.testClock && id(subscription.test_clock) !== input.testClock.clockId)
    || id(subscription.customer) !== id(session.customer) || !item || item.price?.id !== input.priceId || item.quantity !== 1
    || (subscription.managed_payments?.enabled === true) !== (order.payment_method === 'card')) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  // The first invoice carries the money and the paid term. Its single line is immutable; the subscription item's
  // current period moves on renewal, so a late recovery must never take the term from the item.
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const taxes = (invoice.total_taxes ?? []).reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const line = invoice.lines?.data?.length === 1 && !invoice.lines.has_more ? invoice.lines.data[0] : null;
  if (invoice.object !== 'invoice' || invoice.id !== invoiceId || invoice.livemode !== (scope.mode === 'live')
    || (input.testClock && (id(invoice.test_clock) !== input.testClock.clockId || id(invoice.customer) !== input.testClock.customerId))
    || invoice.status !== 'paid'
    || invoice.billing_reason !== 'subscription_create' || invoice.currency !== 'usd' || invoice.amount_paid !== invoice.amount_due
    || id(invoice.parent?.subscription_details?.subscription) !== subscriptionId
    || !line || id(line.pricing?.price_details?.price) !== input.priceId || line.quantity !== 1
    || stripePreTaxAmount(freezePurchaseSnapshot(order.purchase_snapshot), invoice.amount_paid, taxes) !== due) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  return { paymentId: invoice.id, checkoutId: session.id, amount: due, tax: taxes, currency: invoice.currency,
    paidAt: iso(invoice.status_transitions?.paid_at),
    subscription: { id: subscriptionId, start: iso(line.period?.start), end: iso(line.period?.end) } };
}

async function readOneTimePayment(input: Parameters<typeof readCardPaymentEvidence>[0], session: Stripe.Checkout.Session,
  tax: number | null | undefined): Promise<CardPaymentEvidence> {
  const { stripe, scope, order } = input;
  const intentId = id(session.payment_intent);
  if (!intentId || order.payment_method !== 'card') throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const chargeId = id(intent.latest_charge);
  if (intent.object !== 'payment_intent' || intent.id !== intentId || intent.livemode !== (scope.mode === 'live')
    || intent.status !== 'succeeded' || !chargeId
    || intent.metadata?.orderId !== order.id || intent.metadata?.userId !== order.user_id
    || id(intent.customer) !== id(session.customer)) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const receipt = { snapshot: order.purchase_snapshot, scope, tax, currency: intent.currency, livemode: intent.livemode };
  assertPurchaseReceipt({ ...receipt, amount: intent.amount_received });
  const charge = await stripe.charges.retrieve(chargeId);
  if (charge.object !== 'charge' || charge.id !== chargeId || charge.livemode !== (scope.mode === 'live')
    || !charge.paid || !charge.captured
    || charge.status !== 'succeeded' || id(charge.payment_intent) !== intentId || charge.refunded || charge.amount_refunded !== 0
    || id(charge.customer) !== id(session.customer)) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  assertPurchaseReceipt({ ...receipt, amount: charge.amount_captured, currency: charge.currency, livemode: charge.livemode });
  return { paymentId: intentId, checkoutId: session.id, amount: snapshotAmountDue(freezePurchaseSnapshot(order.purchase_snapshot)),
    tax: tax ?? 0, currency: charge.currency, paidAt: iso(charge.created), subscription: null };
}
