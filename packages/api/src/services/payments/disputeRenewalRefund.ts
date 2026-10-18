/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { readDisputePayment } from './disputePayment';
import { evidence, objectId } from './monthlyRefundProvider';
import { handleCardRefund } from './cardRefundWebhook';
import type { DisputeAlert } from './disputes';

type Intent = { status: string; claimedAt: string; refundId: string | null; idempotencyKey: string; paymentKey: string };

/** The MP refund transport/receipt guards also serve this Owner-approved full refund (no 6% fee: nothing was delivered).
 * One durable order intent and Stripe key; ambiguous results are observed before any further decision. */
export async function refundDisputedRenewal(db: SupabaseClient, stripe: Stripe, orderId: string, invoiceId: string,
  alert: DisputeAlert = () => {}) {
  const scope = await resolveStripeScope(stripe);
  const payment = await readDisputePayment(stripe, scope, { invoiceId });
  const claimed = await db.rpc('pay_dispute_refund_claim', { p_order: orderId });
  if (claimed.error || !claimed.data) throw new Error('PAY_DISPUTE_REFUND_CLAIM_UNAVAILABLE');
  const intent = claimed.data as Intent;
  evidence(intent.paymentKey === `${scope.merchant}:${scope.mode}:${payment.paymentIntentId}`);
  if (intent.status === 'succeeded') return 'succeeded';
  const save = async (state: 'succeeded' | 'pending' | 'manual', refundId: string | null) => {
    const result = await db.rpc('pay_dispute_refund_result', { p_order: orderId, p_state: state, p_refund: refundId });
    if (result.error) throw new Error('PAY_DISPUTE_REFUND_RESULT_UNAVAILABLE');
    if (state === 'manual' && intent.status !== 'manual') alert({ code: 'PAY_DISPUTE_RENEWAL_REFUND_MANUAL', disputeId: orderId, dueBy: null });
    return state;
  };
  const observe = async () => {
    const rows = await stripe.refunds.list({ charge: payment.chargeId, limit: 100 });
    evidence(!rows.has_more);
    return rows.data;
  };
  let charge: Stripe.Charge;
  let refunds: Stripe.Refund[];
  try {
    charge = await stripe.charges.retrieve(payment.chargeId);
    evidence(charge.id === payment.chargeId && charge.livemode === (scope.mode === 'live')
      && objectId(charge.payment_intent) === payment.paymentIntentId && charge.paid && charge.captured && !charge.disputed);
    refunds = await observe();
  } catch { return save('manual', intent.refundId); }
  let refund = refunds.find(row => row.metadata?.disputeRenewalOrderId === orderId);
  if (!refund && refunds.some(row => row.status !== 'failed' && row.status !== 'canceled')) {
    if (charge.refunded && charge.amount_refunded === charge.amount_captured) {
      await handleCardRefund(db, stripe, { chargeId: charge.id });
      return save('succeeded', refunds.find(row => row.status === 'succeeded')?.id ?? null);
    }
    return save('manual', intent.refundId);
  }
  if (!refund) {
    // Never dispatch again after an uncertain/failed decision or outside the provider's idempotency retention window.
    if (intent.status !== 'dispatching' || Date.now() - Date.parse(intent.claimedAt) >= 20 * 3600_000) {
      return save('manual', intent.refundId);
    }
    try {
      refund = await stripe.refunds.create({ charge: charge.id, amount: charge.amount_captured,
        metadata: { orderId, disputeRenewalOrderId: orderId } }, { idempotencyKey: intent.idempotencyKey });
    } catch {
      // The request might have succeeded. Inspect actual refunds once; never issue a new identity or blindly retry.
      try { refund = (await observe()).find(row => row.metadata?.disputeRenewalOrderId === orderId); }
      catch { return save('manual', intent.refundId); }
      if (!refund) return save('manual', intent.refundId);
    }
  }
  try {
    refund = await stripe.refunds.retrieve(refund.id);
    evidence(refund.object === 'refund' && refund.metadata?.orderId === orderId
      && refund.metadata?.disputeRenewalOrderId === orderId && refund.amount === charge.amount_captured
      && refund.currency === charge.currency && objectId(refund.charge) === charge.id
      && objectId(refund.payment_intent) === payment.paymentIntentId);
  } catch { return save('manual', refund.id); }
  if (refund.status === 'succeeded') {
    await handleCardRefund(db, stripe, { refundId: refund.id });
    return save('succeeded', refund.id);
  }
  return save(refund.status === 'pending' || refund.status === 'requires_action' ? 'pending' : 'manual', refund.id);
}

export async function reconcileDisputeRenewalRefunds(db: SupabaseClient, stripe: Stripe, alert?: DisputeAlert,
  deadline = Date.now() + 15_000) {
  const scope = await resolveStripeScope(stripe);
  let checked = 0, failed = 0, after: string | undefined;
  for (let page = 0; page < 20; page++) {
    let query = db.from('payment_orders').select('id').eq('payment_channel', 'stripe')
      .eq('merchant_namespace', scope.merchant).eq('payment_mode', scope.mode)
      .in('dispute_refund_status', ['blocked', 'dispatching', 'pending', 'manual']).order('id').limit(50);
    if (after) query = query.gt('id', after);
    const rows = await query;
    if (rows.error || !Array.isArray(rows.data)) throw new Error('PAY_DISPUTE_REFUND_SCAN_UNAVAILABLE');
    for (const row of rows.data) {
      if (Date.now() > deadline) return { checked, failed, complete: false };
      checked++;
      try {
        const refs = await db.from('payment_provider_refs').select('external_id').eq('order_id', row.id)
          .eq('channel', 'stripe').eq('merchant_namespace', scope.merchant).eq('mode', scope.mode).eq('object_type', 'payment').limit(2);
        evidence(!refs.error && Array.isArray(refs.data) && refs.data.length === 1 && refs.data[0].external_id.startsWith('in_'));
        if (await refundDisputedRenewal(db, stripe, row.id, refs.data[0].external_id, alert) === 'manual') failed++;
      } catch { failed++; }
    }
    if (rows.data.length < 50) return { checked, failed, complete: true };
    after = rows.data.at(-1)!.id;
  }
  return { checked, failed, complete: false };
}
