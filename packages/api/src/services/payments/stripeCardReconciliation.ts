/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { findStripeReference } from './stripeReferences';
import { recoverMethodCheckout } from './walletWebhook';
import { handleCardSubscriptionInvoice } from './cardSubscriptionWebhook';
import { handleCardRefund } from './cardRefundWebhook';
import type { StripeScope } from './purchaseFacts';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86400;

export type StripeCardFinding = {
  kind: 'paid_not_delivered' | 'paid_in_review' | 'renewal_not_recorded' | 'refund_not_recorded' | 'tax_not_recorded'
    | 'repair_failed'
    | 'scan_incomplete' | 'scan_failed';
  object?: 'checkout' | 'invoice' | 'refund'; externalId?: string; orderId?: string; code?: string;
};
type Listed<T> = { data: T[]; has_more: boolean };
type Options = { expectedMode: StripeScope['mode']; now?: Date; days?: number; maxPages?: number; budgetMs?: number;
  alert?: () => void };

/** PAY-STRIPE-MP daily backstop (04:00 billing-reconcile, #847 2.5-5): if a webhook was lost, a paid card order could
 * stay undelivered with nothing noticing. Scans the last `days` of Stripe checkout sessions, paid renewal invoices and
 * refund events (so a refund that succeeds long after it was created is still seen), and repairs card orders
 * through the same idempotent handlers the webhook uses (first payment,
 * renewal, external refund). Whatever cannot be repaired, or an incomplete scan, is a finding for manual review.
 * The environment decides whether it runs and in which mode (staging: test keys; production: live keys, off until the
 * Owner approves it at launch). A key whose mode differs from the configured one is refused, never scanned. */
