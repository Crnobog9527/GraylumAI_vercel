/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPackageRefundCash, readRecurringRefundCash } from './packageRefund';
import { disputeAllowsRefund } from './disputeRefundEligibility';
import type { MonthlyRefundTerms } from './monthlyRefundApproval';
import type { MonthlyRefundIntent, MonthlyRefundObservation } from './subscriptionRefundExecution';
import type { SubscriptionRefundStripe } from './subscriptionRefundPreview';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { isAbandonedRenewalInvoice } from './abandonedRenewalInvoice';

export type MonthlyStripe = SubscriptionRefundStripe & Pick<Stripe, 'subscriptions' | 'invoiceItems' | 'events'>;
export const objectId = (v: string | { id: string } | null | undefined) => typeof v === 'string' ? v : v?.id;
export function evidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('PAY_MONTHLY_PROVIDER_EVIDENCE');
}
export const stageKey = (intent: MonthlyRefundIntent, stage: string) => `pay-common:monthly-refund:${intent.id}:${stage}`;

async function all<T extends { id: string }>(read: (cursor?: string) => Promise<{ data: T[]; has_more: boolean }>) {
  const rows: T[] = [];
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await read(cursor);
    evidence(Array.isArray(result.data) && typeof result.has_more === 'boolean');
    for (const row of result.data) {
      evidence(row.id && !ids.has(row.id));
      ids.add(row.id); rows.push(row);
    }
    if (!result.has_more) return rows;
    evidence(result.data.length > 0);
    cursor = result.data.at(-1)!.id;
  }
  throw new Error('PAY_MONTHLY_PROVIDER_HISTORY_INCOMPLETE');
}

