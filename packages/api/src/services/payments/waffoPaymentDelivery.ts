/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readPaymentFacts, type PaymentFacts, type WaffoTestPayments } from './waffoPayments';
import type { WaffoTestOperations } from './waffoOperations';
import { describeWaffoFailure } from './waffoFailure';
import { logger } from '../../lib/logger';

type Db = Pick<SupabaseClient, 'rpc' | 'from'>;
type Provider = WaffoTestPayments & Pick<WaffoTestOperations, 'cancelSubscription' | 'readSubscription'>
  & { merchant: string; mode: 'test' };
export type WaffoReceipt = { id: string; merchant: string; refs: { paymentId?: string; orderId?: string; subscriptionId?: string } };
export type ReceiptOutcome = { state: 'applied' | 'review' | 'ignored'; reason: string };

const BUSINESS = /\b(PAY_WAFFO_[A-Z_]{1,50})\b/;
/** Transient failures throw so the provider can redeliver; business rejections become review. */
class Transient extends Error {}

async function resolve(db: Db, receipt: WaffoReceipt, state: 'applied' | 'review', reason: string): Promise<ReceiptOutcome> {
  const saved = await db.rpc('pay_waffo_resolve_receipt', { p_id: receipt.id, p_merchant: receipt.merchant, p_state: state, p_reason: reason });
  if (saved.error) throw new Transient('PAY_WAFFO_RECEIPT_UNAVAILABLE');
  return { state, reason };
}

async function apply(db: Db, receipt: WaffoReceipt, fn: string, args: Record<string, unknown>): Promise<ReceiptOutcome> {
  const result = await db.rpc(fn, args);
  if (result.error) {
    const code = BUSINESS.exec(result.error.message ?? '')?.[1];
    if (!code) throw new Transient('PAY_WAFFO_DELIVERY_UNAVAILABLE');
    return resolve(db, receipt, 'review', code.toLowerCase());
  }
  const state = result.data?.state;
  if (state === 'fulfilled') return resolve(db, receipt, 'applied', 'delivered');
  const reason = typeof result.data?.reason === 'string' && /^[a-z_]{1,64}$/.test(result.data.reason) ? result.data.reason : 'review';
  return resolve(db, receipt, 'review', reason);
}

