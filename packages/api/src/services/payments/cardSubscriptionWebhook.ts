/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { recoverMethodCheckout } from './walletWebhook';
import { freezePurchaseSnapshot } from './contracts';
import { stripePreTaxAmount } from './purchaseFacts';
import { recordStripeInvoiceConflict } from './stripeConflictEvidence';
import { recordCardPaymentTax } from './cardPaymentEvidence';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';
import { logger } from '../../lib/logger';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
type CardSubscriptionOrder = { id: string; user_id: string; payment_method: string; purchase_snapshot?: unknown;
  localSubscriptionId: string | null };
const iso = (seconds: number | null | undefined) => {
  if (!Number.isSafeInteger(seconds) || (seconds as number) <= 0) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  return new Date((seconds as number) * 1000).toISOString();
};

/** The PAY-STRIPE-MP card order behind a Stripe subscription, or null for any other subscription (legacy
 * D17 subscriptions keep their own path). Decided from our mapping or the authenticated subscription's
 * metadata, never from event payload fields. */
async function findCardOrder(db: SupabaseClient, stripe: Stripe, scope: { merchant: string; mode: string },
  subscriptionId: string): Promise<CardSubscriptionOrder | null> {
  const ref = await db.from('payment_provider_refs').select('subscription_id').eq('channel', 'stripe')
    .eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).eq('object_type', 'subscription')
    .eq('external_id', subscriptionId).maybeSingle();
  if (ref.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  const query = db.from('payment_orders').select('id,user_id,payment_method,purchase_snapshot').in('payment_method', ['card', 'card_cn']);
  if (ref.data?.subscription_id) {
    const mapped = await query.eq('subscription_id', ref.data.subscription_id).eq('purchase_action', 'checkout')
      .order('created_at', { ascending: true }).limit(1).maybeSingle();
    if (mapped.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
    return mapped.data ? { ...mapped.data, localSubscriptionId: ref.data.subscription_id as string } : null;
  }
  // Not mapped yet: the first invoice can arrive before checkout completion is recorded.
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const orderId = subscription.metadata?.orderId;
  if (subscription.object !== 'subscription' || subscription.id !== subscriptionId || !orderId
    || !/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  const order = await query.eq('id', orderId).maybeSingle();
  if (order.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (order.data && order.data.user_id !== subscription.metadata?.userId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  return order.data ? { ...order.data, localSubscriptionId: null } : null;
}

/** The Checkout Session that created this order's subscription: our mapping first, else a scoped search. */
async function orderCheckoutSession(db: SupabaseClient, stripe: Stripe, scope: { merchant: string; mode: string },
  order: CardSubscriptionOrder, subscriptionId: string) {
  const ref = await db.from('payment_provider_refs').select('external_id').eq('order_id', order.id).eq('object_type', 'checkout')
    .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).maybeSingle();
  if (ref.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  if (ref.data?.external_id) return ref.data.external_id as string;
  const sessions = await stripe.checkout.sessions.list({ subscription: subscriptionId, limit: 10 });
  const matches = sessions.data.filter(session => session.metadata?.orderId === order.id);
  if (matches.length !== 1 || sessions.has_more) throw new Error('PAY_WAFFO_CHECKOUT_UNAVAILABLE');
  return matches[0]!.id;
}

/** "Stopped" means no further renewal: cancel_at_period_end, or a cancel_at exactly at the current paid-period end
 * (a later cancel_at still renews in between, so it is not a stop). */
function stripeStopState(subscription: Stripe.Subscription) {
  const item = subscription.items?.data?.length === 1 ? subscription.items.data[0] : null;
  const stopAtEnd = subscription.cancel_at_period_end === true
    || (subscription.cancel_at !== null && item !== null && subscription.cancel_at === item.current_period_end);
  return { stop: stopAtEnd, canceled: subscription.status === 'canceled' || subscription.status === 'incomplete_expired' };
}

async function readSubscription(stripe: Stripe, subscriptionId: string) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (subscription.object !== 'subscription' || subscription.id !== subscriptionId || subscription.livemode) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  return subscription;
}

async function syncState(db: SupabaseClient, merchant: string, localSubscriptionId: string, subscription: Stripe.Subscription) {
  const state = stripeStopState(subscription);
  const result = await db.rpc('pay_stripe_mp_sync_subscription', { p_subscription: localSubscriptionId, p_merchant: merchant,
    p_cancel_at_period_end: state.stop, p_canceled: state.canceled });
  if (result.error) throw new Error('PAY_STRIPE_MP_RENEWAL_UNAVAILABLE', { cause: result.error });
  return state;
}

/** A renewal kept for review (closed or erasing account, stopped credit release, canceled locally) must not charge
 * again: stop renewal at Stripe and confirm before acknowledging. A failure throws so Stripe retries the event; the
 * renewal is deduplicated by invoice, so the retry only repeats this stop. */
async function stopRenewalAfterReview(db: SupabaseClient, stripe: Stripe, merchant: string, localSubscriptionId: string,
  subscriptionId: string) {
  let subscription = await readSubscription(stripe, subscriptionId);
  if (!stripeStopState(subscription).stop && !stripeStopState(subscription).canceled) {
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    subscription = await readSubscription(stripe, subscriptionId);
  }
  const state = await syncState(db, merchant, localSubscriptionId, subscription);
  if (!state.stop && !state.canceled) throw new Error('PAY_STRIPE_MP_RENEWAL_STOP_UNCONFIRMED');
}

/** A paid renewal invoice: one line, the next period, pre-tax amount (Managed Payments adds tax on top). */
function renewalFacts(invoice: Stripe.Invoice, subscriptionId: string, snapshot: unknown) {
  const line = invoice.lines?.data?.length === 1 && !invoice.lines.has_more ? invoice.lines.data[0] : null;
  const taxes = (invoice.total_taxes ?? []).reduce((sum, row) => sum + (row.amount ?? 0), 0);
  if (invoice.livemode || invoice.status !== 'paid' || invoice.currency !== 'usd' || invoice.amount_paid !== invoice.amount_due
    || !line || id(invoice.parent?.subscription_details?.subscription) !== subscriptionId) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  return { amount: stripePreTaxAmount(freezePurchaseSnapshot(snapshot), invoice.amount_paid, taxes), tax: taxes,
    paidAt: iso(invoice.status_transitions?.paid_at), start: iso(line.period?.start), end: iso(line.period?.end) };
}

/** Invoice events of PAY-STRIPE-MP card subscriptions. Returns false for any other invoice.
 * - subscription_create: confirms the first payment through the same idempotent fulfillment as checkout
 *   completion, so the two events grant once in any order.
 * - subscription_cycle paid: one renewal per invoice at the frozen list price (both paid events dedupe).
 * - subscription_cycle failed: records the first failure time (founder 7-day deadline).
 * - anything else on a card subscription (e.g. subscription_update): recorded for manual review, never granted. */
export async function handleCardSubscriptionInvoice(db: SupabaseClient, stripe: Stripe, invoiceId: string, eventType: string,
  eventCreated?: number) {
  const scope = await resolveStripeScope(stripe);
  const invoice = await stripe.invoices.retrieve(invoiceId);
  if (invoice.object !== 'invoice' || invoice.id !== invoiceId) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const subscriptionId = id(invoice.parent?.subscription_details?.subscription);
  if (!subscriptionId) return false;
  const order = await findCardOrder(db, stripe, scope, subscriptionId);
  if (!order) return false;
  const paid = eventType === 'invoice.paid' || eventType === 'invoice.payment_succeeded';
  if (paid && invoice.billing_reason === 'subscription_create') {
    await recoverMethodCheckout(db, stripe, await orderCheckoutSession(db, stripe, scope, order, subscriptionId), eventType);
    return true;
  }
  if (invoice.billing_reason === 'subscription_cycle' && (paid || eventType === 'invoice.payment_failed')) {
    // A renewal can only follow a recorded first payment; until then Stripe retries.
    if (!order.localSubscriptionId) throw new Error('PAY_STRIPE_MP_FIRST_PAYMENT_PENDING');
    const target = { p_subscription: order.localSubscriptionId, p_merchant: scope.merchant, p_invoice: invoice.id };
    const facts = paid ? renewalFacts(invoice, subscriptionId, order.purchase_snapshot) : null;
    const result = facts
      ? await db.rpc('pay_stripe_mp_renew_subscription', { ...target, p_amount: facts.amount, p_currency: invoice.currency,
        p_paid: facts.paidAt, p_start: facts.start, p_end: facts.end })
      : await db.rpc('pay_stripe_mp_record_renewal_failure', { ...target, p_failed_at: iso(eventCreated) });
    if (result.error) throw new Error('PAY_STRIPE_MP_RENEWAL_UNAVAILABLE', { cause: result.error });
    // The renewal's Managed Payments tax is its own fact on the renewal order, as for the first payment.
    if (facts && typeof result.data?.orderId === 'string') {
      await recordCardPaymentTax(db, scope.merchant, result.data.orderId, { paymentId: invoice.id, tax: facts.tax });
    }
    if (paid && result.data?.state === 'review') {
      logger.error('billing', 'stripe_mp_renewal_review', { orderId: result.data.orderId, reason: 'unexpected_renewal' });
      await stopRenewalAfterReview(db, stripe, scope.merchant, order.localSubscriptionId, subscriptionId);
    }
    return true;
  }
  if (invoice.billing_reason === 'subscription_create' && eventType === 'invoice.payment_failed') return true;
  // Not a path we grant from (proration, manual invoice...): keep the evidence for a person to resolve.
  await recordStripeInvoiceConflict({ db, scope, invoiceId: invoice.id, sourceOrderId: order.id });
  logger.error('billing', 'stripe_mp_invoice_review', { orderId: order.id, billingReason: invoice.billing_reason, eventType });
  // Money taken without an entitlement: stop the subscription from charging again until a person resolves it.
  if (paid && (invoice.amount_paid ?? 0) > 0) {
    if (!order.localSubscriptionId) throw new Error('PAY_STRIPE_MP_FIRST_PAYMENT_PENDING');
    await stopRenewalAfterReview(db, stripe, scope.merchant, order.localSubscriptionId, subscriptionId);
  }
  return true;
}

/** customer.subscription.* of PAY-STRIPE-MP card subscriptions: copy only "stop at period end" (also set by the
 * buyer on Link) and the final cancellation (failed retries, Link, data deletion). Stripe's temporary past_due
 * is not copied, so the 24-hour renewal grace keeps working. Returns false for any other subscription. */
export async function handleCardSubscriptionState(db: SupabaseClient, stripe: Stripe, subscriptionId: string) {
  const scope = await resolveStripeScope(stripe);
  const order = await findCardOrder(db, stripe, scope, subscriptionId);
  if (!order) return false;
  const subscription = await readSubscription(stripe, subscriptionId);
  if (!order.localSubscriptionId) {
    // Before the first payment is recorded there is nothing local to update. A plain state needs nothing, but a stop
    // or cancellation must not be lost: refuse it so Stripe retries once the first payment has created the mapping.
    const state = stripeStopState(subscription);
    if (state.stop || state.canceled) throw new Error('PAY_STRIPE_MP_FIRST_PAYMENT_PENDING');
    return true;
  }
  await syncState(db, scope.merchant, order.localSubscriptionId, subscription);
  return true;
}
