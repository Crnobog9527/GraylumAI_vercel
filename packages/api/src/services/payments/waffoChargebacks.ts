/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DisputeAlert } from './disputes';
import type { WaffoChargeback } from './waffoTestOperationsClient';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;
type Provider = { merchant: string; mode: 'test' | 'live'; storeId: string;
  listChargebacks: (deadline?: number) => Promise<WaffoChargeback[]> };
type Saved = { id: string; freeze_state: string; source_review_required: boolean; alerted_at: string | null;
  evidence_due_by: string | null };
export type ChargebackFinding = { kind: 'chargeback_observed' | 'chargeback_amount_unknown' | 'chargeback_unmatched' | 'recovery_failed';
  paymentId?: string; orderId?: string; refundCandidate: false };
const CHUNK = 100;

/** Unknown, inconsistent or cross-currency amounts never become a made-up full-payment loss. */
export function chargebackCash(dispute: WaffoChargeback, currency: string, totalMinor: number) {
  let amount = /^[1-9][0-9]{0,8}$/.test(dispute.amount?.amount ?? '') ? Number(dispute.amount!.amount) : null;
  const disputed = /^[A-Z]{3}$/.test(dispute.amount?.currency ?? '') ? dispute.amount!.currency!.toLowerCase() : null;
  if (disputed === currency && amount !== null && amount > totalMinor) amount = null;
  return { amount, currency: disputed, unknown: amount === null || disputed === null || disputed !== currency };
}

async function rows(read: (part: string[]) => PromiseLike<{ data: unknown; error: unknown }>, values: string[]) {
  const out: Record<string, string | number | null>[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    const result = await read(values.slice(i, i + CHUNK));
    if (result.error || !Array.isArray(result.data)) throw new Error('PAY_WAFFO_RECONCILIATION_UNAVAILABLE');
    out.push(...result.data);
  }
  return out;
}

async function mark(db: Db, disputeId: string, values: Record<string, unknown>) {
  const result = await db.from('payment_disputes').update(values).eq('id', disputeId);
  if (result.error) throw new Error('PAY_DISPUTE_ACTION_RECORD_UNAVAILABLE');
}

/** Waffo sends no chargeback webhook, so this daily scan is how a chargeback reaches us (up to about a day late).
 * Every chargeback on our one-time payment takes the same reversible source hold as a Stripe dispute (0308 via 0335):
 * repeats are idempotent, an administrator withdraws the hold after a won case, and a lost case stays held for
 * CHARGEBACK. Each case is reported and alerted once, like Stripe's alerted_at. */
export async function holdWaffoChargebacks(db: Db, provider: Provider, deadline: number, alert?: DisputeAlert) {
  const findings: ChargebackFinding[] = [];
  const disputes = await provider.listChargebacks(deadline);
  if (disputes.some(d => d.storeId !== provider.storeId || d.testMode !== (provider.mode === 'test')
    || !/^[A-Za-z0-9_:-]{1,160}$/.test(d.id) || !Number.isFinite(Date.parse(d.createdAt)))) {
    throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  }
  const disputedPayments = new Set(disputes.flatMap(d => d.paymentId ? [d.paymentId] : []));
  const refs = await rows(part => db.from('payment_provider_refs').select('external_id,order_id').eq('channel', 'waffo')
    .eq('merchant_namespace', provider.merchant).eq('mode', provider.mode).eq('object_type', 'payment')
    .in('external_id', part), [...disputedPayments]);
  const orderOf = new Map(refs.map(r => [r.external_id as string, r.order_id as string]));
  const orders = new Map((await rows(part => db.from('payment_orders').select('id,currency,amount_total')
    .eq('payment_channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('payment_mode', provider.mode)
    .in('id', part), [...new Set(orderOf.values())])).map(o => [o.id as string, o]));
  for (const dispute of disputes) {
    if (Date.now() >= deadline) return { complete: false, findings, disputedPayments };
    const paymentId = dispute.paymentId ?? undefined;
    const orderId = paymentId ? orderOf.get(paymentId) : undefined;
    const order = orderId ? orders.get(orderId) : undefined;
    if (!paymentId || !order) {
      findings.push({ kind: 'chargeback_unmatched', paymentId, refundCandidate: false });
      continue;
    }
    const cash = chargebackCash(dispute, String(order.currency), Number(order.amount_total));
    const saved = await db.rpc('pay_failover_dispute_observed', { p_order: orderId, p_merchant: provider.merchant,
      p_mode: provider.mode, p_payment: paymentId, p_dispute: dispute.id, p_amount: cash.amount,
      p_currency: cash.currency, p_observed_at: dispute.createdAt });
    if (saved.error || !saved.data) {
      findings.push({ kind: 'recovery_failed', paymentId, orderId, refundCandidate: false });
      continue;
    }
    const row = saved.data as Saved;
    const dueBy = Number.isFinite(Date.parse(dispute.expiryDateTime ?? '')) ? new Date(dispute.expiryDateTime!).toISOString() : null;
    if (dueBy && Date.parse(row.evidence_due_by ?? '') !== Date.parse(dueBy)) await mark(db, row.id, { evidence_due_by: dueBy });
    if (row.alerted_at) continue;
    findings.push({ kind: cash.unknown || row.source_review_required ? 'chargeback_amount_unknown' : 'chargeback_observed',
      paymentId, orderId, refundCandidate: false });
    if (!alert) continue;
    const frozen = row.freeze_state === 'frozen';
    alert({ code: row.freeze_state === 'superseded' ? 'PAY_DISPUTE_REFUNDED_PAYMENT' : row.source_review_required
      ? 'PAY_DISPUTE_SOURCE_REVIEW' : frozen ? 'PAY_DISPUTE_PAYMENT_FROZEN' : 'PAY_DISPUTE_OPENED', disputeId: row.id, dueBy });
    const now = new Date().toISOString();
    await mark(db, row.id, { alerted_at: now, ...(frozen ? { freeze_alerted_at: now } : {}) });
  }
  return { complete: true, findings, disputedPayments };
}
