/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

type InvalidateQuery = {
  invalidate: () => Promise<unknown> | unknown;
};

export type PostCheckoutInvalidationUtils = {
  user: {
    getUserProfile: InvalidateQuery;
  };
  credits: {
    getBalance: InvalidateQuery;
    getCreditsSummary: InvalidateQuery;
  };
  payments: {
    getMembershipEligibilityMatrix: InvalidateQuery;
    listBillingRecords: InvalidateQuery;
  };
};

export function invalidatePostCheckoutMembershipQueries(utils: PostCheckoutInvalidationUtils) {
  return Promise.allSettled([
    utils.user.getUserProfile.invalidate(),
    utils.credits.getBalance.invalidate(),
    utils.credits.getCreditsSummary.invalidate(),
    utils.payments.getMembershipEligibilityMatrix.invalidate(),
    utils.payments.listBillingRecords.invalidate(),
  ]);
}
