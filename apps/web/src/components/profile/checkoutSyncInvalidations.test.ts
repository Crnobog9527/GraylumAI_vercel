/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { invalidatePostCheckoutMembershipQueries } from './checkoutSyncInvalidations';

it('refreshes the entitlement level after checkout, so a new member can buy credit packs at once', async () => {
  const query = () => ({ invalidate: vi.fn() });
  const utils = {
    user: { getUserProfile: query(), getEntitlements: query() },
    credits: { getBalance: query(), getCreditsSummary: query() },
    payments: { getMembershipEligibilityMatrix: query(), listBillingRecords: query() },
  };
  await invalidatePostCheckoutMembershipQueries(utils);
  expect(utils.user.getEntitlements.invalidate).toHaveBeenCalledTimes(1);
  expect(utils.user.getUserProfile.invalidate).toHaveBeenCalledTimes(1);
});
