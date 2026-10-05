/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { paymentAmountFactsSchema } from './contracts';

type Order = { payment_channel?: string | null; payment_mode?: string | null; payment_amount_facts?: unknown };
type Documents = { invoicePdfUrl: string | null; hostedInvoiceUrl: string | null; receiptUrl: string | null };

export function projectOrderPayment(order: Order, documents?: Documents) {
  const channel = order.payment_channel === 'stripe' || order.payment_channel === 'waffo' ? order.payment_channel : null;
  const parsed = paymentAmountFactsSchema.safeParse(order.payment_amount_facts);
  return {
    paymentChannel: channel,
    paymentChannelLabel: channel === 'stripe' ? 'Stripe' : channel === 'waffo' ? 'Waffo' : '未知渠道',
    paymentMode: order.payment_mode === 'test' || order.payment_mode === 'live' ? order.payment_mode : null,
    // Never expose internal evidence references or infer unknown fees/net amounts as zero.
    amountFacts: parsed.success ? parsed.data.map(({ kind, amount, currency, unit }) => ({ kind, amount, currency, unit })) : [],
    documentSource: channel,
    documentStatus: !channel ? 'unknown' as const
      : documents && (documents.invoicePdfUrl || documents.hostedInvoiceUrl || documents.receiptUrl)
        ? 'available' as const : 'unavailable' as const,
  };
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
  user_id?: string;
  payment_amount_facts?: unknown;
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
};
