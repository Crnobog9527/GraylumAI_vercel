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
  /** Show a way to the subscription page (where the old subscription can be stopped). */
  manageSubscription?: boolean;
};

/** Where an account's subscription is managed or stopped (个人中心 · 订阅). */
export const SUBSCRIPTION_MANAGEMENT_HREF = '/profile?tab=subscription';

/**
 * The server refuses a new purchase while an older subscription still renews but its last charge failed
 * (`resolvePaymentIssue`), so the user is not charged twice. Say that plainly and point to where it is stopped.
 */
export const OLD_RENEWAL_BLOCKS_PURCHASE =
  '你还有一个续费中的旧订阅（最近一次自动扣款没有成功）。请先在订阅管理里点"管理订阅 / 取消续费"停止它，再重新购买。';

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
      label: '请先停止旧订阅',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: OLD_RENEWAL_BLOCKS_PURCHASE,
      manageSubscription: true,
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
