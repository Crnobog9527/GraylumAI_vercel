/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import { getMembershipPlanButtonState } from '../../../../../apps/web/src/components/profile/subscriptionPlanButtonState';

const baseEligibility = {
  planId: 'plan-pro',
  billingCycle: 'monthly' as const,
  state: 'active',
  currentLevel: 'pro',
  safeMessage: 'safe message',
};

describe('getMembershipPlanButtonState', () => {
  it('enables checkout only when backend eligibility allows createCheckoutSession and checkout config is ready', () => {
    const result = getMembershipPlanButtonState({
      eligibility: {
        ...baseEligibility,
        allowed: true,
        action: 'createCheckoutSession',
        reasonCode: 'ALLOWED',
      },
      eligibilityLoading: false,
      checkoutReady: true,
      pending: false,
    });

    expect(result).toEqual({
      disabled: false,
      label: '立即订阅',
      canCreateCheckout: true,
      canChangeSubscriptionPlan: false,
      message: null,
    });
  });

  it('keeps the button clickable for contact flow when checkout config is not ready', () => {
    const result = getMembershipPlanButtonState({
      eligibility: {
        ...baseEligibility,
        allowed: true,
        action: 'createCheckoutSession',
        reasonCode: 'ALLOWED',
      },
      eligibilityLoading: false,
      checkoutReady: false,
      pending: false,
    });

    expect(result).toEqual({
      disabled: false,
      label: '联系我们',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: 'safe message',
    });
  });

  it('enables only ready legal upgrades without Checkout', () => {
    const result = getMembershipPlanButtonState({
      eligibility: {
        ...baseEligibility,
        allowed: false,
        action: 'changeSubscriptionPlan',
        reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION',
      },
      eligibilityLoading: false,
      checkoutReady: true,
      pending: false,
    });

    expect(result).toMatchObject({
      disabled: false,
      label: '升级套餐',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: true,
    });
  });

  it.each([
    ['RENEWAL_RESTORE_REQUIRED', 'none', '请先恢复续费'],
    ['CURRENT_PLAN', 'none', '当前套餐'],
    ['DOWNGRADE_NOT_ALLOWED', 'none', '暂不支持降级'],
    ['PAYMENT_ATTENTION_REQUIRED', 'resolvePaymentIssue', '请先处理付款异常'],
  ] as const)('maps %s to the matching blocked label', (reasonCode, action, label) => {
    const result = getMembershipPlanButtonState({
      eligibility: {
        ...baseEligibility,
        allowed: false,
        action,
        reasonCode,
      },
      eligibilityLoading: false,
      checkoutReady: true,
      pending: false,
    });

    expect(result).toMatchObject({
      disabled: true,
      label,
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: 'safe message',
    });
  });
});