export async function reconcileStripeCardPayments(db: SupabaseClient, stripe: Stripe, options: Options) {
  const scope = await resolveStripeScope(stripe);
  if (scope.mode !== options.expectedMode) throw new Error('PAY_STRIPE_MP_RECONCILIATION_MODE_MISMATCH');
  const since = Math.floor((options.now ?? new Date()).getTime() / 1000) - (options.days ?? 7) * DAY;
  const maxPages = options.maxPages ?? 10;
  // Stay well inside the cron's 60-second limit (the other audits run alongside): stop and report an incomplete scan.
  const deadline = Date.now() + (options.budgetMs ?? 40_000);
  const findings: StripeCardFinding[] = [];
  let repaired = 0, checked = 0, complete = true, outOfTime = false;

  const scan = async <T extends { id: string }>(object: StripeCardFinding['object'],
    list: (after?: string) => Promise<Listed<T>>, visit: (row: T) => Promise<void>) => {
    let after: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      if (outOfTime) return;
      const rows = await list(after);
      for (const row of rows.data) {
        if (Date.now() > deadline) {
          complete = false; outOfTime = true;
          findings.push({ kind: 'scan_incomplete', object, code: 'TIME_BUDGET' });
          return;
        }
        checked++;
        try { await visit(row); } catch (error) {
          findings.push({ kind: 'repair_failed', object, externalId: row.id, code: errorCode(error) });
        }
      }
      if (!rows.has_more || !rows.data.length) return;
      after = rows.data[rows.data.length - 1]!.id;
    }
    complete = false;
    findings.push({ kind: 'scan_incomplete', object });
  };

  // 1. Paid checkout sessions of card orders that are not delivered: the first-payment recovery delivers them.
  await scan('checkout', after => stripe.checkout.sessions.list({ created: { gte: since }, status: 'complete', limit: 100,
    ...(after ? { starting_after: after } : {}) }), async session => {
    const orderId = session.metadata?.orderId;
    if (session.payment_status !== 'paid' || !orderId || !UUID.test(orderId)) return;
    const before = await cardOrder(db, orderId);
    // Delivered and its tax recorded: nothing to do. Delivered without the tax fact (the tax write failed after the
    // payment): replaying the idempotent recovery records it, so external refunds can be judged against the charge.
    if (!before || (before.fulfilled_at && hasTax(before))) return;
    if (before.fulfilled_at) {
      await recoverMethodCheckout(db, stripe, session.id, 'checkout.session.completed');
      if (hasTax(await cardOrder(db, orderId))) repaired++;
      else findings.push({ kind: 'tax_not_recorded', object: 'checkout', externalId: session.id, orderId });
      return;
    }
    if (before.method_review_reason) {
      findings.push({ kind: 'paid_in_review', object: 'checkout', externalId: session.id, orderId });
      return;
    }
    await recoverMethodCheckout(db, stripe, session.id, 'checkout.session.completed');
    const after = await cardOrder(db, orderId);
    if (after?.fulfilled_at) repaired++;
    else findings.push({ kind: after?.method_review_reason ? 'paid_in_review' : 'paid_not_delivered', object: 'checkout',
      externalId: session.id, orderId });
  });

  // 2. Paid renewal invoices of card subscriptions without a renewal order: the renewal handler records them.
  await scan('invoice', after => stripe.invoices.list({ created: { gte: since }, status: 'paid', limit: 100,
    ...(after ? { starting_after: after } : {}) }), async invoice => {
    if (invoice.billing_reason !== 'subscription_cycle' || !id(invoice.parent?.subscription_details?.subscription)) return;
    const known = await recordedOrder(db, scope, 'payment', invoice.id);
    if (known && hasTax(await cardOrder(db, known))) return;
    // Missing, or recorded without its tax fact: the renewal handler is idempotent and records both.
    if (!await handleCardSubscriptionInvoice(db, stripe, invoice.id, 'invoice.paid', undefined, options.alert)) return;
    const orderId = await recordedOrder(db, scope, 'payment', invoice.id);
    if (orderId && hasTax(await cardOrder(db, orderId))) repaired++;
    else findings.push({ kind: orderId ? 'tax_not_recorded' : 'renewal_not_recorded', object: 'invoice', externalId: invoice.id,
      ...(orderId ? { orderId } : {}) });
  });

  // 3. Refund events of the window, not refunds created in it: a refund can start pending and succeed much later
  //    (Stripe), and its status change is an event of the day it happened. The external-refund handler (#941)
  //    re-reads each refund and records it; recorded refunds are replayed too, which changes nothing and repeats a
  //    pending review alert (partial refund, refunded pack, still renewing) a crashed delivery never sent (dedupKey).
  const seen = new Set<string>();
  await scan('refund', after => stripe.events.list({ created: { gte: since }, limit: 100,
    types: ['refund.created', 'refund.updated', 'charge.refund.updated', 'charge.refunded'],
    ...(after ? { starting_after: after } : {}) }), async event => {
    const object = event.data.object as { id: string; object: string; metadata?: Record<string, string> | null };
    if (seen.has(object.id) || object.metadata?.refundIntentId) return;
    seen.add(object.id);
    if (object.object === 'charge') {
      await handleCardRefund(db, stripe, { chargeId: object.id }, options.alert);
      return;
    }
    const known = Boolean(await recordedOrder(db, scope, 'refund', object.id));
    if (!await handleCardRefund(db, stripe, { refundId: object.id }, options.alert)) return;
    if (known) return;
    if (await recordedOrder(db, scope, 'refund', object.id)) repaired++;
    else if ((await stripe.refunds.retrieve(object.id)).status === 'succeeded') {
      findings.push({ kind: 'refund_not_recorded', object: 'refund', externalId: object.id });
    }
  });

  return { success: findings.length === 0, skipped: false, complete, repaired, checked, findings };
}

async function cardOrder(db: SupabaseClient, orderId: string) {
  const result = await db.from('payment_orders')
    .select('payment_channel,payment_method,fulfilled_at,method_review_reason,payment_amount_facts')
    .eq('id', orderId).maybeSingle();
  if (result.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE', { cause: result.error });
  const order = result.data as { payment_channel: string; payment_method: string | null; fulfilled_at: string | null;
    method_review_reason: string | null; payment_amount_facts: Array<{ kind?: string }> | null } | null;
  return order?.payment_channel === 'stripe' && (order.payment_method === 'card' || order.payment_method === 'card_cn')
    ? order : null;
}

/** The order's tax fact (0237): written after every card payment, 0 without Managed Payments. */
function hasTax(order: { payment_amount_facts: Array<{ kind?: string }> | null } | null) {
  return Boolean(order?.payment_amount_facts?.some(fact => fact.kind === 'tax'));
}

async function recordedOrder(db: SupabaseClient, scope: StripeScope, objectType: 'payment' | 'refund', externalId: string) {
  return (await findStripeReference(db, objectType, externalId, scope))?.order_id ?? null;
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : 'UNEXPECTED';
}
