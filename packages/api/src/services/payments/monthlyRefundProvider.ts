/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { MonthlyRefundTerms } from './monthlyRefundApproval';
import type { MonthlyRefundIntent, MonthlyRefundObservation } from './subscriptionRefundExecution';
import type { SubscriptionRefundStripe } from './subscriptionRefundPreview';
import { resolveStripeScope } from './stripeCheckoutPersistence';

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
    merchant: terms.merchant, mode: 'test' as const,
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
  if (latest.livemode !== false || target.cancel_at_period_end !== sub.cancel_at_period_end
    || target.metadata?.graylum_monthly_refund_intent !== intent.id
    || sub.metadata?.graylum_monthly_refund_intent !== intent.id) return 'unknown' as const;
  if (key === stageKey(intent, sub.cancel_at_period_end ? 'stop_renewal' : 'restore_renewal')) return 'intent' as const;
  return 'unknown' as const;
}

/** Full original-channel read before each mutation; no current catalog or client evidence. */
export async function readMonthlyProvider(stripe: MonthlyStripe, intent: MonthlyRefundIntent) {
  const t = intent.terms;
  const scope = await resolveStripeScope(stripe);
  evidence(scope.mode === 'test' && scope.merchant === t.merchant);
  const [sub, pi, charge] = await Promise.all([
    stripe.subscriptions.retrieve(t.providerSubscriptionId), stripe.paymentIntents.retrieve(t.paymentIntentId),
    stripe.charges.retrieve(t.chargeId),
  ]);
  evidence(sub.id === t.providerSubscriptionId && sub.livemode === false
    && pi.id === t.paymentIntentId && pi.livemode === false && pi.status === 'succeeded'
    && pi.amount_received === t.paidMinor && pi.currency === t.currency && objectId(pi.latest_charge) === t.chargeId
    && charge.id === t.chargeId && charge.livemode === false && charge.paid && charge.captured
    && charge.amount === t.paidMinor && charge.amount_captured === t.paidMinor && charge.currency === t.currency
    && objectId(charge.payment_intent) === t.paymentIntentId && objectId(sub.customer)
    && objectId(charge.customer) === objectId(sub.customer) && objectId(pi.customer) === objectId(sub.customer));
  const refunds = await all(cursor => stripe.refunds.list({ charge: t.chargeId, limit: 100, starting_after: cursor }));
  evidence(refunds.length <= 1);
  const rows = refunds.map(row => refundFact(row, t, intent.id));
  const item = sub.items.data[0];
  evidence(sub.items.has_more === false && sub.items.data.length === 1 && item
    && item.price.recurring?.usage_type === 'licensed' && item.price.recurring.interval === 'month' && item.price.recurring.interval_count === 1
    && item.quantity === 1 && new Date(item.current_period_end * 1000).toISOString() === new Date(t.periodEnd).toISOString());
  const customer = objectId(sub.customer)!;
  const [invoices, invoiceItems, ownership] = await Promise.all([
    all(cursor => stripe.invoices.list({ customer, limit: 100, starting_after: cursor })),
    all(cursor => stripe.invoiceItems.list({ customer, pending: true, limit: 100, starting_after: cursor })),
    renewalOwnership(stripe, intent, sub),
  ]);
  const original = invoices.filter(row => row.id === t.invoiceId);
  const originalValid = original.length === 1 && original[0].livemode === false && original[0].status === 'paid'
    && original[0].amount_paid === t.paidMinor && original[0].currency === t.currency
    && objectId(original[0].parent?.subscription_details?.subscription) === sub.id;
  const clear = originalValid && invoices.every(row => row.livemode === false
    && (row.id === t.invoiceId || row.status === 'void' || row.status === 'uncollectible'))
    && invoiceItems.length === 0 && sub.schedule === null && sub.pending_update === null
    && sub.pause_collection === null && sub.pending_setup_intent == null
    && sub.pending_invoice_item_interval == null && charge.disputed === false
    && charge.amount_refunded <= t.netMinor && sub.collection_method === 'charge_automatically'
    && (sub.cancel_at === null || sub.cancel_at === item.current_period_end);
  return { checkedAt: new Date().toISOString(), merchant: scope.merchant, mode: 'test' as const,
    subscription: { id: sub.id, status: (sub.status === 'active' || sub.status === 'canceled' ? sub.status : 'unknown'),
      periodEnd: t.periodEnd, cancelAtPeriodEnd: sub.cancel_at_period_end,
      renewalOwnership: ownership, preflight: clear ? 'clear' as const : 'conflict' as const },
    refunds: { complete: true, rows },
  } satisfies Omit<MonthlyRefundObservation, 'local'>;
}
