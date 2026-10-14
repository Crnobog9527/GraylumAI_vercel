/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  getMembershipPlanButtonState, SUPPORT_TICKET_HREF, UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE,
  type MembershipPlanEligibilityEntry,
} from './subscriptionPlanButtonState';

const entry = (action: MembershipPlanEligibilityEntry['action'], reasonCode: string, safeMessage: string) =>
  ({ planId: 'pro', billingCycle: 'monthly', allowed: false, action, reasonCode, safeMessage }) as MembershipPlanEligibilityEntry;

it('turns a subscription with an unsuccessful payment into a plain message and a support ticket', () => {
  const state = getMembershipPlanButtonState({ eligibility: entry('resolvePaymentIssue', 'PAYMENT_ATTENTION_REQUIRED',
    '当前订阅存在付款异常，请先处理付款问题后再切换套餐。'), eligibilityLoading: false, checkoutReady: true, pending: false });
  expect(state).toMatchObject({ disabled: true, canCreateCheckout: false, canChangeSubscriptionPlan: false,
    label: '请先处理旧订阅', message: UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE, contactSupport: true });
  // Also true for a failed first payment (Stripe `incomplete`), so it does not claim a renewal happened.
  expect(UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE).toContain('付款没有成功');
  // Portal cancellation only ends at period end, so the copy must not promise self-service stop then repurchase.
  expect(UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE).toContain('提交工单');
  expect(UNPAID_SUBSCRIPTION_BLOCKS_PURCHASE).not.toContain('管理订阅');
  expect(SUPPORT_TICKET_HREF).toBe('/profile?tab=tickets');
});

it('keeps the server message and no support link for other refusals', () => {
  const state = getMembershipPlanButtonState({ eligibility: entry('contactSupport', 'ENTITLEMENT_CONFLICT',
    '会员状态存在冲突，请联系管理员处理后再操作。'), eligibilityLoading: false, checkoutReady: true, pending: false });
  expect(state.message).toBe('会员状态存在冲突，请联系管理员处理后再操作。');
  expect(state.contactSupport).toBeUndefined();
});
