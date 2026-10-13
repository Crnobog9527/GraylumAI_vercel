/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  getMembershipPlanButtonState, OLD_RENEWAL_BLOCKS_PURCHASE, SUBSCRIPTION_MANAGEMENT_HREF,
  type MembershipPlanEligibilityEntry,
} from './subscriptionPlanButtonState';

const entry = (action: MembershipPlanEligibilityEntry['action'], reasonCode: string, safeMessage: string) =>
  ({ planId: 'pro', billingCycle: 'monthly', allowed: false, action, reasonCode, safeMessage }) as MembershipPlanEligibilityEntry;

it('turns an old renewing subscription with a failed charge into a plain message and a way to stop it', () => {
  const state = getMembershipPlanButtonState({ eligibility: entry('resolvePaymentIssue', 'PAYMENT_ATTENTION_REQUIRED',
    '当前订阅存在付款异常，请先处理付款问题后再切换套餐。'), eligibilityLoading: false, checkoutReady: true, pending: false });
  expect(state).toMatchObject({ disabled: true, canCreateCheckout: false, canChangeSubscriptionPlan: false,
    label: '请先停止旧订阅', message: OLD_RENEWAL_BLOCKS_PURCHASE, manageSubscription: true });
  expect(OLD_RENEWAL_BLOCKS_PURCHASE).toContain('管理订阅 / 取消续费');
  expect(OLD_RENEWAL_BLOCKS_PURCHASE).toContain('提交工单'); // Waffo subscriptions have no self-service stop
  expect(SUBSCRIPTION_MANAGEMENT_HREF).toBe('/profile?tab=subscription');
});

it('keeps the server message and no subscription link for other refusals', () => {
  const state = getMembershipPlanButtonState({ eligibility: entry('contactSupport', 'ENTITLEMENT_CONFLICT',
    '会员状态存在冲突，请联系管理员处理后再操作。'), eligibilityLoading: false, checkoutReady: true, pending: false });
  expect(state.message).toBe('会员状态存在冲突，请联系管理员处理后再操作。');
  expect(state.manageSubscription).toBeUndefined();
});
