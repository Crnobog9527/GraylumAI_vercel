/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  invalidatePostCheckoutMembershipQueries,
  isFulfilledCheckoutSyncResult,
} from '../../../../../apps/web/src/components/profile/checkoutSyncInvalidations';

function createInvalidationUtils() {
  return {
    user: {
      getUserProfile: {
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
    },
    credits: {
      getBalance: {
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      getCreditsSummary: {
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
    },
    payments: {
      getMembershipEligibilityMatrix: {
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
      listBillingRecords: {
        invalidate: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

describe('invalidatePostCheckoutMembershipQueries', () => {
  it('invalidates membership eligibility after a successful checkout sync', async () => {
    const utils = createInvalidationUtils();

    await invalidatePostCheckoutMembershipQueries(utils);

    expect(utils.user.getUserProfile.invalidate).toHaveBeenCalledTimes(1);
    expect(utils.credits.getBalance.invalidate).toHaveBeenCalledTimes(1);
    expect(utils.credits.getCreditsSummary.invalidate).toHaveBeenCalledTimes(1);
    expect(utils.payments.getMembershipEligibilityMatrix.invalidate).toHaveBeenCalledTimes(1);
    expect(utils.payments.listBillingRecords.invalidate).toHaveBeenCalledTimes(1);
  });
});

describe('isFulfilledCheckoutSyncResult', () => {
  it('treats paid canceled-return sync results as fulfilled', () => {
    expect(isFulfilledCheckoutSyncResult({
      paymentStatus: 'paid',
      orderStatus: 'pending',
      fulfilledAt: null,
    })).toBe(true);
  });

  it('treats completed orders as fulfilled', () => {
    expect(isFulfilledCheckoutSyncResult({
      paymentStatus: 'unpaid',
      orderStatus: 'completed',
      fulfilledAt: null,
    })).toBe(true);
  });

  it('treats fulfilled timestamps as fulfilled', () => {
    expect(isFulfilledCheckoutSyncResult({
      paymentStatus: 'unpaid',
      orderStatus: 'pending',
      fulfilledAt: '2026-06-18T08:00:00.000Z',
    })).toBe(true);
  });

  it('does not treat open unpaid canceled returns as fulfilled', () => {
    expect(isFulfilledCheckoutSyncResult({
      paymentStatus: 'unpaid',
      orderStatus: 'canceled',
      fulfilledAt: null,
    })).toBe(false);
  });
});
