/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { getStripeClient } from '../stripe';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { readMonthlyProvider, evidence, objectId, type MonthlyStripe } from './monthlyRefundProvider';
import { readMonthlyRefundStatus, recordMonthlyRefund, type MonthlyDb } from './monthlyRefundService';

/** Verified lifecycle webhook: keep the held projection; never restore entitlement
 * or dispatch a refund/cancel from a subscription event. */
export async function syncMonthlyRefundSubscription(db: MonthlyDb, stripe: MonthlyStripe, subscriptionId: string) {
  const { data, error } = await db.from('payment_orders').select('id')
    .eq('refund_approval->>kind', 'monthly_first_purchase')
    .eq('refund_approval->terms->>providerSubscriptionId', subscriptionId)
    .in('refund_approval->>hold', ['held', 'terminated']).limit(2);
  evidence(!error && Array.isArray(data) && data.length <= 1);
  if (!data.length) return false;
  const i = await readMonthlyRefundStatus(db, data[0].id);
  const seen = await readMonthlyProvider(stripe, i);
  const observed = await db.rpc('pay_common_monthly_refund_observe', {
    p_actor: null, p_order: data[0].id, p_intent: i.id, p_evidence: seen,
  });
  evidence(!observed.error);
  if (seen.refunds.rows.length) {
    const recorded = await db.rpc('pay_common_monthly_refund_result', {
      p_order: data[0].id, p_intent: i.id, p_refund: seen.refunds.rows[0],
    });
    evidence(!recorded.error);
  }
  return true;
}

/** Invoice/order resolution also catches dashboard refunds without intent metadata.
 * A known monthly intent must never fall through to the legacy second clawback. */
export async function reconcileMonthlyRefundForOrder(
  db: MonthlyDb, orderId: string, refundId: string | null, stripeClient?: MonthlyStripe,
) {
  const { data, error } = await db.from('payment_orders').select('refund_approval').eq('id', orderId).maybeSingle();
  evidence(!error);
  if (data?.refund_approval?.kind !== 'monthly_first_purchase' || data.refund_approval.status === 'rejected') return { handled: false as const };
  const stripe = stripeClient ?? getStripeClient();
  if (refundId) {
    const refund = await stripe.refunds.retrieve(refundId);
    return { handled: true as const, result: await recordMonthlyRefund(db, stripe, orderId, refund) };
  }
  const i = await readMonthlyRefundStatus(db, orderId);
  const scope = await resolveStripeScope(stripe);
  const charge = await stripe.charges.retrieve(i.terms.chargeId);
  evidence(scope.mode === 'test' && scope.merchant === i.terms.merchant && charge.livemode === false
    && charge.id === i.terms.chargeId && objectId(charge.payment_intent) === i.terms.paymentIntentId
    && charge.currency === i.terms.currency);
  const result = await db.rpc('pay_common_monthly_refund_conflict', { p_order: orderId, p_intent: i.id,
    p_cash: { id: charge.id, chargeId: charge.id, paymentIntentId: i.terms.paymentIntentId,
      currency: charge.currency, merchant: scope.merchant, mode: scope.mode, amount: charge.amount_refunded, status: 'unknown' } });
  evidence(!result.error);
  return { handled: true as const, result: result.data };
}
