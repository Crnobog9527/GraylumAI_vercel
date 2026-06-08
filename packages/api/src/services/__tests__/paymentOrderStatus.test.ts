/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import {
  mergePaymentOrderStatus,
  normalizePaymentOrderStatus,
  resolveCheckoutSessionOrderStatus,
} from '../paymentOrderStatus';

describe('payment order status mapper', () => {
  it('keeps paid checkout sessions pending until fulfillment succeeds', () => {
    expect(
      resolveCheckoutSessionOrderStatus({
        status: 'complete',
        payment_status: 'paid',
      }),
    ).toBe('pending');
  });

  it('maps expired checkout sessions to an explicit terminal state', () => {
    expect(
      resolveCheckoutSessionOrderStatus({
        status: 'expired',
        payment_status: 'unpaid',
      }),
    ).toBe('expired');
  });

  it('normalizes legacy spelling to the canonical v1.5 status vocabulary', () => {
    expect(normalizePaymentOrderStatus('cancelled')).toBe('canceled');
    expect(normalizePaymentOrderStatus('partial_refunded')).toBe('partially_refunded');
  });

  it('preserves fulfilled and refund terminal states during checkout replays', () => {
    expect(
      mergePaymentOrderStatus({
        existingStatus: 'completed',
        fulfilledAt: '2026-06-07T09:30:00.000Z',
        nextStatus: 'pending',
      }),
    ).toBe('completed');

    expect(
      mergePaymentOrderStatus({
        existingStatus: 'partial_refunded',
        fulfilledAt: null,
        nextStatus: 'pending',
      }),
    ).toBe('partially_refunded');
  });
});
