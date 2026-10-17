/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findStripeReference } from './stripeReferences';
import type { StripeScope } from './purchaseFacts';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;

export type CardPaymentOrder = {
  id: string; user_id: string; item_type: string; payment_method: 'card' | 'card_cn' | 'wechat_pay' | 'alipay'; subscription_id: string | null;
  source_order_id: string | null; amount_total: number; currency: string; fulfilled_at: string | null;
};
export type CardPaymentMatch = {
  order: CardPaymentOrder; paymentId: string; paymentIntentId: string;
  kind: 'pack' | 'subscription_first' | 'subscription_renewal' | 'wallet_membership';
};

/** PAY-STRIPE-MP shared lookup (external refunds now, disputes later): from a Stripe charge, PaymentIntent or invoice
 * to the card order that payment paid for. A card order records its payment as a 'payment' reference: the
 * PaymentIntent for a one-time credit pack, the invoice for a subscription period (first payment or renewal), which
 * is reached from the PaymentIntent through its invoice payment. Returns null when the payment is not a card order of
 * this merchant and mode (wallet, legacy subscription or off-site payment), so callers can leave it to other paths. */
export async function findCardOrderForPayment(db: Pick<SupabaseClient, 'from'>,
  stripe: Pick<Stripe, 'charges' | 'invoicePayments'>, scope: StripeScope,
  input: { chargeId?: string | null; paymentIntentId?: string | null; invoiceId?: string | null },
  // R7 (0298): external refunds also settle a wallet one-time membership; disputes and the rest still see card orders only.
  options: { includeWalletMembership?: boolean } = {}): Promise<CardPaymentMatch | null> {
  let paymentIntentId = input.paymentIntentId ?? null;
  if (!paymentIntentId && input.chargeId) {
    const charge = await stripe.charges.retrieve(input.chargeId);
    if (charge.object !== 'charge' || charge.id !== input.chargeId || charge.livemode !== (scope.mode === 'live')) {
      throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    }
    paymentIntentId = id(charge.payment_intent);
  }
  if (!paymentIntentId) return null;
  const candidates = input.invoiceId ? [input.invoiceId] : [];
  const direct = await findStripeReference(db, 'payment', paymentIntentId, scope);
  if (direct?.order_id) return loadMatch(db, scope, direct.order_id, paymentIntentId, paymentIntentId, options);
  if (!candidates.length) {
    // A subscription invoice is paid by a PaymentIntent; the invoice payment links the two (API 2025+).
    const payments = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId },
      status: 'paid', limit: 10 });
    for (const row of payments.data) { const invoice = id(row.invoice); if (invoice) candidates.push(invoice); }
  }
  for (const invoiceId of new Set(candidates)) {
    const ref = await findStripeReference(db, 'payment', invoiceId, scope);
    if (ref?.order_id) return loadMatch(db, scope, ref.order_id, invoiceId, paymentIntentId, options);
  }
  return null;
}

async function loadMatch(db: Pick<SupabaseClient, 'from'>, scope: StripeScope, orderId: string, paymentId: string,
  paymentIntentId: string, options: { includeWalletMembership?: boolean }): Promise<CardPaymentMatch | null> {
  const result = await db.from('payment_orders').select('id,user_id,item_type,payment_method,payment_channel,merchant_namespace,'
    + 'payment_mode,subscription_id,source_order_id,amount_total,currency,fulfilled_at').eq('id', orderId).maybeSingle();
  if (result.error || !result.data) throw new Error('PAY_WAFFO_PERSISTENCE_UNAVAILABLE', { cause: result.error });
  const order = result.data as unknown as CardPaymentOrder & { payment_channel: string; merchant_namespace: string;
    payment_mode: string };
  const wallet = options.includeWalletMembership === true && order.item_type === 'membership_plan'
    && (order.payment_method === 'wechat_pay' || order.payment_method === 'alipay');
  if (order.payment_method !== 'card' && order.payment_method !== 'card_cn' && !wallet) return null;
  if (order.payment_channel !== 'stripe' || order.merchant_namespace !== scope.merchant || order.payment_mode !== scope.mode) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  const kind = wallet ? 'wallet_membership' : order.item_type === 'credit_package' ? 'pack'
    : order.source_order_id ? 'subscription_renewal' : 'subscription_first';
  return { order, paymentId, paymentIntentId, kind };
}
