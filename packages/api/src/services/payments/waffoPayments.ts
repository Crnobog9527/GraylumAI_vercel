/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/** Only fields measured against the test store (#802 evidence). `createdAt` is Waffo's record time,
 * used solely inside the database time-window checks; it is not claimed as the PSP settlement time. */
export const WAFFO_PAYMENT_FIELDS = `id orderId status testMode orderMerchantExternalId periodNumber createdAt
  amount { amount currency } refundedAmount { amount currency } refundStatus isFullyRefunded
  pspAmountDetails { amount currency } paymentMethod { type }
  subscriptionOrder { id storeId status currentPeriodNumber currentPeriodStart currentPeriodEnd testMode
    orderMerchantExternalId subscriptionProduct { id } }`;

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const money = z.object({ amount: z.string(), currency: z.string() });
export const waffoPaymentSchema = z.object({
  id, orderId: id, status: z.string(), testMode: z.boolean(), orderMerchantExternalId: z.string().nullable(),
  periodNumber: z.number().int().positive().nullable(), createdAt: z.string().datetime(),
  amount: money, refundedAmount: money.nullable(), refundStatus: z.string().nullable(), isFullyRefunded: z.boolean().nullable(),
  pspAmountDetails: money.nullable(), paymentMethod: z.object({ type: z.string() }).nullable(),
  subscriptionOrder: z.object({
    id, storeId: z.string(), status: z.string(), currentPeriodNumber: z.number().int().positive().nullable(),
    currentPeriodStart: z.string().datetime().nullable(), currentPeriodEnd: z.string().datetime().nullable(),
    testMode: z.boolean(), orderMerchantExternalId: z.string().nullable(),
    subscriptionProduct: z.object({ id: z.string() }).nullable(),
  }).nullable(),
});
export type WaffoPayment = z.infer<typeof waffoPaymentSchema>;

export type WaffoTestPayments = {
  storeId: string;
  readPayment: (paymentId: string) => Promise<WaffoPayment | null>;
  /** One store-scoped page; `complete` is false when another page may exist. */
  listPayments: (offset: number) => Promise<{ rows: WaffoPayment[]; complete: boolean }>;
};

export type PaymentFacts = {
  paymentId: string; waffoOrderId: string; externalId: string | null; productId: string | null;
  amountCents: number; currency: 'usd'; createdAt: string; periodNumber: number;
  periodStart: string; periodEnd: string;
};
export type PaymentReading =
  | { kind: 'paid'; facts: PaymentFacts }
  | { kind: 'not_paid' }
  | { kind: 'unknown'; reason: string };

const cents = (value: string) => (/^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : null);
const majorToCents = (value: string) => {
  const match = /^([0-9]{1,7})\.([0-9]{2})$/.exec(value);
  return match ? Number(match[1]) * 100 + Number(match[2]) : null;
};

/** Normal path only. Anything missing or inconsistent is "unknown" for daily reconciliation;
 * catalog prices or nested metadata never fill a gap. */
export function readPaymentFacts(payment: WaffoPayment, storeId: string): PaymentReading {
  if (payment.status !== 'succeeded') return { kind: 'not_paid' };
  const order = payment.subscriptionOrder;
  if (!payment.testMode || !order || !order.testMode) return { kind: 'unknown', reason: 'test_mode_unproven' };
  if (order.storeId !== storeId || order.id !== payment.orderId) return { kind: 'unknown', reason: 'store_scope' };
  if (payment.paymentMethod?.type !== 'card') return { kind: 'unknown', reason: 'method_not_card' };
  const amount = cents(payment.amount.amount);
  if (amount === null || payment.amount.currency !== 'USD' || payment.pspAmountDetails?.currency !== 'USD'
    || majorToCents(payment.pspAmountDetails.amount) !== amount) return { kind: 'unknown', reason: 'amount_unproven' };
  if (payment.refundStatus !== 'none' || payment.isFullyRefunded !== false || payment.refundedAmount?.amount !== '0') {
    return { kind: 'unknown', reason: 'refund_observed' };
  }
  // A current period is this payment's period only when the numbers match; otherwise never infer one.
  if (!payment.periodNumber || payment.periodNumber !== order.currentPeriodNumber
    || !order.currentPeriodStart || !order.currentPeriodEnd) return { kind: 'unknown', reason: 'period_not_current' };
  return { kind: 'paid', facts: {
    paymentId: payment.id, waffoOrderId: payment.orderId, externalId: payment.orderMerchantExternalId,
    productId: order.subscriptionProduct?.id ?? null, amountCents: amount, currency: 'usd', createdAt: payment.createdAt,
    periodNumber: payment.periodNumber, periodStart: order.currentPeriodStart, periodEnd: order.currentPeriodEnd,
  } };
}
