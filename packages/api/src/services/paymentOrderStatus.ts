/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type Stripe from 'stripe';

export const PAYMENT_ORDER_STATUSES = [
  'pending',
  'completed',
  'failed',
  'canceled',
  'expired',
  'refunded',
  'partially_refunded',
] as const;

export type PaymentOrderStatus = (typeof PAYMENT_ORDER_STATUSES)[number];

export type LegacyPaymentOrderStatus = 'cancelled' | 'partial_refunded';

export type PaymentOrderStatusLike = PaymentOrderStatus | LegacyPaymentOrderStatus | string | null | undefined;

const CANONICAL_STATUSES = new Set<string>(PAYMENT_ORDER_STATUSES);

const LEGACY_STATUS_MAP: Record<LegacyPaymentOrderStatus, PaymentOrderStatus> = {
  cancelled: 'canceled',
  partial_refunded: 'partially_refunded',
};

const DURABLE_TERMINAL_STATUSES = new Set<PaymentOrderStatus>([
  'completed',
  'refunded',
  'partially_refunded',
]);

const FAILURE_TERMINAL_STATUSES = new Set<PaymentOrderStatus>([
  'failed',
  'canceled',
  'expired',
]);

export function normalizePaymentOrderStatus(status: PaymentOrderStatusLike): PaymentOrderStatus {
  const normalizedStatus = typeof status === 'string'
    ? status.trim().toLowerCase()
    : status;

  if (normalizedStatus === 'cancelled' || normalizedStatus === 'partial_refunded') {
    return LEGACY_STATUS_MAP[normalizedStatus];
  }

  if (typeof normalizedStatus === 'string' && CANONICAL_STATUSES.has(normalizedStatus)) {
    return normalizedStatus as PaymentOrderStatus;
  }

  return 'pending';
}

export function isTerminalPaymentOrderStatus(status: PaymentOrderStatusLike) {
  return normalizePaymentOrderStatus(status) !== 'pending';
}

export function isRefundPaymentOrderStatus(status: PaymentOrderStatusLike) {
  const normalizedStatus = normalizePaymentOrderStatus(status);
  return normalizedStatus === 'refunded' || normalizedStatus === 'partially_refunded';
}

export function mergePaymentOrderStatus(input: {
  existingStatus?: PaymentOrderStatusLike;
  fulfilledAt?: string | null;
  nextStatus: PaymentOrderStatusLike;
}): PaymentOrderStatus {
  const existingStatus = normalizePaymentOrderStatus(input.existingStatus);
  const nextStatus = normalizePaymentOrderStatus(input.nextStatus);

  if (input.fulfilledAt && nextStatus === 'pending') {
    return 'completed';
  }

  if (DURABLE_TERMINAL_STATUSES.has(existingStatus)) {
    return existingStatus;
  }

  if (FAILURE_TERMINAL_STATUSES.has(existingStatus) && nextStatus === 'pending') {
    return existingStatus;
  }

  if (existingStatus === 'completed' && FAILURE_TERMINAL_STATUSES.has(nextStatus)) {
    return 'completed';
  }

  return nextStatus;
}

export function resolveCheckoutSessionOrderStatus(
  session: Pick<Stripe.Checkout.Session, 'payment_status' | 'status'>,
  options: { orderStatus?: PaymentOrderStatusLike } = {},
): PaymentOrderStatus {
  if (options.orderStatus) {
    return normalizePaymentOrderStatus(options.orderStatus);
  }

  if (session.status === 'expired') {
    return 'expired';
  }

  return 'pending';
}
