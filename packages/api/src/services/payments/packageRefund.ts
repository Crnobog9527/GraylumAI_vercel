/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { resolveStripeScope } from './stripeCheckoutPersistence';

type Db = Pick<SupabaseClient, 'from' | 'rpc'>;
export type RefundStripe = Pick<Stripe, 'accounts' | 'balance' | 'paymentIntents' | 'charges' | 'refunds'>;
const approvalSchema = z.object({
  id: z.string().uuid(), orderId: z.string().uuid(), ticketId: z.string().uuid(),
  status: z.enum(['approved', 'rejected', 'dispatching', 'pending', 'succeeded', 'failed', 'review_required']),
  netMinor: z.number().int().positive(), currency: z.string(),
  idempotencyKey: z.string().optional(), claimedAt: z.string().optional(),
  cash: z.object({ chargeId: z.string(), paymentIntentId: z.string() }),
});
type Order = { id: string; user_id: string; payment_channel: string; payment_mode: string;
  merchant_namespace: string; amount_total: number; currency: string; refund_approval: unknown };
export type RefundRequest = { orderId: string; ticketId: string; feePermitted: 'confirmed' | 'not_permitted';
  feeEvidence: string };
const id = (value: string | { id: string } | null) => typeof value === 'string' ? value : value?.id;

