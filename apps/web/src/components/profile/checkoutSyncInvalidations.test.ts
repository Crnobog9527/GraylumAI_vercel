/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { canceledReturnNotice, invalidatePostCheckoutMembershipQueries } from './checkoutSyncInvalidations';

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

it('does not tell a user who paid in another tab that nothing was charged', () => {
  expect(canceledReturnNotice({ fulfilledAt: '2026-10-13T00:00:00.000Z', orderStatus: 'completed' }).tone).toBe('success');
  expect(canceledReturnNotice({ fulfilledAt: null, orderStatus: 'completed' }).tone).toBe('success');
  expect(canceledReturnNotice({ fulfilledAt: null, orderStatus: 'canceled' })).toEqual({ tone: 'cancelled', message: '你已取消本次支付，没有发生扣费。' });
  expect(canceledReturnNotice(undefined).tone).toBe('cancelled');
});
