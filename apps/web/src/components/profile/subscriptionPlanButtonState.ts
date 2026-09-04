/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

export type MembershipPlanEligibilityEntry = {
  planId: string;
  billingCycle: 'monthly' | 'yearly';
  allowed: boolean;
  action:
    | 'none'
    | 'createCheckoutSession'
    | 'createCreditPackageCheckout'
    | 'changeSubscriptionPlan'
    | 'resolvePaymentIssue'
    | 'contactSupport';
  reasonCode: string;
  safeMessage: string;
};

export type MembershipPlanButtonState = {
  disabled: boolean;
  label: string;
  canCreateCheckout: boolean;
  canChangeSubscriptionPlan: boolean;
  message: string | null;
};

export function getPlanEligibilityKey(planId: string, billingCycle: 'monthly' | 'yearly') {
  return `${planId}:${billingCycle}`;
}

export function getMembershipPlanButtonState(input: {
  eligibility: MembershipPlanEligibilityEntry | undefined;
  eligibilityLoading: boolean;
  checkoutReady: boolean;
  pending: boolean;
}): MembershipPlanButtonState {
  const { eligibility, eligibilityLoading, checkoutReady, pending } = input;

  if (pending) {
    return {
      disabled: true,
      label: '处理中...',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: null,
    };
  }

  if (eligibilityLoading || !eligibility) {
    return {
      disabled: true,
      label: '检查中...',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: '正在确认当前会员状态，请稍后再试。',
    };
  }

  if (eligibility.action === 'createCheckoutSession' && eligibility.allowed) {
    return {
      disabled: false,
      label: checkoutReady ? '立即订阅' : '联系我们',
      canCreateCheckout: checkoutReady,
      canChangeSubscriptionPlan: false,
      message: checkoutReady ? null : eligibility.safeMessage,
    };
  }

  if (eligibility.action === 'changeSubscriptionPlan') {
    return {
      disabled: !checkoutReady,
      label: checkoutReady ? '升级套餐' : '暂不可升级',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: checkoutReady,
      message: checkoutReady ? null : '该套餐暂不可升级，请稍后重试。',
    };
  }

  if (eligibility.reasonCode === 'RENEWAL_RESTORE_REQUIRED') {
    return { disabled: true, label: '请先恢复续费', canCreateCheckout: false,
      canChangeSubscriptionPlan: false, message: eligibility.safeMessage };
  }

  if (eligibility.action === 'resolvePaymentIssue') {
    return {
      disabled: true,
      label: '请先处理付款异常',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: eligibility.safeMessage,
    };
  }

  if (eligibility.reasonCode === 'CURRENT_PLAN') {
    return {
      disabled: true,
      label: '当前套餐',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: eligibility.safeMessage,
    };
  }

  if (eligibility.reasonCode === 'DOWNGRADE_NOT_ALLOWED') {
    return {
      disabled: true,
      label: '暂不支持降级',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: eligibility.safeMessage,
    };
  }

  return {
    disabled: true,
    label: '暂不可操作',
    canCreateCheckout: false,
    canChangeSubscriptionPlan: false,
    message: eligibility.safeMessage,
  };
}
