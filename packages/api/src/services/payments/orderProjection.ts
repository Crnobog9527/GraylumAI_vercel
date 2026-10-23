/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { paymentAmountFactsSchema } from './contracts';
import { normalizePaymentOrderStatus, type PaymentOrderStatus } from '../paymentOrderStatus';

type Order = { payment_channel?: string | null; payment_mode?: string | null; payment_amount_facts?: unknown;
  refund_approval?: unknown };
type AmountFact = { kind: string; amount: string | null; currency: string; unit: 'major' };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const minorToMajor = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/**
 * The cash a Graylum-approved refund returned. Those refunds (monthly first purchase 0193/0253, credit pack) keep
 * their result on the order's refund approval and add no refund amount fact; only an external Stripe refund does
 * (0247). Display only: a succeeded approval with a recorded Stripe refund and an integer net amount, else nothing.
 */
export function approvedRefundFact(approval: unknown): AmountFact | null {
  const a = record(approval);
  if (!a || a.status !== 'succeeded') return null;
  const monthly = a.kind === 'monthly_first_purchase';
  const source = monthly ? record(a.terms) : a;
  const refunded = monthly ? record(a.recordedRefund)?.status === 'succeeded' && typeof record(a.recordedRefund)?.id === 'string'
    : typeof a.refundId === 'string' && a.refundId.length > 0;
  const net = source?.netMinor, currency = source?.currency;
  if (!refunded || typeof net !== 'number' || !Number.isSafeInteger(net) || net <= 0
    || typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) return null;
  return { kind: 'refund', amount: minorToMajor(net), currency, unit: 'major' };
}
type Documents = { documentStatus?: 'unknown'; invoicePdfUrl: string | null; hostedInvoiceUrl: string | null; receiptUrl: string | null };

function withApprovedRefund(facts: AmountFact[], approval: unknown): AmountFact[] {
  const refund = facts.some(fact => fact.kind === 'refund') ? null : approvedRefundFact(approval);
  return refund ? [...facts, refund] : facts;
}

export function projectOrderPayment(order: Order, documents?: Documents) {
  const channel = order.payment_channel === 'stripe' || order.payment_channel === 'waffo' ? order.payment_channel : null;
  const parsed = paymentAmountFactsSchema.safeParse(order.payment_amount_facts);
  return {
    paymentChannel: channel,
    paymentChannelLabel: channel === 'stripe' ? 'Stripe' : channel === 'waffo' ? 'Waffo' : '未知渠道',
    paymentMode: order.payment_mode === 'test' || order.payment_mode === 'live' ? order.payment_mode : null,
    // Never expose internal evidence references or infer unknown fees/net amounts as zero.
    amountFacts: parsed.success ? withApprovedRefund(parsed.data.map(({ kind, amount, currency, unit }) =>
      ({ kind, amount, currency, unit })), order.refund_approval) : [],
    documentSource: channel,
    documentStatus: !channel || documents?.documentStatus === 'unknown' || (channel === 'stripe' && !documents)
      ? 'unknown' as const
      : documents && (documents.invoicePdfUrl || documents.hostedInvoiceUrl || documents.receiptUrl)
        ? 'available' as const : 'unavailable' as const,
  };
}

type ClosedOrder = { status: string; payment_status?: string | null; fulfilled_at?: string | null;
  qualification_state?: string | null; purchase_closed_at?: string | null; method_review_reason?: string | null };

/** Display only. A failed wallet attempt remains reserved/pending so the same checkout can succeed on retry.
 * Released unpaid checkouts (0204/0211) stay pending for late-payment review but display as closed.
 * Any recorded payment or fulfilment takes the order out of either unpaid projection. */
export function projectBillingStatus(order: ClosedOrder): PaymentOrderStatus {
  const status = normalizePaymentOrderStatus(order.status);
  if (status !== 'pending' || order.payment_status !== 'unpaid' || order.fulfilled_at) return status;
  if (order.qualification_state === 'reserved' && !order.purchase_closed_at && order.method_review_reason === 'wallet_payment_failed') {
    return 'failed';
  }
  if (order.qualification_state !== 'released' || !order.purchase_closed_at) return status;
  return ['card_checkout_rejected', 'async_payment_failed'].includes(order.method_review_reason ?? '') ? 'failed' : 'expired';
}

export type BillingRecord = ReturnType<typeof projectOrderPayment> & {
  id: string;
  itemType: 'credit_package' | 'membership_plan';
  title: string;
  description: string;
  status: string;
  amountTotal: number;
  currency: string;
  billingCycle: 'one_time' | 'monthly' | 'yearly';
  createdAt: string;
  fulfilledAt: string | null;
  invoiceNumber: string | null;
  invoicePdfUrl: string | null;
  hostedInvoiceUrl: string | null;
  receiptUrl: string | null;
};

export type PaymentOrderBillingRow = {
  payment_method?: string | null;
  user_id?: string;
  payment_amount_facts?: unknown;
  refund_approval?: unknown;
  payment_channel?: string | null;
  merchant_namespace?: string | null;
  payment_mode?: string | null;
  price_ref_id?: string | null;
  subscription_id?: string | null;
  id: string;
  item_id: string;
  item_type: 'credit_package' | 'membership_plan' | string;
  billing_cycle: 'one_time' | 'monthly' | 'yearly' | null;
  stripe_checkout_session_id: string | null;
  stripe_invoice_id: string | null;
  amount_total: number | string | null;
  currency: string | null;
  status: string;
  payment_status: string | null;
  fulfilled_at: string | null;
  created_at: string;
  metadata?: Record<string, unknown> | null;
  qualification_state?: string | null;
  purchase_closed_at?: string | null;
  method_review_reason?: string | null;
};
