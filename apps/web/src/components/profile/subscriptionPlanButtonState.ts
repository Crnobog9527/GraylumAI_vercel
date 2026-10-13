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
  /** Show a way to a support ticket (the only path that reliably clears an unpaid subscription). */
  contactSupport?: boolean;
};

/** Where an account opens a support ticket (个人中心 · 工单). */
export const SUPPORT_TICKET_HREF = '/profile?tab=tickets';

/**
 * The server refuses a new purchase while a subscription still has an unsuccessful payment (`resolvePaymentIssue`:
 * Stripe `past_due`, `unpaid`, or `incomplete`, i.e. a failed renewal or a failed first payment), so the user is not
 * charged twice. Cancelling in the Stripe portal only takes effect at period end, and eligibility checks the unpaid
 * state first, so "stop it yourself" would not unblock the purchase; support can settle or stop it. Say that plainly.
 */
export const UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE = '你还有一个付款没有成功的订阅（例如自动续费扣款失败）。'
  + '为避免重复扣费，暂时不能购买新的套餐。请提交工单，我们帮你停止这个订阅或补上付款，处理好后就能重新购买。';

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
      label: '请先处理旧订阅',
      canCreateCheckout: false,
      canChangeSubscriptionPlan: false,
      message: UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE,
      contactSupport: true,
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
