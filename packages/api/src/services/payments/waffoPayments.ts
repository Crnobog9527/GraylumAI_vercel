/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/** Only fields measured against the test store (#802 evidence). `createdAt` is Waffo's record time,
 * used solely inside the database time-window checks; it is not claimed as the PSP settlement time. */
export const WAFFO_PAYMENT_FIELDS = `id orderId status testMode orderMerchantExternalId periodNumber createdAt
  amount { amount currency } refundedAmount { amount currency } refundStatus isFullyRefunded
  pspAmountDetails { amount currency } paymentMethod { type }
  onetimeOrder { id storeId status testMode orderMerchantExternalId onetimeProduct { id } }
  subscriptionOrder { id storeId status currentPeriodNumber currentPeriodStart currentPeriodEnd testMode
    orderMerchantExternalId subscriptionProduct { id } }`;

const id = z.string().regex(/^[A-Za-z0-9_:-]{1,160}$/);
const money = z.object({ amount: z.string(), currency: z.string() });
export const waffoPaymentSchema = z.object({
  id, orderId: id, status: z.string(), testMode: z.boolean(), orderMerchantExternalId: z.string().nullable(),
  periodNumber: z.number().int().positive().nullable(), createdAt: z.string().datetime(),
  amount: money, refundedAmount: money.nullable(), refundStatus: z.string().nullable(), isFullyRefunded: z.boolean().nullable(),
  pspAmountDetails: money.nullable(), paymentMethod: z.object({ type: z.string() }).nullable(),
  onetimeOrder: z.object({ id, storeId: z.string(), status: z.string(), testMode: z.boolean(),
    orderMerchantExternalId: z.string().nullable(), onetimeProduct: z.object({ id: z.string() }).nullable(),
  }).nullable().optional(),
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
  amountCents: number; currency: 'usd'; createdAt: string; periodNumber: number | null;
  periodStart: string | null; periodEnd: string | null;
  purchaseMode: 'payment' | 'subscription'; method: 'card' | 'alipay' | 'unknown';
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
export function readPaymentFacts(payment: WaffoPayment, storeId: string, mode: 'test' | 'live' = 'test'): PaymentReading {
  if (payment.status !== 'succeeded') return { kind: 'not_paid' };
  const oneTime = payment.onetimeOrder;
  const order = oneTime ?? payment.subscriptionOrder;
  if (payment.testMode !== (mode === 'test') || !order || order.testMode !== (mode === 'test')) {
    return { kind: 'unknown', reason: 'test_mode_unproven' };
  }
  if (oneTime && (payment.subscriptionOrder || payment.periodNumber !== null
    || oneTime.orderMerchantExternalId !== payment.orderMerchantExternalId)) {
    return { kind: 'unknown', reason: 'purchase_mode_conflict' };
  }
  if (order.storeId !== storeId || order.id !== payment.orderId) return { kind: 'unknown', reason: 'store_scope' };
  if (!oneTime && payment.paymentMethod?.type !== 'card') return { kind: 'unknown', reason: 'method_not_card' };
  const amount = cents(payment.amount.amount);
  if (amount === null || payment.amount.currency !== 'USD' || payment.pspAmountDetails?.currency !== 'USD'
    || majorToCents(payment.pspAmountDetails.amount) !== amount) return { kind: 'unknown', reason: 'amount_unproven' };
  if (payment.refundStatus !== 'none' || payment.isFullyRefunded !== false
    || payment.refundedAmount?.amount !== '0' || payment.refundedAmount?.currency !== 'USD') {
    return { kind: 'unknown', reason: 'refund_observed' };
  }
  if (oneTime) return { kind: 'paid', facts: {
    paymentId: payment.id, waffoOrderId: payment.orderId, externalId: payment.orderMerchantExternalId,
    productId: oneTime.onetimeProduct?.id ?? null, amountCents: amount, currency: 'usd', createdAt: payment.createdAt,
    periodNumber: null, periodStart: null, periodEnd: null, purchaseMode: 'payment',
    method: payment.paymentMethod?.type === 'card' ? 'card' : payment.paymentMethod?.type === 'alipay' ? 'alipay' : 'unknown',
  } };
  const subscription = payment.subscriptionOrder!;
  // A current period is this payment's period only when the numbers match; otherwise never infer one.
  if (!payment.periodNumber || payment.periodNumber !== subscription.currentPeriodNumber
    || !subscription.currentPeriodStart || !subscription.currentPeriodEnd) return { kind: 'unknown', reason: 'period_not_current' };
  return { kind: 'paid', facts: {
    paymentId: payment.id, waffoOrderId: payment.orderId, externalId: payment.orderMerchantExternalId,
    productId: subscription.subscriptionProduct?.id ?? null, amountCents: amount, currency: 'usd', createdAt: payment.createdAt,
    purchaseMode: 'subscription', method: 'card',
    periodNumber: payment.periodNumber, periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd,
  } };
}