async function single(query: PromiseLike<{ data: unknown; error: unknown }>) {
  const result = await query;
  if (result.error) throw new Transient('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  return result.data as Record<string, string> | null;
}

async function firstPayment(db: Db, provider: Provider, receipt: WaffoReceipt, facts: PaymentFacts) {
  if (!facts.externalId || !z.uuid().safeParse(facts.externalId).success) return null;
  const order = await single(db.from('payment_orders').select('id').eq('id', facts.externalId).eq('payment_channel', 'waffo')
    .eq('payment_method', 'card').eq('merchant_namespace', provider.merchant).eq('payment_mode', 'test').maybeSingle());
  if (!order) return null;
  const checkout = await single(db.from('payment_provider_refs').select('external_id').eq('order_id', order.id)
    .eq('object_type', 'checkout').eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle());
  if (!checkout) return resolve(db, receipt, 'review', 'checkout_unmapped');
  return apply(db, receipt, 'pay_waffo_fulfill_payment', {
    p_order: order.id, p_merchant: provider.merchant, p_checkout: checkout.external_id, p_payment: facts.paymentId,
    p_amount: facts.amountCents, p_currency: facts.currency, p_paid_at: facts.createdAt, p_subscription: facts.waffoOrderId,
    p_start: facts.periodStart, p_end: facts.periodEnd,
  });
}

async function renewal(db: Db, provider: Provider, receipt: WaffoReceipt, facts: PaymentFacts) {
  const ref = await single(db.from('payment_provider_refs').select('subscription_id').eq('object_type', 'subscription')
    .eq('external_id', facts.waffoOrderId).eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle());
  if (!ref?.subscription_id) return null;
  // Amount authority is the database's recorded order price (49 then 69, founder 496), not the catalog.
  return apply(db, receipt, 'pay_waffo_renew_subscription', {
    p_subscription: ref.subscription_id, p_merchant: provider.merchant, p_payment: facts.paymentId, p_amount: facts.amountCents,
    p_currency: facts.currency, p_paid: facts.createdAt, p_start: facts.periodStart, p_end: facts.periodEnd,
  });
}

async function offsite(db: Db, provider: Provider, receipt: WaffoReceipt, facts: PaymentFacts): Promise<ReceiptOutcome> {
  if (!facts.productId) return resolve(db, receipt, 'review', 'offsite_unproven');
  const result = await db.rpc('pay_waffo_record_offsite', { p_receipt: receipt.id, p_merchant: provider.merchant, p_cash: {
    paymentId: facts.paymentId, subscriptionId: facts.waffoOrderId, productId: facts.productId,
    amount: String(facts.amountCents), currency: facts.currency, paidAt: facts.createdAt } });
  if (result.error) {
    const code = BUSINESS.exec(result.error.message ?? '')?.[1];
    if (!code) throw new Transient('PAY_WAFFO_DELIVERY_UNAVAILABLE');
    return resolve(db, receipt, 'review', code.toLowerCase());
  }
  // The offsite transaction itself marks the receipt for refund and renewal stop; nothing is granted.
  return { state: 'review', reason: 'offsite' };
}

const STOPPED = ['canceling', 'canceled'];
/** Cash we did not deliver (late after the 40-minute release, closed account, offsite, unprovable facts)
 * leaves a Waffo subscription with no site subscription behind it, so the next period would be charged
 * with nothing delivered. Stop its renewal now and confirm by reading it back; the payment itself stays
 * with manual refund handling. A failure is logged and the daily reconciliation keeps reporting it. */
async function stopUnmappedRenewal(provider: Provider, waffoOrderId: string) {
  try {
    let observed = await provider.cancelSubscription(waffoOrderId);
    if (observed.orderId === waffoOrderId && !STOPPED.includes(observed.status)) observed = await provider.readSubscription(waffoOrderId);
    if (observed.orderId === waffoOrderId && STOPPED.includes(observed.status)) return;
    logger.error('billing', 'pay_waffo_renewal_stop_unconfirmed', { waffoOrderId, status: observed.status });
  } catch (error) {
    logger.error('billing', 'pay_waffo_renewal_stop_failed', { waffoOrderId, ...describeWaffoFailure(error) });
  }
}

/** Normal path only: first payment and renewal of our own card orders. Every other situation is left
 * as review for the daily reconciliation and manual handling; nothing is inferred or retried here. */
export async function processWaffoReceipt(db: Db, provider: Provider, receipt: WaffoReceipt): Promise<ReceiptOutcome> {
  if (provider.mode !== 'test' || provider.merchant !== receipt.merchant) throw new Error('PAY_WAFFO_OPERATION_SCOPE');
  const paymentId = receipt.refs.paymentId;
  if (!paymentId) return { state: 'ignored', reason: 'no_payment' };
  const current = await single(db.from('waffo_event_receipts').select('status').eq('id', receipt.id)
    .eq('merchant_namespace', receipt.merchant).eq('mode', 'test').maybeSingle());
  if (current?.status !== 'received') return { state: 'ignored', reason: 'already_resolved' };
  let payment;
  try { payment = await provider.readPayment(paymentId); } catch (error) {
    if (error instanceof z.ZodError) return resolve(db, receipt, 'review', 'payment_shape_unknown');
    throw error;
  }
  // Read-after-write visibility is not guaranteed; let the provider redeliver.
  if (!payment) throw new Transient('PAY_WAFFO_PAYMENT_NOT_VISIBLE');
  const reading = readPaymentFacts(payment, provider.storeId);
  if (reading.kind === 'not_paid') return { state: 'ignored', reason: 'not_paid' };
  if (reading.kind === 'unknown') return resolve(db, receipt, 'review', reading.reason);
  const { facts } = reading;
  const mapped = facts.periodNumber === 1
    ? await firstPayment(db, provider, receipt, facts)
    : await renewal(db, provider, receipt, facts);
  const outcome = mapped ?? await offsite(db, provider, receipt, facts);
  // A renewal of a mapped subscription in review was already stopped by its own cancel flow.
  if (outcome.state === 'review' && (facts.periodNumber === 1 || !mapped)) await stopUnmappedRenewal(provider, facts.waffoOrderId);
  return outcome;
}
