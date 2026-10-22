/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readPaymentFacts, type WaffoPayment, type WaffoTestPayments } from './waffoPayments';
import type { WaffoChargeback } from './waffoTestOperationsClient';
import { majorToCents } from './purchaseFacts';
import { deliverWaffoOneTime } from './waffoOneTimeDelivery';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;
type Provider = Pick<WaffoTestPayments, 'listPayments'> & Partial<Pick<WaffoTestPayments, 'readPayment' | 'storeId'>>
  & { merchant: string; mode: 'test' | 'live'; readChargebacks?: (paymentId: string, deadline?: number) => Promise<WaffoChargeback[]> };
export type WaffoFinding = {
  kind: 'paid_not_delivered' | 'paid_in_review' | 'offsite_refund_due' | 'refund_observed'
    | 'recovery_failed' | 'chargeback_observed' | 'chargeback_amount_unknown' | 'delivered_without_payment' | 'scan_incomplete' | 'receipt_unprocessed';
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

const settledRefundSchema = z.object({
  id: z.string(), payment_channel: z.literal('waffo'), merchant_namespace: z.string(), payment_mode: z.enum(['test', 'live']),
  amount_total: z.number().int().positive(), currency: z.literal('usd'), status: z.enum(['refunded', 'partially_refunded']),
  payment_status: z.enum(['refunded', 'partially_refunded']),
  refund_approval: z.object({ id: z.uuid(), orderId: z.string(), status: z.literal('succeeded'),
    currency: z.literal('usd'), netMinor: z.number().int().positive(), refundId: z.string().min(1), idempotencyKey: z.string(),
    cash: z.object({ paymentIntentId: z.string(), chargeId: z.string() }) }),
});
function locallySettledRefund(payment: WaffoPayment, value: unknown, provider: Provider, refundRefs: Set<string>) {
  const checked = settledRefundSchema.safeParse(value);
  if (!checked.success) return false;
  const order = checked.data, approval = order.refund_approval;
  const full = approval.netMinor === order.amount_total;
  try {
    return order.merchant_namespace === provider.merchant && order.payment_mode === provider.mode
      && approval.orderId === order.id && approval.cash.paymentIntentId === payment.id && approval.cash.chargeId === payment.id
      && approval.idempotencyKey === `pay-common:refund:${approval.id}`
      && approval.netMinor <= order.amount_total && payment.orderMerchantExternalId === order.id
      && order.status === (full ? 'refunded' : 'partially_refunded') && order.payment_status === order.status
      && payment.amount.currency === 'USD' && /^[1-9][0-9]{0,8}$/.test(payment.amount.amount)
      && Number(payment.amount.amount) === order.amount_total && payment.pspAmountDetails?.currency === 'USD'
      && majorToCents(payment.pspAmountDetails.amount) === order.amount_total
      && payment.refundedAmount?.currency === 'USD' && /^[1-9][0-9]{0,8}$/.test(payment.refundedAmount.amount)
      && Number(payment.refundedAmount.amount) === approval.netMinor && payment.isFullyRefunded === full
      && Boolean(payment.refundStatus) && payment.refundStatus !== 'none'
      && refundRefs.has(`${order.id}:${approval.refundId}`);
  } catch { return false; }
}

const refundedSourceSchema = z.object({ id: z.uuid(), payment_channel: z.literal('waffo'), payment_mode: z.enum(['test', 'live']),
  merchant_namespace: z.string(), mode: z.literal('payment'), auto_renew: z.literal(false),
  qualified_paid_at: z.string().datetime({ offset: true }), amount_total: z.number().int().positive(), currency: z.string().regex(/^[a-z]{3}$/) });
/** Refunding does not erase the original payment's dispute lifecycle. Observe only: never fulfill or refund again. */
async function observeRefundedChargebacks(db: Db, provider: Provider, payment: WaffoPayment, value: unknown, deadline: number) {
  const source = refundedSourceSchema.safeParse(value);
  if (!source.success || !provider.storeId || !provider.readChargebacks
    || source.data.payment_mode !== provider.mode || source.data.merchant_namespace !== provider.merchant) {
    throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  }
  const order = source.data;
  const disputes = await provider.readChargebacks(payment.id, deadline);
  if (disputes.some(d => d.paymentId !== payment.id || d.storeId !== provider.storeId || d.testMode !== (provider.mode === 'test')
    || !/^[A-Za-z0-9_:-]{1,160}$/.test(d.id) || !Number.isFinite(Date.parse(d.createdAt)))) {
    throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  }
  let unknown = false;
  for (const dispute of disputes) {
    let amount = /^[1-9][0-9]{0,8}$/.test(dispute.amount?.amount ?? '') ? Number(dispute.amount!.amount) : null;
    const currency = /^[A-Z]{3}$/.test(dispute.amount?.currency ?? '') ? dispute.amount!.currency!.toLowerCase() : null;
    if (currency === order.currency && amount !== null && amount > order.amount_total) amount = null;
    unknown ||= amount === null || currency === null || currency !== order.currency;
    const result = await db.rpc('pay_failover_dispute_observed', { p_order: order.id, p_merchant: provider.merchant,
      p_mode: provider.mode, p_payment: payment.id, p_dispute: dispute.id, p_amount: amount,
      p_currency: currency, p_observed_at: dispute.createdAt });
    if (result.error) throw new Error('PAY_WAFFO_DISPUTE_UNAVAILABLE');
  }
  return disputes.length ? unknown ? 'chargeback_amount_unknown' as const : 'chargeback_observed' as const : null;
}

/** Daily backstop for the narrowed scope: compare Waffo's paid records with what we delivered and
 * report differences for manual handling. It never grants, refunds or cancels anything. */
export async function reconcileWaffoPayments(db: Db, provider: Provider, options?: {
  recover?: boolean; deadline?: number; afterFulfillment?: (orderId: string) => Promise<unknown>;
}) {
  const deadline = options?.deadline ?? Date.now() + 45_000;
  const findings: WaffoFinding[] = [];
  const scanned: WaffoPayment[] = [];
  let complete = false;
  for (let page = 0; page < MAX_PAGES && !complete; page++) {
    if (Date.now() >= deadline) break;
    try {
      const result = await provider.listPayments(page * CHUNK);
      scanned.push(...result.rows);
      complete = result.complete;
    } catch { break; }
  }
  if (!complete) findings.push({ kind: 'scan_incomplete', refundCandidate: false });
  const paid = scanned.filter(p => p.status === 'succeeded' && p.testMode === (provider.mode === 'test'));
  if (options?.recover) {
    if (!provider.readPayment || !provider.storeId) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
    const ids = paid.filter(p => p.onetimeOrder).map(p => p.orderMerchantExternalId)
      .filter((id): id is string => z.uuid().safeParse(id).success);
    const own = new Set((await chunked([...new Set(ids)], part => db.from('payment_orders').select('id')
      .eq('payment_channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('payment_mode', provider.mode).in('id', part)))
      .map(row => row.id));
    for (const candidate of paid.filter(p => p.onetimeOrder && own.has(p.orderMerchantExternalId))) {
      if (Date.now() >= deadline) {
        complete = false;
        if (!findings.some(f => f.kind === 'scan_incomplete')) findings.push({ kind: 'scan_incomplete', refundCandidate: false });
        break;
      }
      try {
        // Each candidate is isolated: one failed lookup must not starve other original orders.
        const current = await provider.readPayment(candidate.id);
        if (!current) throw new Error('PAY_WAFFO_PAYMENT_NOT_VISIBLE');
        const reading = readPaymentFacts(current, provider.storeId, provider.mode);
        if (reading.kind !== 'paid' || reading.facts.purchaseMode !== 'payment') continue;
        const result = await deliverWaffoOneTime(db, provider, reading.facts, deadline);
        if (result.reason === 'chargeback_observed' || result.reason === 'chargeback_amount_unknown') {
          findings.push({ kind: result.reason, paymentId: candidate.id,
            orderId: reading.facts.externalId ?? undefined, refundCandidate: false });
        }
        if (result.state === 'applied' && reading.facts.externalId && options.afterFulfillment) {
          await options.afterFulfillment(reading.facts.externalId);
        }
      } catch { findings.push({ kind: 'recovery_failed', paymentId: candidate.id, refundCandidate: false }); }
    }
  }
  if (Date.now() >= deadline) {
    complete = false;
    if (!findings.some(f => f.kind === 'scan_incomplete')) findings.push({ kind: 'scan_incomplete', refundCandidate: false });
  }
  const paymentRefs = () => db.from('payment_provider_refs').select('external_id,order_id').eq('channel', 'waffo')
    .eq('merchant_namespace', provider.merchant).eq('mode', provider.mode).eq('object_type', 'payment');
  const refs = await chunked(paid.map(p => p.id), part => paymentRefs().in('external_id', part));
  const orderOf = new Map(refs.map(r => [r.external_id!, r.order_id!]));
  const readOrders = (ids: string[]) => chunked(ids, part => db.from('payment_orders')
    .select('id,fulfilled_at,qualification_state,method_review_reason,payment_channel,merchant_namespace,payment_mode,'
      + 'amount_total,currency,status,payment_status,refund_approval,mode,auto_renew,qualified_paid_at').in('id', part));
  const orderById = new Map((await readOrders([...new Set(orderOf.values())])).map(o => [o.id!, o]));
  const refundIds = [...orderById.values()].flatMap(order => {
    const checked = settledRefundSchema.safeParse(order);
    return checked.success ? [checked.data.refund_approval.refundId] : [];
  });
  const settledRefundRefs = new Set((await chunked([...new Set(refundIds)], part => db.from('payment_provider_refs')
    .select('external_id,order_id').eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', provider.mode)
    .eq('object_type', 'refund').in('external_id', part))).map(ref => `${ref.order_id}:${ref.external_id}`));
  const offsite = await db.from('waffo_event_receipts').select('resolution').eq('merchant_namespace', provider.merchant)
    .eq('mode', provider.mode).eq('resolution->>kind', 'offsite');
  if (offsite.error) throw new Error('PAY_WAFFO_RECONCILIATION_UNAVAILABLE');
  const offsitePaid = new Set((offsite.data ?? []).map(r => (r.resolution as { cash?: { paymentId?: string } } | null)?.cash?.paymentId));
  // A payment whose site order id is not ours is offsite even if its webhook never arrived.
  // Only real UUIDs reach the uuid column, and only orders of this Waffo card binding count as ours.
  const unmatched = paid.filter(p => !orderOf.has(p.id) && !offsitePaid.has(p.id)).map(p => p.orderMerchantExternalId)
    .filter((value): value is string => z.uuid().safeParse(value).success);
  const siteOrders = new Map((await chunked([...new Set(unmatched)], part => db.from('payment_orders')
    .select('id,qualification_state,method_review_reason,fulfilled_at').eq('payment_channel', 'waffo')
    .eq('merchant_namespace', provider.merchant).eq('payment_mode', provider.mode).in('id', part))).map(o => [o.id!, o]));
  for (const payment of paid) {
    const orderId = orderOf.get(payment.id);
    const order = orderId ? orderById.get(orderId) : undefined;
    if (refunded(payment)) {
      if (options?.recover && order) {
        if (Date.now() >= deadline) {
          complete = false;
          if (!findings.some(f => f.kind === 'scan_incomplete')) findings.push({ kind: 'scan_incomplete', refundCandidate: false });
        } else {
          try {
            const kind = await observeRefundedChargebacks(db, provider, payment, order, deadline);
            if (kind) findings.push({ kind, paymentId: payment.id, orderId, refundCandidate: false });
          } catch { findings.push({ kind: 'recovery_failed', paymentId: payment.id, orderId, refundCandidate: false }); }
        }
      }
      if (!locallySettledRefund(payment, order, provider, settledRefundRefs)) {
        findings.push({ kind: 'refund_observed', paymentId: payment.id, orderId, refundCandidate: false });
      }
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
      // The order was already delivered by another payment: a second FIRST payment (Waffo checkout has no
      // idempotency). A renewal carries the same order id and stays on the undelivered path below.
      if (site.fulfilled_at && (payment.onetimeOrder || payment.periodNumber === 1)) {
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
    .eq('mode', provider.mode).in('event_type', ['subscription.payment_succeeded', 'onetime.payment_succeeded', 'payment.succeeded']).eq('status', 'received')
    .lt('received_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()).limit(100);
  if (stale.error) throw new Error('PAY_WAFFO_RECONCILIATION_UNAVAILABLE');
  for (const row of (stale.data ?? []) as Row[]) {
    findings.push({ kind: 'receipt_unprocessed', receiptId: row.id!, refundCandidate: false });
  }
  if (complete && Date.now() < deadline) {
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