export function refundFact(refund: Stripe.Refund, terms: MonthlyRefundTerms, intentId: string) {
  evidence(refund.object === 'refund' && refund.id && refund.metadata?.orderId === terms.orderId
    && refund.metadata?.refundIntentId === intentId && refund.amount === terms.netMinor
    && refund.currency === terms.currency && objectId(refund.charge) === terms.chargeId
    && objectId(refund.payment_intent) === terms.paymentIntentId
    && ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'].includes(refund.status ?? ''));
  return { id: refund.id, intentId, orderId: terms.orderId, chargeId: terms.chargeId,
    paymentIntentId: terms.paymentIntentId, currency: terms.currency, amount: refund.amount,
    merchant: terms.merchant, mode: terms.mode,
    status: refund.status as MonthlyRefundObservation['refunds']['rows'][number]['status'] };
}

async function renewalOwnership(stripe: MonthlyStripe, intent: MonthlyRefundIntent, sub: Stripe.Subscription) {
  if (!intent.claimedAt) return 'original' as const;
  const rows = await all(cursor => stripe.events.list({ type: 'customer.subscription.updated',
    created: { gte: Math.floor(Date.parse(intent.claimedAt!) / 1000) }, limit: 100, starting_after: cursor }));
  const changes = rows.filter(row => {
    const target = row.data.object as Stripe.Subscription;
    return target.id === sub.id && row.data.previous_attributes
      && Object.hasOwn(row.data.previous_attributes, 'cancel_at_period_end');
  }).sort((a, b) => b.created - a.created);
  // Same-second competing transitions cannot establish ordering.
  if (changes.length > 1 && changes[0].created === changes[1].created) return 'unknown' as const;
  const latest = changes[0];
  if (!latest) return intent.terms.originalCancelAtPeriodEnd === sub.cancel_at_period_end ? 'original' as const : 'unknown' as const;
  const key = latest.request?.idempotency_key;
  const target = latest.data.object as Stripe.Subscription;
  if (latest.livemode !== (intent.terms.mode === 'live') || target.cancel_at_period_end !== sub.cancel_at_period_end
    || target.metadata?.graylum_monthly_refund_intent !== intent.id
    || sub.metadata?.graylum_monthly_refund_intent !== intent.id) return 'unknown' as const;
  if (key === stageKey(intent, sub.cancel_at_period_end ? 'stop_renewal' : 'restore_renewal')) return 'intent' as const;
  return 'unknown' as const;
}

/** Full original-channel read before each mutation; no current catalog or client evidence. */
export async function readMonthlyProvider(stripe: MonthlyStripe, intent: MonthlyRefundIntent, db?: Pick<SupabaseClient, 'from'>) {
  const t = intent.terms;
  // A card order (PAY-STRIPE-MP) was charged the pre-tax amount plus its tax.
  const charged = t.paidMinor + (t.taxMinor ?? 0);
  const scope = await resolveStripeScope(stripe);
  // R7 (0297): the frozen terms carry the order's mode; the connected account and every object must match it.
  evidence(scope.mode === t.mode && scope.merchant === t.merchant);
  const live = t.mode === 'live';
  const [sub, pi, charge] = await Promise.all([
    stripe.subscriptions.retrieve(t.providerSubscriptionId), stripe.paymentIntents.retrieve(t.paymentIntentId),
    stripe.charges.retrieve(t.chargeId),
  ]);
  evidence(sub.id === t.providerSubscriptionId && sub.livemode === live
    && pi.id === t.paymentIntentId && pi.livemode === live && pi.status === 'succeeded'
    && pi.amount_received === charged && pi.currency === t.currency && objectId(pi.latest_charge) === t.chargeId
    && charge.id === t.chargeId && charge.livemode === live && charge.paid && charge.captured
    && charge.amount === charged && charge.amount_captured === charged && charge.currency === t.currency
    && objectId(charge.payment_intent) === t.paymentIntentId && objectId(sub.customer)
    && objectId(charge.customer) === objectId(sub.customer) && objectId(pi.customer) === objectId(sub.customer));
  // An external refund (no metadata of this intent) that failed or was canceled moved no cash: it is not this intent's
  // evidence and must not block it. Any other foreign refund still fails the read (a conflict for review).
  const refunds = (await all(cursor => stripe.refunds.list({ charge: t.chargeId, limit: 100, starting_after: cursor })))
    .filter(row => row.metadata?.refundIntentId === intent.id || !['failed', 'canceled'].includes(row.status ?? ''));
  evidence(refunds.length <= 1);
  const rows = refunds.map(row => refundFact(row, t, intent.id));
  const item = sub.items.data[0];
  evidence(sub.items.has_more === false && sub.items.data.length === 1 && item
    && item.price.recurring?.usage_type === 'licensed'
    && item.price.recurring.interval === (t.snapshot.billing_cycle === 'yearly' ? 'year' : 'month')
    && item.price.recurring.interval_count === 1
    && item.quantity === 1 && new Date(item.current_period_end * 1000).toISOString() === new Date(t.periodEnd).toISOString());
  const customer = objectId(sub.customer)!;
  const [invoices, invoiceItems, ownership] = await Promise.all([
    all(cursor => stripe.invoices.list({ customer, limit: 100, starting_after: cursor })),
    all(cursor => stripe.invoiceItems.list({ customer, pending: true, limit: 100, starting_after: cursor })),
    renewalOwnership(stripe, intent, sub),
  ]);
  let priorValid = !t.priorPro;
  if (t.priorPro?.autoRenew) {
    evidence(t.priorPro.providerSubscriptionId);
    const prior = await stripe.subscriptions.retrieve(t.priorPro.providerSubscriptionId);
    const priorItem = prior.items.data[0];
    const priorInvoice = invoices.filter(row => row.id === t.priorPro!.invoiceId);
    priorValid = prior.id !== sub.id && prior.id === t.priorPro.providerSubscriptionId && prior.livemode === live
      && objectId(prior.customer) === customer && prior.items.has_more === false && prior.items.data.length === 1
      && Boolean(priorItem) && new Date(priorItem.current_period_end * 1000).toISOString()
        === new Date(t.priorPro.periodEnd).toISOString()
      && (prior.status === 'active' && prior.cancel_at_period_end || prior.status === 'canceled')
      && prior.schedule === null && prior.pending_update === null
      && priorInvoice.length === 1 && priorInvoice[0].status === 'paid' && priorInvoice[0].livemode === live
      && objectId(priorInvoice[0].parent?.subscription_details?.subscription) === prior.id;
    if (priorValid) {
      evidence(db);
      const cash = await readRecurringRefundCash(db, stripe, t.priorPro.orderId, priorInvoice[0]);
      priorValid = cash.currency === t.currency && Date.parse(cash.paidAt) < Date.parse(t.paidAt);
    }
  } else if (t.priorPro) {
    evidence(db && t.priorPro.providerSubscriptionId === null);
    const cash = await readPackageRefundCash(db, stripe, t.priorPro.orderId);
    priorValid = cash.paymentIntentId === t.priorPro.invoiceId && cash.currency === t.currency
      && Date.parse(cash.paidAt) < Date.parse(t.paidAt);
  }
  // Owner 2026-10-24 (A): the same rule as the quote; every invoice is still re-read here before any money moves.
  const abandoned = new Set<string>();
  for (const row of invoices) if (row.id !== t.invoiceId && await isAbandonedRenewalInvoice(stripe, row, live)) abandoned.add(row.id);
  const original = invoices.filter(row => row.id === t.invoiceId);
  const originalValid = original.length === 1 && original[0].livemode === live && original[0].status === 'paid'
    && original[0].amount_paid === charged && original[0].currency === t.currency
    && objectId(original[0].parent?.subscription_details?.subscription) === sub.id;
  const clear = originalValid && priorValid && invoices.every(row => row.livemode === live
    && (row.id === t.invoiceId || row.status === 'void' || row.status === 'uncollectible' || abandoned.has(row.id)
      || t.priorPro?.autoRenew && row.status === 'paid'
        && objectId(row.parent?.subscription_details?.subscription) === t.priorPro.providerSubscriptionId))
    && invoiceItems.length === 0 && sub.schedule === null && sub.pending_update === null
    && sub.pause_collection === null && sub.pending_setup_intent == null
    && sub.pending_invoice_item_interval == null && await disputeAllowsRefund(db, stripe, scope, t.orderId, charge)
    && charge.amount_refunded <= t.netMinor && sub.collection_method === 'charge_automatically'
    && (sub.cancel_at === null || sub.cancel_at === item.current_period_end);
  return { checkedAt: new Date().toISOString(), merchant: scope.merchant, mode: scope.mode,
    subscription: { id: sub.id, status: (sub.status === 'active' || sub.status === 'canceled' ? sub.status : 'unknown'),
      periodEnd: t.periodEnd, cancelAtPeriodEnd: sub.cancel_at_period_end,
      renewalOwnership: ownership, preflight: clear ? 'clear' as const : 'conflict' as const },
    refunds: { complete: true, rows },
  } satisfies Omit<MonthlyRefundObservation, 'local'>;
}
