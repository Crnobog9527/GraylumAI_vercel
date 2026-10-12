/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { WaffoPayment, WaffoTestPayments } from './waffoPayments';

type Db = Pick<SupabaseClient, 'from'>;
type Provider = Pick<WaffoTestPayments, 'listPayments'> & { merchant: string; mode: 'test' };
export type WaffoFinding = {
  kind: 'paid_not_delivered' | 'paid_in_review' | 'offsite_refund_due' | 'refund_observed'
    | 'delivered_without_payment' | 'scan_incomplete' | 'receipt_unprocessed';
  paymentId?: string; orderId?: string; reason?: string; receiptId?: string;
  /** Marks a payment a person should consider refunding; nothing is refunded automatically. */
  refundCandidate: boolean;
  /** Undelivered cash whose Waffo subscription still renews: its renewal must be stopped by hand. */
  renewalActive?: boolean;
};
// Same set the cancel flow retries (cancelWaffoMembership): pending can still charge.
const RENEWING = ['active', 'trialing', 'past_due', 'pending'];
const MAX_PAGES = 20;
const CHUNK = 100;

type Row = Record<string, string | null>;
async function chunked(values: string[], read: (part: string[]) => PromiseLike<{ data: unknown; error: unknown }>) {
  const rows: Row[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    const result = await read(values.slice(i, i + CHUNK));
    if (result.error) throw new Error('PAY_WAFFO_RECONCILIATION_UNAVAILABLE');
    rows.push(...(result.data as Row[]));
  }
  return rows;
}

const refunded = (p: WaffoPayment) => p.refundStatus !== 'none' || p.isFullyRefunded !== false || p.refundedAmount?.amount !== '0';

/** Daily backstop for the narrowed scope: compare Waffo's paid records with what we delivered and
 * report differences for manual handling. It never grants, refunds or cancels anything. */