async function rpc(db: Db, name: string, args: Record<string, unknown>) {
  const result = await db.rpc(name, args);
  if (result.error) throw new Error('PAY_REFUND_RECHECK_FAILED', { cause: result.error });
  if (!result.data || typeof result.data !== 'object') throw new Error('PAY_REFUND_RESULT_UNKNOWN');
  return result.data;
}
async function loadOrder(db: Db, orderId: string): Promise<Order> {
  const result = await db.from('payment_orders')
    .select('id,user_id,payment_channel,payment_mode,merchant_namespace,amount_total,currency,refund_approval')
    .eq('id', orderId).single();
  if (result.error || !result.data) throw new Error('PAY_REFUND_ORDER_UNKNOWN');
  return result.data as Order;
}
async function scopedOrder(db: Db, stripe: RefundStripe, orderId: string) {
  const order = await loadOrder(db, orderId);
  const scope = await resolveStripeScope(stripe);
  if (scope.mode !== 'test' || order.payment_channel !== 'stripe' || order.payment_mode !== 'test'
    || order.merchant_namespace !== scope.merchant) throw new Error('PAY_REFUND_TEST_STRIPE_ONLY');
  return { order, scope };
}
async function paymentId(db: Db, order: Order) {
  const mapping = await db.from('payment_provider_refs').select('external_id')
    .eq('order_id', order.id).eq('object_type', 'payment').eq('channel', 'stripe')
    .eq('merchant_namespace', order.merchant_namespace).eq('mode', order.payment_mode).limit(2);
  if (mapping.error || !Array.isArray(mapping.data) || mapping.data.length !== 1) {
    throw new Error('PAY_REFUND_PAYMENT_MAPPING_UNKNOWN');
  }
  return String(mapping.data[0].external_id);
}
export async function readPackageRefundCash(db: Db, stripe: RefundStripe, orderId: string) {
  const { order, scope } = await scopedOrder(db, stripe, orderId);
  const intentId = await paymentId(db, order);
  const payment = await stripe.paymentIntents.retrieve(intentId);
  const chargeId = id(payment.latest_charge);
  if (payment.id !== intentId || payment.livemode || payment.status !== 'succeeded'
    || payment.amount_received !== order.amount_total || payment.currency !== order.currency
    || !chargeId) throw new Error('PAY_REFUND_PAYMENT_MISMATCH');
  const charge = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  const balance = charge.balance_transaction;
  if (charge.id !== chargeId || charge.livemode || !charge.paid || !charge.captured
    || id(charge.payment_intent) !== intentId || charge.amount !== order.amount_total
    || charge.amount_captured !== order.amount_total || charge.currency !== order.currency
    || !balance || typeof balance === 'string' || !Number.isSafeInteger(balance.created)) {
    throw new Error('PAY_REFUND_CHARGE_MISMATCH');
  }
  // Any existing refund (including pending or failed) requires reconciliation, not a new intent.
  const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
  if (refunds.has_more || refunds.data.length > 0 || charge.amount_refunded !== 0 || charge.disputed) {
    throw new Error('PAY_REFUND_PRIOR_REFUND_OR_DISPUTE');
  }
  return { orderId: order.id, merchant: scope.merchant, mode: scope.mode, currency: order.currency,
    paymentIntentId: intentId, chargeId: charge.id, paidMinor: order.amount_total,
    paidAt: new Date(balance.created * 1000).toISOString(), refundedMinor: 0, refundCount: 0, disputed: false };
}
function quoteArgs(actorId: string, input: RefundRequest, cash: unknown) {
  return { p_actor: actorId, p_order: input.orderId, p_ticket: input.ticketId, p_cash: cash,
    p_fee: input.feePermitted, p_fee_evidence: input.feeEvidence };
}
export async function previewPackageRefund(db: Db, stripe: RefundStripe, actorId: string, input: RefundRequest) {
  const cash = await readPackageRefundCash(db, stripe, input.orderId);
  return rpc(db, 'pay_common_package_refund_quote', quoteArgs(actorId, input, cash));
}
export async function decidePackageRefund(db: Db, stripe: RefundStripe, actorId: string,
  input: RefundRequest & { versionHash: string; decision: 'approve' | 'reject' }) {
  const cash = await readPackageRefundCash(db, stripe, input.orderId);
  return rpc(db, 'pay_common_package_refund_decide', { ...quoteArgs(actorId, input, cash),
    p_version: input.versionHash, p_decision: input.decision });
}
export async function recordPackageRefund(db: Db, stripe: RefundStripe, orderId: string, refund: Stripe.Refund) {
  const { order, scope } = await scopedOrder(db, stripe, orderId);
  const approval = approvalSchema.parse(order.refund_approval);
  return rpc(db, 'pay_common_package_refund_result', { p_order: order.id, p_intent: approval.id,
    p_refund: { id: refund.id, intentId: refund.metadata?.refundIntentId, orderId: refund.metadata?.orderId,
      paymentIntentId: id(refund.payment_intent), chargeId: id(refund.charge), currency: refund.currency,
      amount: refund.amount, status: refund.status, mode: scope.mode, merchant: scope.merchant } });
}
export async function executePackageRefund(db: Db, stripe: RefundStripe, actorId: string,
  input: { orderId: string; intentId: string }) {
  const cash = await readPackageRefundCash(db, stripe, input.orderId);
  const claimed = approvalSchema.parse(await rpc(db, 'pay_common_package_refund_claim', {
    p_actor: actorId, p_order: input.orderId, p_intent: input.intentId, p_cash: cash }));
  if (!claimed.idempotencyKey) throw new Error('PAY_REFUND_EXECUTION_ID_MISSING');
  try {
    const refund = await stripe.refunds.create({ charge: cash.chargeId, amount: claimed.netMinor,
      metadata: { orderId: input.orderId, refundIntentId: claimed.id } }, { idempotencyKey: claimed.idempotencyKey });
    return await recordPackageRefund(db, stripe, input.orderId, refund);
  } catch {
    // Includes a successful remote refund followed by a local write failure.
    // Do not recreate here, restore credits, or claim success without a durable result.
    return { status: 'review_required', intentId: claimed.id, reason: 'PAY_REFUND_LOOKUP_REQUIRED' };
  }
}
export async function reconcilePackageRefund(db: Db, stripe: RefundStripe, actorId: string, orderId: string) {
  const { order } = await scopedOrder(db, stripe, orderId);
  const approval = approvalSchema.parse(order.refund_approval);
  if (!approval.idempotencyKey) return approval;
  // Original payment identity is re-read; a changed current sales channel is irrelevant.
  if (await paymentId(db, order) !== approval.cash.paymentIntentId) throw new Error('PAY_REFUND_PAYMENT_MAPPING_UNKNOWN');
  let cursor: string | undefined;
  const found: Stripe.Refund[] = [];
  for (let page = 0; page < 100; page++) {
    const result = await stripe.refunds.list({ charge: approval.cash.chargeId, limit: 100, starting_after: cursor });
    found.push(...result.data.filter(refund => refund.metadata?.refundIntentId === approval.id));
    if (!result.has_more) {
      if (found.length === 1) return recordPackageRefund(db, stripe, orderId, found[0]);
      const age = Date.now() - Date.parse(approval.claimedAt ?? '');
      // Stripe retains keys for at least 24 hours. Retry only within 20 hours,
      // after a complete lookup and fresh original-payment/dispute checks.
      if (found.length === 0 && approval.status === 'dispatching' && age >= 0 && age < 20 * 60 * 60 * 1000) {
        const cash = await readPackageRefundCash(db, stripe, orderId);
        if (cash.chargeId !== approval.cash.chargeId) throw new Error('PAY_REFUND_CHARGE_MISMATCH');
        await rpc(db, 'pay_common_package_refund_retry', { p_actor: actorId,
          p_order: orderId, p_intent: approval.id, p_cash: cash });
        try {
          const refund = await stripe.refunds.create({ charge: cash.chargeId, amount: approval.netMinor,
            metadata: { orderId, refundIntentId: approval.id } }, { idempotencyKey: approval.idempotencyKey });
          return await recordPackageRefund(db, stripe, orderId, refund);
        } catch { /* Same identity remains pending; never release the reserved credits on uncertainty. */ }
      }
      return { status: 'review_required', reason: 'PAY_REFUND_LOOKUP_REQUIRED', intentId: approval.id };
    }
    const next = result.data.at(-1)?.id;
    if (!next || next === cursor) throw new Error('PAY_REFUND_LOOKUP_INCOMPLETE');
    cursor = next;
  }
  throw new Error('PAY_REFUND_LOOKUP_INCOMPLETE');
}

export async function rejectPackageRefund(db: Db, actorId: string,
  input: { orderId: string; ticketId: string; reason: 'ineligible' | 'evidence_missing' | 'customer_withdrew' }) {
  return rpc(db, 'pay_common_package_refund_reject', { p_actor: actorId, p_order: input.orderId,
    p_ticket: input.ticketId, p_reason: input.reason });
}

export async function readPackageRefundStatus(db: Db, orderId: string) {
  return (await loadOrder(db, orderId)).refund_approval;
}
