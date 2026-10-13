/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveStripeScope } from './stripeCheckoutPersistence';
import { findCardOrderForPayment } from './cardPaymentLookup';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';
import { logger } from '../../lib/logger';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;

type RefundStripe = Pick<Stripe, 'refunds' | 'charges' | 'invoicePayments' | 'paymentIntents' | 'invoices' | 'subscriptions'
  | 'accounts' | 'balance'>;
type RefundResult = { state: 'refunded' | 'recorded' | 'partial_review' | 'pack_review'; duplicate: boolean; renewing?: boolean;
  creditsShortfall?: number; packageId?: string; packCredits?: number; balance?: number };

/** Refund events (charge.refunded, refund.*, charge.refund.updated) of PAY-STRIPE-MP card orders. A refund we did not
 * approve is an external refund fact (Link support, Stripe after 48 hours, a Dashboard refund): each succeeded refund
 * is recorded once by pay_stripe_mp_record_external_refund (0247), which ends the order only when fully refunded.
 * Each refund is classified on its own: ours (our approval flows tag them with refundIntentId) are left to the existing
 * refund path, external ones are recorded here. Returns false when the payment is not a card order (wallet, legacy,
 * off-site) or the event also carries a refund of ours, so the existing path still runs for that one. */
export async function handleCardRefund(db: SupabaseClient, stripe: RefundStripe, input: { refundId?: string; chargeId?: string },
  alert: () => void = () => {}) {
  const scope = await resolveStripeScope(stripe as unknown as Stripe);
  const refunds = input.refundId ? [await stripe.refunds.retrieve(input.refundId)]
    : input.chargeId ? await listChargeRefunds(stripe, input.chargeId) : [];
  if (!refunds.length) return false;
  for (const refund of refunds) {
    if (refund.object !== 'refund' || (input.refundId && refund.id !== input.refundId)) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  const external = refunds.filter(refund => !refund.metadata?.refundIntentId);
  if (!external.length) return false;
  const chargeId = input.chargeId ?? id(refunds[0]!.charge);
  const paymentIntentId = id(refunds[0]!.payment_intent);
  if (refunds.some(refund => id(refund.charge) !== chargeId)) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  const match = await findCardOrderForPayment(db, stripe, scope, { chargeId, paymentIntentId });
  if (!match) {
    // A card order whose payment is not recorded yet: Stripe retries until the payment (and its reference) exists,
    // so the refund is never lost and the payment cannot be granted after it.
    if (await cardOrderAwaitingPayment(db, stripe, paymentIntentId ?? (chargeId
      ? id((await stripe.charges.retrieve(chargeId)).payment_intent) : null))) {
      throw new Error('PAY_STRIPE_MP_FIRST_PAYMENT_PENDING');
    }
    return false;
  }
  // Oldest first, so the refund that completes a full refund is the one that ends the order.
  for (const refund of [...external].sort((a, b) => a.created - b.created)) {
    if (refund.status !== 'succeeded') continue;
    const recorded = await db.rpc('pay_stripe_mp_record_external_refund', { p_order: match.order.id, p_merchant: scope.merchant,
      p_payment: match.paymentId, p_refund: refund.id, p_amount: refund.amount, p_currency: refund.currency,
      p_refunded_at: new Date(refund.created * 1000).toISOString() });
    if (recorded.error || !recorded.data) throw new Error('PAY_STRIPE_MP_REFUND_UNAVAILABLE', { cause: recorded.error });
    reportRefund(match.order.id, match.kind, refund.id, recorded.data as RefundResult, alert);
  }
  // A refund of ours in the same event still goes through its approval flow on the existing path.
  return external.length === refunds.length;
}

/** Every refund of the charge; an incomplete list fails the webhook (Stripe retries) instead of acknowledging it. */
async function listChargeRefunds(stripe: RefundStripe, chargeId: string) {
  const refunds: Stripe.Refund[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const rows = await stripe.refunds.list({ charge: chargeId, limit: 100, ...(after ? { starting_after: after } : {}) });
    refunds.push(...rows.data);
    if (!rows.has_more || !rows.data.length) return refunds;
    after = rows.data[rows.data.length - 1]!.id;
  }
  throw new Error('PAY_STRIPE_MP_REFUND_LIST_INCOMPLETE');
}

/** Alerts follow the persisted state, also on a replay: a delivery that crashed before alerting is alerted on retry. */
function reportRefund(orderId: string, kind: string, refundId: string, result: RefundResult, alert: () => void) {
  // Stable across replays of the same refund, so repeated alerts can be told apart from new ones.
  const dedupKey = `stripe-mp-external-refund:${result.state}:${orderId}:${refundId}`;
  if (result.state === 'partial_review') {
    logger.error('billing', 'stripe_mp_external_refund_partial', { orderId, kind, dedupKey, replay: result.duplicate,
      action: '部分外部退款：已记账，会员和积分未改动，请人工核对' });
    alert();
    return;
  }
  if (result.state === 'pack_review') {
    // Packs are not tracked per source yet: a person decides how many credits to take back (MASTER_PLAN item 47).
    logger.error('billing', 'stripe_mp_external_refund_pack', { orderId, dedupKey, replay: result.duplicate, packageId: result.packageId,
      packCredits: result.packCredits, balance: result.balance, action: '积分包已被外部全额退款：请按积分包积分和当前余额人工决定收回多少' });
    alert();
    return;
  }
  if (result.state !== 'refunded') return;
  if (result.creditsShortfall) logger.error('billing', 'stripe_mp_external_refund_shortfall', { orderId, kind,
    shortfall: result.creditsShortfall });
  if (result.renewing) {
    logger.error('billing', 'stripe_mp_external_refund_still_renewing', { orderId, kind, dedupKey, replay: result.duplicate,
      action: '该订阅仍在续费，请确认是否需要停续费' });
    alert();
  }
}

/** True when the payment belongs to a card order whose payment has not been recorded yet: a credit pack's
 * PaymentIntent, or a subscription invoice's subscription, names an order paid by card. */
async function cardOrderAwaitingPayment(db: Pick<SupabaseClient, 'from'>, stripe: RefundStripe, paymentIntentId: string | null) {
  if (!paymentIntentId) return false;
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  let orderId: string | null = intent.metadata?.orderId ?? null;
  if (!orderId) {
    const payments = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      status: 'paid', limit: 1 });
    const invoiceId = id(payments.data[0]?.invoice);
    const invoice = invoiceId ? await stripe.invoices.retrieve(invoiceId) : null;
    const subscriptionId = id(invoice?.parent?.subscription_details?.subscription);
    orderId = subscriptionId ? (await stripe.subscriptions.retrieve(subscriptionId)).metadata?.orderId ?? null : null;
  }
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return false;
  const order = await db.from('payment_orders').select('payment_method,payment_channel').eq('id', orderId).maybeSingle();
  if (order.error) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE', { cause: order.error });
  return order.data?.payment_channel === 'stripe' && ['card', 'card_cn'].includes(order.data.payment_method);
}

