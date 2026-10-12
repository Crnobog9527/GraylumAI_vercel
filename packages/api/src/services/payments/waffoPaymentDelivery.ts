/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readPaymentFacts, type PaymentFacts, type WaffoPayment, type WaffoTestPayments } from './waffoPayments';
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

type Decision = { state: 'applied' | 'review'; reason: string };
/** The database decision only; the receipt is resolved after any renewal stop it requires. Every RPC
 * used here is idempotent, so a redelivery after a failed stop reaches the same decision. */
async function decide(db: Db, fn: string, args: Record<string, unknown>): Promise<Decision> {
  const result = await db.rpc(fn, args);
  if (result.error) {
    const code = BUSINESS.exec(result.error.message ?? '')?.[1];
    if (!code) throw new Transient('PAY_WAFFO_DELIVERY_UNAVAILABLE');
    return { state: 'review', reason: code.toLowerCase() };
  }
  if (result.data?.state === 'fulfilled') return { state: 'applied', reason: 'delivered' };
  const reason = typeof result.data?.reason === 'string' && /^[a-z_]{1,64}$/.test(result.data.reason) ? result.data.reason : 'review';
  return { state: 'review', reason };
}

async function single(query: PromiseLike<{ data: unknown; error: unknown }>) {
  const result = await query;
  if (result.error) throw new Transient('PAY_WAFFO_PERSISTENCE_UNAVAILABLE');
  return result.data as Record<string, string> | null;
}

async function firstPayment(db: Db, provider: Provider, facts: PaymentFacts): Promise<Decision | null> {
  if (!facts.externalId || !z.uuid().safeParse(facts.externalId).success) return null;
  const order = await single(db.from('payment_orders').select('id,fulfilled_at,subscription_id').eq('id', facts.externalId)
    .eq('payment_channel', 'waffo').eq('payment_method', 'card').eq('merchant_namespace', provider.merchant).eq('payment_mode', 'test').maybeSingle());
  if (!order) return null;
  if (order.fulfilled_at && await secondFirstPayment(db, provider, order, facts)) return { state: 'review', reason: 'duplicate_order_payment' };
  const checkout = await single(db.from('payment_provider_refs').select('external_id').eq('order_id', order.id)
    .eq('object_type', 'checkout').eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle());
  if (!checkout) return { state: 'review', reason: 'checkout_unmapped' };
  return decide(db, 'pay_waffo_fulfill_payment', {
    p_order: order.id, p_merchant: provider.merchant, p_checkout: checkout.external_id, p_payment: facts.paymentId,
    p_amount: facts.amountCents, p_currency: facts.currency, p_paid_at: facts.createdAt, p_subscription: facts.waffoOrderId,
    p_start: facts.periodStart, p_end: facts.periodEnd,
  });
}

/** Waffo checkout has no idempotency and orderMerchantExternalId is not unique (official answer 2026-10-12),
 * so one order could in theory be paid twice through two sessions, each creating its own Waffo subscription.
 * The database would answer such a payment as a "duplicate delivery"; recognise it here instead, so it becomes
 * a refund candidate and its own subscription's renewal is stopped. Redelivery of the delivered payment, or a
 * payment of the delivered subscription itself, is not a second payment. */
async function secondFirstPayment(db: Db, provider: Provider, order: Record<string, string>, facts: PaymentFacts) {
  const known = await single(db.from('payment_provider_refs').select('order_id').eq('object_type', 'payment')
    .eq('external_id', facts.paymentId).eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle());
  if (known) return false;
  const delivered = order.subscription_id ? await single(db.from('payment_provider_refs').select('external_id')
    .eq('subscription_id', order.subscription_id).eq('object_type', 'subscription').eq('channel', 'waffo')
    .eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle()) : null;
  return delivered?.external_id !== facts.waffoOrderId;
}

