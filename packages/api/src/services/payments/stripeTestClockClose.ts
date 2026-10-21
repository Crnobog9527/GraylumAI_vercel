/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readCardPaymentEvidence, type CardOrder } from './cardPaymentEvidence';
import { observeStripeTestClock, readStripeTestClock, testClockCustomerForOrder, stripeTestClockRuntimeOpen, type TestClockOrder } from './stripeTestClock';
import type { StripeScope } from './purchaseFacts';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
const iso = (seconds: number | null | undefined) => {
  if (!Number.isSafeInteger(seconds) || (seconds as number) <= 0) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  return new Date((seconds as number) * 1000).toISOString();
};
type CloseOrder = TestClockOrder & CardOrder & { fulfilled_at?: string | null; subscription_id?: string | null };
/** The canceled, fully refunded first payment is closed without ever granting access. No synthetic unpaid fact. */
export async function closeRefundedTestClockCheckout(db: SupabaseClient, stripe: Stripe, scope: StripeScope,
  order: CloseOrder, sessionId: string, priceId: string) {
  const customerId = testClockCustomerForOrder(order, scope);
  if (!customerId || order.fulfilled_at || order.subscription_id) return false;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.status !== 'complete' || session.payment_status !== 'paid') return false;
  const subscriptionId = id(session.subscription);
  if (!subscriptionId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.status !== 'canceled') return false;
  // This also validates the frozen price, complete session ownership, first invoice, amount, currency and tax.
  const verifiedClock = await readStripeTestClock(stripe, customerId, order.user_id);
  const cash = await readCardPaymentEvidence({ stripe, scope, order, sessionId, priceId, testClock: verifiedClock });
  if (!cash?.subscription || cash.subscription.id !== subscriptionId || id(session.customer) !== customerId
    || id(subscription.customer) !== customerId || subscription.livemode !== false
    || subscription.metadata?.orderId !== order.id || subscription.metadata?.userId !== order.user_id) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  const invoice = await stripe.invoices.retrieve(cash.paymentId);
  if (id(invoice.customer) !== customerId || invoice.livemode !== false) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 100 });
  const payment = payments.data[0];
  if (payments.has_more || payments.data.length !== 1 || payment?.payment.type !== 'payment_intent'
    || id(payment.invoice) !== invoice.id || payment.livemode !== false || payment.object !== 'invoice_payment'
    || payment.status !== 'paid' || payment.amount_paid !== invoice.amount_paid || payment.currency !== cash.currency) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const intentId = id(payment.payment.payment_intent);
  if (!intentId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const intent = await stripe.paymentIntents.retrieve(intentId);
  const chargeId = id(intent.latest_charge);
  if (!chargeId || intent.id !== intentId || intent.object !== 'payment_intent' || intent.livemode !== false
    || intent.status !== 'succeeded' || id(intent.customer) !== customerId || intent.currency !== cash.currency
    || intent.amount_received !== invoice.amount_paid) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const charge = await stripe.charges.retrieve(chargeId);
  if (charge.refunded === false && charge.amount_refunded === 0) return false;
  if (charge.id !== chargeId || charge.object !== 'charge' || charge.livemode !== false || charge.status !== 'succeeded'
    || !charge.paid || !charge.captured || charge.disputed || id(charge.payment_intent) !== intentId
    || id(charge.customer) !== customerId || charge.currency !== cash.currency
    || charge.amount_captured !== invoice.amount_paid || !charge.refunded || charge.amount_refunded !== charge.amount_captured) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  const all: Stripe.Refund[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const rows = await stripe.refunds.list({ charge: chargeId, limit: 100, ...(after ? { starting_after: after } : {}) });
    if (!Array.isArray(rows.data) || typeof rows.has_more !== 'boolean') throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    all.push(...rows.data);
    if (!rows.has_more) break;
    if (!rows.data.length || page === 9) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    after = rows.data.at(-1)!.id;
  }
  if (!all.length || new Set(all.map(row => row.id)).size !== all.length
    || all.some(row => row.object !== 'refund' || row.status !== 'succeeded' || id(row.charge) !== chargeId
      || id(row.payment_intent) !== intentId || row.currency !== cash.currency || !Number.isSafeInteger(row.amount) || row.amount <= 0)
    || all.reduce((sum, row) => sum + row.amount, 0) !== charge.amount_captured) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const clock = await observeStripeTestClock(db, stripe, scope, order);
  if (!clock || clock.clockId !== verifiedClock.clockId || id(subscription.test_clock) !== clock.clockId || id(invoice.test_clock) !== clock.clockId) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  const result = await db.rpc('pay_stripe_test_clock_close_refunded', { p_facts: { order: order.id,
    checkout: sessionId, customer: customerId, clock: clock.clockId, merchant: scope.merchant,
    invoice: invoice.id, paymentIntent: intentId, charge: chargeId, subscription: subscriptionId,
    paidMinor: invoice.amount_paid, taxMinor: cash.tax, currency: cash.currency, paidAt: cash.paidAt,
    canceledAt: iso(subscription.canceled_at), refunds: all.map(row => ({ id: row.id, amount: row.amount, createdAt: iso(row.created) })) } });
  if (result.error || result.data?.state !== 'refunded' || result.data?.orderId !== order.id || result.data?.credits !== 0) {
    throw new Error('PAY_STRIPE_TEST_CLOCK_CLOSE_UNAVAILABLE', { cause: result.error });
  }
  return true;
}
/** Refund/cancellation may precede the first mapping. Read the original frozen Checkout, never invent a payment ref. */
export async function closeRefundedTestClockOrder(db: SupabaseClient, stripe: Stripe, scope: StripeScope, orderId: string) {
  if (!stripeTestClockRuntimeOpen() || scope.mode !== 'test') return false;
  const loaded = await db.from('payment_orders').select('*').eq('id', orderId).maybeSingle();
  if (loaded.error) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
  const order = loaded.data as CloseOrder | null;
  if (!order || !testClockCustomerForOrder(order, scope)) return false;
  const refs = await db.from('payment_provider_refs').select('object_type,external_id,id').eq('channel', 'stripe')
    .eq('merchant_namespace', scope.merchant).eq('mode', 'test').or(`order_id.eq.${order.id},id.eq.${loaded.data.price_ref_id}`);
  if (refs.error || !Array.isArray(refs.data)) throw new Error('PAY_STRIPE_TEST_CLOCK_UNAVAILABLE');
  const sessions = refs.data.filter(row => row.object_type === 'checkout');
  const prices = refs.data.filter(row => row.object_type === 'price' && row.id === loaded.data.price_ref_id);
  if (sessions.length !== 1 || prices.length !== 1) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  return closeRefundedTestClockCheckout(db, stripe, scope, order, sessions[0]!.external_id, prices[0]!.external_id);
}
