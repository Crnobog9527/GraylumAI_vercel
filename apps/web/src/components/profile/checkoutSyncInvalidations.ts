/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { CHECKOUT_COPY } from '@/components/paywall/methodCheckout';

type InvalidateQuery = {
  invalidate: () => Promise<unknown> | unknown;
};

export type PostCheckoutInvalidationUtils = {
  user: {
    getUserProfile: InvalidateQuery;
    getEntitlements: InvalidateQuery;
  };
  credits: {
    getBalance: InvalidateQuery;
    getCreditsSummary: InvalidateQuery;
  };
  payments: {
    methodMembership: InvalidateQuery;
    getMembershipEligibilityMatrix: InvalidateQuery;
    listBillingRecords: InvalidateQuery;
  };
};

export function invalidatePostCheckoutMembershipQueries(utils: PostCheckoutInvalidationUtils) {
  return Promise.allSettled([
    utils.user.getUserProfile.invalidate(),
    // Credit packs unlock from this level; a stale `free` would keep a new member locked out.
    utils.user.getEntitlements.invalidate(),
    utils.credits.getBalance.invalidate(),
    utils.credits.getCreditsSummary.invalidate(),
    utils.payments.methodMembership.invalidate(),
    utils.payments.getMembershipEligibilityMatrix.invalidate(),
    utils.payments.listBillingRecords.invalidate(),
  ]);
}

/** Cancel-URL return: the server re-reads the session, which another tab may have paid in the meantime. */
export function canceledReturnNotice(
  result: { fulfilledAt?: string | null; orderStatus?: string | null; paymentStatus?: string | null } | null | undefined,
) {
  if (result?.fulfilledAt || result?.orderStatus === 'completed') {
    return { tone: 'success' as const, message: '这笔支付已经完成，订单状态已同步到账。' };
  }
  // Paid but held for review (e.g. a late payment after the reservation was released): charged, not delivered yet.
  if (result?.paymentStatus === 'paid') {
    return { tone: 'warning' as const, message: '这笔付款已经收到，订单正在核对，处理结果会在账单记录里更新。' };
  }
  // Stripe does not say why the user left; a mainland card refused by the international page is the common case.
  return { tone: 'cancelled' as const, message: `你已取消本次支付，没有发生扣费。${CHECKOUT_COPY.mainlandHint}` };
}