async function renewal(db: Db, provider: Provider, facts: PaymentFacts): Promise<Decision | null> {
  const ref = await single(db.from('payment_provider_refs').select('subscription_id').eq('object_type', 'subscription')
    .eq('external_id', facts.waffoOrderId).eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle());
  if (!ref?.subscription_id) return null;
  // Amount authority is the database's recorded order price (49 then 69, founder 496), not the catalog.
  return decide(db, 'pay_waffo_renew_subscription', {
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
 * with nothing delivered. Stop its renewal and confirm by reading it back BEFORE the receipt is resolved;
 * the payment itself stays with manual refund handling. A failed or unconfirmed stop throws so the receipt
 * stays open for provider redelivery; the daily reconciliation reports any subscription still renewing. */
async function stopRenewal(provider: Provider, waffoOrderId: string) {
  try {
    // Start from the authoritative read: an earlier attempt may have stopped it before its response was lost.
    let observed = await provider.readSubscription(waffoOrderId);
    if (observed.orderId === waffoOrderId && !STOPPED.includes(observed.status)) {
      observed = await provider.cancelSubscription(waffoOrderId);
      if (observed.orderId === waffoOrderId && !STOPPED.includes(observed.status)) observed = await provider.readSubscription(waffoOrderId);
    }
    if (observed.orderId === waffoOrderId && STOPPED.includes(observed.status)) return;
    logger.error('billing', 'pay_waffo_renewal_stop_unconfirmed', { waffoOrderId, status: observed.status });
  } catch (error) {
    logger.error('billing', 'pay_waffo_renewal_stop_failed', { waffoOrderId, ...describeWaffoFailure(error) });
  }
  throw new Transient('PAY_WAFFO_RENEWAL_STOP_PENDING');
}

/** A paid record we cannot prove can never be delivered automatically. When it is provably this test
 * store's own subscription and no site subscription maps to it, stop the renewal as for other undelivered
 * cash. A mapped subscriber is left alone: its renewal and cancel flow belong to the normal path. */
async function stopUnknownRenewal(db: Db, provider: Provider, payment: WaffoPayment, reason: string) {
  const order = payment.subscriptionOrder;
  if (['test_mode_unproven', 'store_scope'].includes(reason) || !payment.testMode || !order?.testMode
    || order.storeId !== provider.storeId || order.id !== payment.orderId) return;
  const mapped = await single(db.from('payment_provider_refs').select('subscription_id').eq('object_type', 'subscription')
    .eq('external_id', payment.orderId).eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle());
  if (!mapped) await stopRenewal(provider, payment.orderId);
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
  if (reading.kind === 'unknown') {
    await stopUnknownRenewal(db, provider, payment, reading.reason);
    return resolve(db, receipt, 'review', reading.reason);
  }
  const { facts } = reading;
  const decision = facts.periodNumber === 1 ? await firstPayment(db, provider, facts) : await renewal(db, provider, facts);
  if (!decision) {
    // No site order or subscription: offsite cash. Stop first; the offsite RPC resolves the receipt itself.
    await stopRenewal(provider, facts.waffoOrderId);
    return offsite(db, provider, receipt, facts);
  }
  if (decision.state === 'review' && (facts.periodNumber === 1 || await mappedRenewalStillOpen(db, provider, decision, facts))) {
    await stopRenewal(provider, facts.waffoOrderId);
  }
  return resolve(db, receipt, decision.state, decision.reason);
}

/** pay_waffo_renew_subscription records a charge it must not deliver (closed or erasing account, terminated
 * credit release) as plain review. Unless the customer's own stop is already in its cancel flow, nothing
 * else stops the next charge. Term conflicts (other reasons) stay manual: they may be a paying subscriber. */
async function mappedRenewalStillOpen(db: Db, provider: Provider, decision: Decision, facts: PaymentFacts) {
  if (decision.reason !== 'review') return false;
  const ref = await single(db.from('payment_provider_refs').select('subscription_id').eq('object_type', 'subscription')
    .eq('external_id', facts.waffoOrderId).eq('channel', 'waffo').eq('merchant_namespace', provider.merchant).eq('mode', 'test').maybeSingle());
  if (!ref?.subscription_id) return false;
  const sub = await single(db.from('user_subscriptions').select('method_cancel_requested_at').eq('id', ref.subscription_id).maybeSingle());
  return Boolean(sub) && !sub!.method_cancel_requested_at;
}
