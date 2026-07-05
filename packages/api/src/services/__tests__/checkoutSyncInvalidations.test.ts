/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it, vi } from 'vitest';

import { invalidatePostCheckoutMembershipQueries } from '../../../../../apps/web/src/components/profile/checkoutSyncInvalidations';

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
