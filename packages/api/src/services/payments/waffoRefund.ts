/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { RefundRequest } from './packageRefund';
import type { WaffoPayment } from './waffoPayments';
import type { WaffoOperationsClient, WaffoRefund } from './waffoTestOperationsClient';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;
export type RefundWaffo = Pick<WaffoOperationsClient, 'merchant' | 'mode' | 'storeId' | 'readPayment'
  | 'hasChargeback' | 'findRefunds' | 'findRefundTickets' | 'createRefundTicket'>;
const approvalSchema = z.object({
  id: z.uuid(), orderId: z.uuid(), ticketId: z.uuid(), status: z.string(), netMinor: z.number().int().positive(),
  currency: z.literal('usd'), idempotencyKey: z.string().optional(),
  cash: z.object({ paymentIntentId: z.string(), chargeId: z.string() }),
});
type Approval = z.infer<typeof approvalSchema>;
type Order = { id: string; payment_channel: string; payment_mode: string; merchant_namespace: string;
  mode: string; auto_renew: boolean; amount_total: number; currency: string; refund_approval: unknown;
  provider_payment_method: string | null };
const minor = (value: string) => /^[0-9]{1,9}$/.test(value) ? Number(value) : NaN;
function major(value: string) {
  const parts = /^([0-9]{1,7})\.([0-9]{2})$/.exec(value);
  return parts ? Number(parts[1]) * 100 + Number(parts[2]) : NaN;
}
async function rpc(db: Db, name: string, args: Record<string, unknown>) {
  const result = await db.rpc(name, args);
  if (result.error) throw new Error('PAY_REFUND_RECHECK_FAILED', { cause: result.error });
  if (!result.data || typeof result.data !== 'object') throw new Error('PAY_REFUND_RESULT_UNKNOWN');
  return result.data;
}
async function scopedOrder(db: Db, provider: RefundWaffo, orderId: string): Promise<Order> {
  const result = await db.from('payment_orders').select('id,payment_channel,payment_mode,merchant_namespace,mode,'
    + 'auto_renew,amount_total,currency,refund_approval,provider_payment_method').eq('id', orderId).single();
  const order = result.data as unknown as Order | null;
  if (result.error || !order) throw new Error('PAY_REFUND_ORDER_UNKNOWN');
  if (order.payment_channel !== 'waffo' || order.payment_mode !== provider.mode
    || order.merchant_namespace !== provider.merchant || order.mode !== 'payment' || order.auto_renew !== false
    || !['card', 'alipay'].includes(order.provider_payment_method ?? '') || order.currency !== 'usd') {
    throw new Error('PAY_WAFFO_REFUND_SCOPE');
  }
  return order;
}
async function paymentId(db: Db, order: Order) {
  const result = await db.from('payment_provider_refs').select('external_id').eq('order_id', order.id)
    .eq('object_type', 'payment').eq('channel', 'waffo').eq('merchant_namespace', order.merchant_namespace)
    .eq('mode', order.payment_mode).limit(2);
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1
    || !/^PAY_[A-Za-z0-9]+$/.test(result.data[0]?.external_id)) throw new Error('PAY_REFUND_PAYMENT_MAPPING_UNKNOWN');
  return String(result.data[0].external_id);
}
async function originalPayment(db: Db, provider: RefundWaffo, order: Order) {
  const id = await paymentId(db, order);
  const payment = await provider.readPayment(id);
  const one = payment?.onetimeOrder;
  if (!payment || payment.id !== id || payment.status !== 'succeeded' || !one || payment.subscriptionOrder
    || payment.periodNumber !== null || payment.testMode !== (provider.mode === 'test')
    || one.testMode !== payment.testMode || one.storeId !== provider.storeId || one.id !== payment.orderId
    || one.orderMerchantExternalId !== order.id || payment.orderMerchantExternalId !== order.id
    || payment.paymentMethod?.type !== order.provider_payment_method || payment.amount.currency !== 'USD'
    || minor(payment.amount.amount) !== order.amount_total || payment.pspAmountDetails?.currency !== 'USD'
    || major(payment.pspAmountDetails.amount) !== order.amount_total
    || !Number.isFinite(Date.parse(payment.createdAt))) throw new Error('PAY_REFUND_PAYMENT_MISMATCH');
  return payment;
}
/** Zero is evidence only after complete provider refund and chargeback lookups, never a missing-field default. */
export async function readWaffoRefundCash(db: Db, provider: RefundWaffo, orderId: string) {
  const order = await scopedOrder(db, provider, orderId);
  const payment = await originalPayment(db, provider, order);
  const refunds = await provider.findRefunds({ paymentId: payment.id });
  if (refunds.length || payment.refundStatus !== 'none' || payment.isFullyRefunded !== false
    || payment.refundedAmount?.currency !== 'USD' || payment.refundedAmount.amount !== '0'
    || await provider.hasChargeback(payment.id)) throw new Error('PAY_REFUND_PRIOR_REFUND_OR_DISPUTE');
  return { orderId: order.id, merchant: provider.merchant, mode: provider.mode, currency: order.currency,
    paymentIntentId: payment.id, chargeId: payment.id, paidMinor: order.amount_total, taxMinor: 0,
    paidAt: payment.createdAt, refundedMinor: 0, refundCount: 0, disputed: false };
}
function quoteArgs(actorId: string, input: RefundRequest, cash: unknown) {
  return { p_actor: actorId, p_order: input.orderId, p_ticket: input.ticketId, p_cash: cash,
    p_fee: input.feePermitted, p_fee_evidence: input.feeEvidence };
}
export async function previewWaffoRefund(db: Db, provider: RefundWaffo, actorId: string, input: RefundRequest) {
  return rpc(db, 'pay_common_package_refund_quote', quoteArgs(actorId, input, await readWaffoRefundCash(db, provider, input.orderId)));
}
export async function decideWaffoRefund(db: Db, provider: RefundWaffo, actorId: string,
  input: RefundRequest & { versionHash: string; decision: 'approve' | 'reject' }) {
  return rpc(db, 'pay_common_package_refund_decide', {
    ...quoteArgs(actorId, input, await readWaffoRefundCash(db, provider, input.orderId)),
    p_version: input.versionHash, p_decision: input.decision,
  });
}
const review = (intentId: string) => ({ status: 'review_required', intentId, reason: 'PAY_REFUND_LOOKUP_REQUIRED' });
function executionIdentity(approval: Approval, order: Order, payment: WaffoPayment) {
  if (approval.orderId !== order.id || approval.cash.paymentIntentId !== payment.id || approval.cash.chargeId !== payment.id
    || approval.idempotencyKey !== `pay-common:refund:${approval.id}` || approval.netMinor > order.amount_total) {
    throw new Error('PAY_REFUND_INTENT_MISMATCH');
  }
}
export async function executeWaffoRefund(db: Db, provider: RefundWaffo, actorId: string,
  input: { orderId: string; intentId: string }) {
  const cash = await readWaffoRefundCash(db, provider, input.orderId);
  const rawClaim = await rpc(db, 'pay_common_package_refund_claim', {
    p_actor: actorId, p_order: input.orderId, p_intent: input.intentId, p_cash: cash,
  });
  try {
    // Cash already contains the strongly checked original scope/payment. After the durable claim,
    // no fallible read may strand its reserved credits before the one permitted dispatch.
    const claimed = approvalSchema.parse(rawClaim);
    if (claimed.id !== input.intentId || claimed.orderId !== cash.orderId || claimed.cash.chargeId !== cash.chargeId
      || claimed.cash.paymentIntentId !== cash.paymentIntentId || claimed.netMinor > cash.paidMinor
      || claimed.idempotencyKey !== `pay-common:refund:${claimed.id}`) throw new Error('PAY_REFUND_INTENT_MISMATCH');
    const ticket = await provider.createRefundTicket({ paymentId: cash.paymentIntentId,
      reason: `Approved Graylum refund ${claimed.id}`, requestedAmount: { amount: (claimed.netMinor / 100).toFixed(2), currency: 'USD' },
      refundTicketMerchantExternalId: claimed.idempotencyKey! });
    if (ticket.subjectId !== cash.paymentIntentId || ticket.refundTicketMerchantExternalId !== claimed.idempotencyKey) {
      return review(claimed.id);
    }
    // Ticket approval is not a cash refund. Only a separately queried succeeded refund closes the local approval.
    return await reconcileWaffoRefund(db, provider, actorId, input.orderId);
  } catch {
    // Waffo does not guarantee ticket-create idempotency: no retry, even after an empty later lookup.
    return review(input.intentId);
  }
}
function refundMatches(refund: WaffoRefund, approval: Approval, order: Order, payment: WaffoPayment, ticketId: string) {
  return refund.status === 'succeeded' && refund.paymentId === payment.id && refund.ticketId === ticketId
    && refund.testMode === payment.testMode && refund.orderMerchantExternalId === order.id
    && refund.refundTicketMerchantExternalId === approval.idempotencyKey
    && refund.amount.currency === 'USD' && minor(refund.amount.amount) === approval.netMinor
    && refund.pspAmountDetails.currency === 'USD' && major(refund.pspAmountDetails.amount) === approval.netMinor
    && Number.isFinite(Date.parse(refund.createdAt)) && Date.parse(refund.createdAt) >= Date.parse(payment.createdAt);
}
export async function reconcileWaffoRefund(db: Db, provider: RefundWaffo, _actorId: string | undefined, orderId: string) {
  const order = await scopedOrder(db, provider, orderId);
  const approval = approvalSchema.parse(order.refund_approval);
  if (!approval.idempotencyKey) return approval;
  const payment = await originalPayment(db, provider, order);
  executionIdentity(approval, order, payment);
  const tickets = await provider.findRefundTickets(approval.idempotencyKey);
  const refunds = await provider.findRefunds({ paymentId: payment.id });
  const ticket = tickets.length === 1 ? tickets[0] : null;
  const refund = refunds.length === 1 ? refunds[0] : null;
  if (!ticket || ticket.subjectId !== payment.id || ticket.refundTicketMerchantExternalId !== approval.idempotencyKey
    || !refund || !refundMatches(refund, approval, order, payment, ticket.id)
    || payment.refundedAmount?.currency !== 'USD' || minor(payment.refundedAmount.amount) !== approval.netMinor
    || payment.isFullyRefunded !== (approval.netMinor === order.amount_total)
    || !payment.refundStatus || payment.refundStatus === 'none') return review(approval.id);
  return rpc(db, 'pay_common_package_refund_result', { p_order: order.id, p_intent: approval.id,
    p_refund: { id: refund.id, intentId: approval.id, orderId: order.id, paymentIntentId: payment.id,
      chargeId: payment.id, currency: order.currency, amount: approval.netMinor, status: 'succeeded',
      mode: provider.mode, merchant: provider.merchant } });
}
