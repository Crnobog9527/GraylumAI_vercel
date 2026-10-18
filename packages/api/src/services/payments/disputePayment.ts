/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type Stripe from 'stripe';
import type { StripeScope } from './purchaseFacts';
import { PAYMENT_EVIDENCE_CONFLICT } from './stripeWebhookError';

const id = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
export type CanonicalPayment = {
  paymentIntentId: string; chargeId: string; invoiceId: string | null; subscriptionId: string | null; paymentAt: string;
};

/** Resolve charge, invoice and Checkout evidence to the same scoped PaymentIntent before any transaction takes locks. */
export async function readDisputePayment(stripe: Stripe, scope: StripeScope,
  input: { chargeId?: string | null; paymentIntentId?: string | null; invoiceId?: string | null }): Promise<CanonicalPayment> {
  const live = scope.mode === 'live';
  let intentId = input.paymentIntentId ?? null;
  let invoiceId = input.invoiceId ?? null;
  if (!intentId && invoiceId) {
    const rows = await stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 10 });
    if (rows.has_more || rows.data.length !== 1 || rows.data[0]?.payment.type !== 'payment_intent') {
      throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    }
    intentId = id(rows.data[0].payment.payment_intent);
  }
  let charge = input.chargeId ? await stripe.charges.retrieve(input.chargeId) : null;
  if (!intentId && charge) intentId = id(charge.payment_intent);
  if (!intentId) {
    if (!charge) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    if (charge.object !== 'charge' || charge.id !== input.chargeId || charge.livemode !== live
      || !Number.isSafeInteger(charge.created) || charge.created <= 0) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    throw new Error('PAY_DISPUTE_PAYMENT_INTENT_MISSING');
  }
  if (!charge) {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    if (intent.object !== 'payment_intent' || intent.id !== intentId || intent.livemode !== live) {
      throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    }
    const chargeId = id(intent.latest_charge);
    if (!chargeId) throw new Error('PAY_DISPUTE_CHARGE_MISSING');
    charge = await stripe.charges.retrieve(chargeId);
  }
  if (charge.object !== 'charge' || charge.livemode !== live || id(charge.payment_intent) !== intentId
    || input.chargeId && charge.id !== input.chargeId || !Number.isSafeInteger(charge.created) || charge.created <= 0) {
    throw new Error(PAYMENT_EVIDENCE_CONFLICT);
  }
  if (!invoiceId) {
    const rows = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: intentId }, status: 'paid', limit: 10 });
    const invoices = [...new Set(rows.data.map(row => id(row.invoice)).filter((value): value is string => Boolean(value)))];
    if (rows.has_more || invoices.length > 1) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    invoiceId = invoices[0] ?? null;
  }
  let subscriptionId: string | null = null;
  if (invoiceId) {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    if (invoice.object !== 'invoice' || invoice.id !== invoiceId || invoice.livemode !== live) throw new Error(PAYMENT_EVIDENCE_CONFLICT);
    subscriptionId = id(invoice.parent?.subscription_details?.subscription);
  }
  return { paymentIntentId: intentId, chargeId: charge.id, invoiceId, subscriptionId,
    paymentAt: new Date(charge.created * 1000).toISOString() };
}