export async function reconcileWaffoPayments(db: Db, provider: Provider) {
  if (provider.mode !== 'test') throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  const scanned: WaffoPayment[] = [];
  let complete = false;
  for (let page = 0; page < MAX_PAGES && !complete; page++) {
    const result = await provider.listPayments(page * CHUNK);
    scanned.push(...result.rows);
    complete = result.complete;
  }
  const findings: WaffoFinding[] = complete ? [] : [{ kind: 'scan_incomplete', refundCandidate: false }];
  const paid = scanned.filter(p => p.status === 'succeeded' && p.testMode);
  const paymentRefs = () => db.from('payment_provider_refs').select('external_id,order_id').eq('channel', 'waffo')
    .eq('merchant_namespace', provider.merchant).eq('mode', 'test').eq('object_type', 'payment');
  const refs = await chunked(paid.map(p => p.id), part => paymentRefs().in('external_id', part));
  const orderOf = new Map(refs.map(r => [r.external_id!, r.order_id!]));
  const readOrders = (ids: string[]) => chunked(ids, part => db.from('payment_orders')
    .select('id,fulfilled_at,qualification_state,method_review_reason').in('id', part));
  const orderById = new Map((await readOrders([...new Set(orderOf.values())])).map(o => [o.id!, o]));
  const offsite = await db.from('waffo_event_receipts').select('resolution').eq('merchant_namespace', provider.merchant)
    .eq('mode', 'test').eq('resolution->>kind', 'offsite');
  if (offsite.error) throw new Error('PAY_WAFFO_RECONCILIATION_UNAVAILABLE');
  const offsitePaid = new Set((offsite.data ?? []).map(r => (r.resolution as { cash?: { paymentId?: string } } | null)?.cash?.paymentId));
  // A payment whose site order id is not ours is offsite even if its webhook never arrived.
  // Only real UUIDs reach the uuid column, and only orders of this Waffo card binding count as ours.
  const unmatched = paid.filter(p => !orderOf.has(p.id) && !offsitePaid.has(p.id)).map(p => p.orderMerchantExternalId)
    .filter((value): value is string => z.uuid().safeParse(value).success);
  const siteOrders = new Map((await chunked([...new Set(unmatched)], part => db.from('payment_orders')
    .select('id,qualification_state,method_review_reason,fulfilled_at').eq('payment_channel', 'waffo').eq('payment_method', 'card')
    .eq('merchant_namespace', provider.merchant).eq('payment_mode', 'test').in('id', part))).map(o => [o.id!, o]));
  for (const payment of paid) {
    const orderId = orderOf.get(payment.id);
    const order = orderId ? orderById.get(orderId) : undefined;
    if (refunded(payment)) {
      if (order) findings.push({ kind: 'refund_observed', paymentId: payment.id, orderId, refundCandidate: false });
      continue;
    }
    if (order?.fulfilled_at) continue;
    if (order) {
      findings.push({ kind: 'paid_in_review', paymentId: payment.id, orderId, reason: order.method_review_reason ?? order.qualification_state ?? undefined,
        // A cancelled-then-renewed charge, a closed account or a late payment after release all need a refund decision.
        refundCandidate: Boolean(order.method_review_reason) || ['review', 'released'].includes(order.qualification_state ?? '') });
    } else if (offsitePaid.has(payment.id) || !siteOrders.has(payment.orderMerchantExternalId ?? '')) {
      findings.push({ kind: 'offsite_refund_due', paymentId: payment.id, refundCandidate: true });
    } else {
      // Its webhook never applied. A site order already released (e.g. after the 40-minute timeout) or under
      // review means this is late cash: refund candidate. Otherwise it is an ordinary undelivered payment.
      const site = siteOrders.get(payment.orderMerchantExternalId!)!;
      // The order was already delivered by another payment: a second first payment (Waffo checkout has no idempotency).
      if (site.fulfilled_at) {
        findings.push({ kind: 'paid_in_review', paymentId: payment.id, orderId: site.id!, reason: 'duplicate_order_payment', refundCandidate: true });
        continue;
      }
      const late = site.qualification_state === 'released' || site.qualification_state === 'review' || Boolean(site.method_review_reason);
      findings.push(late
        ? { kind: 'paid_in_review', paymentId: payment.id, orderId: site.id!,
          reason: site.method_review_reason ?? site.qualification_state ?? undefined, refundCandidate: true }
        : { kind: 'paid_not_delivered', paymentId: payment.id, refundCandidate: false });
    }
  }
  // Delivery stops these renewals automatically; anything still renewing here is the manual backstop.
  for (const finding of findings) {
    const undelivered = finding.refundCandidate || finding.kind === 'paid_not_delivered';
    const status = undelivered ? paid.find(p => p.id === finding.paymentId)?.subscriptionOrder?.status : undefined;
    if (status && RENEWING.includes(status)) finding.renewalActive = true;
  }
  // Waffo stops after 5 failed deliveries and cannot resend. A payment-success receipt still unprocessed after
  // a day means its webhook gave up (or processing is off); its payment is also listed above. Lifecycle events
  // (past_due, recovered, ...) are deliberately never resolved and are not counted.
  const stale = await db.from('waffo_event_receipts').select('id').eq('merchant_namespace', provider.merchant)
    .eq('mode', 'test').eq('event_type', 'subscription.payment_succeeded').eq('status', 'received')
    .lt('received_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()).limit(100);
  if (stale.error) throw new Error('PAY_WAFFO_RECONCILIATION_UNAVAILABLE');
  for (const row of (stale.data ?? []) as Row[]) {
    findings.push({ kind: 'receipt_unprocessed', receiptId: row.id!, refundCandidate: false });
  }
  if (complete) {
    const paidIds = new Set(paid.filter(p => !refunded(p)).map(p => p.id));
    const all = await paymentRefs();
    if (all.error) throw new Error('PAY_WAFFO_RECONCILIATION_UNAVAILABLE');
    const allRefs = (all.data ?? []) as Row[];
    const fulfilled = new Set((await readOrders([...new Set(allRefs.map(r => r.order_id!))]))
      .filter(o => o.fulfilled_at).map(o => o.id));
    for (const row of allRefs) {
      if (fulfilled.has(row.order_id) && !paidIds.has(row.external_id!) && !scanned.some(p => p.id === row.external_id && refunded(p))) {
        findings.push({ kind: 'delivered_without_payment', paymentId: row.external_id!, orderId: row.order_id!, refundCandidate: false });
      }
    }
  }
  return { success: findings.length === 0, checkedPayments: paid.length, complete, findings };
}
