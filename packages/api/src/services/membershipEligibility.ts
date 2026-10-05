/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { STRIPE_MANAGED_ACTIVE_SUBSCRIPTION_STATUSES } from './subscriptionOverrides';
import { isRefundPaymentOrderStatus } from './paymentOrderStatus';

export type MembershipLevel = 'free' | 'pro' | 'gold';
export type EligibilityLevel = MembershipLevel | 'unknown';
export type MembershipBillingCycle = 'monthly' | 'yearly';

export type EntitlementState =
  | 'free'
  | 'active'
  | 'payment_attention'
  | 'cancel_at_period_end'
  | 'canceled'
  | 'admin_override'
  | 'refunded_requires_policy'
  | 'inconsistent';

export type MembershipEligibilityAction =
  | 'create_membership_checkout'
  | 'create_credit_package_checkout'
  | 'admin_update_membership';

export type MembershipEligibilityNextAction =
  | 'none'
  | 'createCheckoutSession'
  | 'createCreditPackageCheckout'
  | 'changeSubscriptionPlan'
  | 'resolvePaymentIssue'
  | 'contactSupport';

export type MembershipEligibilityReasonCode =
  | 'ALLOWED'
  | 'ACTIVE_SUBSCRIPTION_EXISTS'
  | 'CURRENT_PLAN'
  | 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION'
  | 'RENEWAL_RESTORE_REQUIRED'
  | 'DOWNGRADE_NOT_ALLOWED'
  | 'PAYMENT_ATTENTION_REQUIRED'
  | 'UPGRADE_DOWNGRADE_UNSUPPORTED'
  | 'ENTITLEMENT_CONFLICT'
  | 'REFUNDED_ORDER_REQUIRES_POLICY'
  | 'UNSUPPORTED_MEMBERSHIP_LEVEL'
  | 'PROFILE_MISSING'
  | 'READ_FAILED';

export type MembershipEligibilityResult = {
  allowed: boolean;
  state: EntitlementState;
  level: EligibilityLevel;
  source: 'profile' | 'stripe_subscription' | 'payment_order' | 'admin_override' | 'none' | 'conflict';
  action: MembershipEligibilityNextAction;
  reasonCode: MembershipEligibilityReasonCode;
  safeMessage: string;
  diagnostics?: Record<string, unknown>;
};

type SupabaseLikeClient = {
  rpc(name: string, args: Record<string, unknown>): any;
};

type ProfileSnapshot = {
  membership_level?: string | null;
};

type MembershipPlanSnapshot = {
  id?: string | null;
  level?: string | null;
};

type SubscriptionRow = {
  id?: string | null;
  membership_plan_id?: string | null;
  payment_channel?: string | null;
  mapping_state?: string | null;
  status?: string | null;
  cancel_at_period_end?: string | boolean | null;
  billing_cycle?: string | null;
  current_period_end?: string | null;
  metadata?: unknown;
};

type PaymentOrderRow = {
  id?: string | null;
  status?: string | null;
  payment_status?: string | null;
  metadata?: unknown;
};

type ResolveMembershipEligibilityInput = {
  supabase: SupabaseLikeClient;
  userId: string;
  profile: ProfileSnapshot | null | undefined;
  action: MembershipEligibilityAction;
  targetPlan?: MembershipPlanSnapshot | null;
  targetLevel?: string | null;
  targetBillingCycle?: MembershipBillingCycle | null;
};

type EntitlementSnapshot = {
  state: EntitlementState;
  level: MembershipLevel;
  billingCycle: MembershipBillingCycle | null;
  source: MembershipEligibilityResult['source'];
  diagnostics?: Record<string, unknown>;
};

const PAYMENT_ATTENTION_STATUSES = new Set(['past_due', 'incomplete', 'unpaid']);
const CANCELED_STATUSES = new Set(['canceled', 'cancelled']);
const MEMBERSHIP_LEVEL_RANK: Record<MembershipLevel, number> = {
  free: 0,
  pro: 1,
  gold: 2,
};

type PlanTransition = 'purchase' | 'current' | 'upgrade' | 'downgrade';

function parseMembershipLevel(value: unknown): {
  level: MembershipLevel;
  unsupportedValue: string | null;
} {
  if (value === null || value === undefined || value === '') {
    return { level: 'free', unsupportedValue: null };
  }

  if (value === 'free' || value === 'pro' || value === 'gold') {
    return { level: value, unsupportedValue: null };
  }

  return {
    level: 'free',
    unsupportedValue: String(value).slice(0, 80),
  };
}

function normalizeStatus(value: unknown) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function normalizeBillingCycle(value: unknown): MembershipBillingCycle | null {
  return value === 'monthly' || value === 'yearly' ? value : null;
}

function isTruthyText(value: unknown) {
  return value === true || value === 'true';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function maskIdentifier(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value.length <= 12) {
    return `${value.slice(0, 4)}...`;
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function hasAdminOverride(subscription: SubscriptionRow | null) {
  if (!subscription) {
    return false;
  }

  const metadata = asRecord(subscription.metadata);
  return normalizeStatus(subscription.status) === 'admin_override' || Boolean(metadata.adminOverride);
}

function isManagedCurrentSubscription(subscription: SubscriptionRow | null) {
  return subscription?.payment_channel === 'stripe' && subscription.mapping_state === 'mapped'
    && STRIPE_MANAGED_ACTIVE_SUBSCRIPTION_STATUSES.some(status => status === normalizeStatus(subscription.status));
}

function normalizeSubscriptionRows(value: unknown): SubscriptionRow[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter(Boolean) as SubscriptionRow[];
  }

  return [value as SubscriptionRow];
}

function selectEntitlementSubscription(candidates: SubscriptionRow[]) {
  const uncertain = candidates.find(row => !['none', 'mapped'].includes(row.mapping_state ?? ''));
  if (uncertain) return uncertain;
  const managed = candidates.filter(isManagedCurrentSubscription);
  if (managed.length > 1) return { ...managed[0], mapping_state: 'unknown' };
  return managed[0] ?? candidates[0] ?? null;
}

function hasFullRefundSignal(order: PaymentOrderRow | null) {
  if (!order) {
    return false;
  }

  if (isRefundPaymentOrderStatus(order.status) || isRefundPaymentOrderStatus(order.payment_status)) {
    return true;
  }

  const metadata = asRecord(order.metadata);
  const refundMetadataCandidates = [
    metadata.stripeRefundReconciliation,
    metadata.subscriptionCreditGrantReversal,
    metadata.refundReconciliation,
    metadata.refund,
  ].map(asRecord);

  return refundMetadataCandidates.some((refundMetadata) =>
    refundMetadata.isFullRefund === true ||
    refundMetadata.fullRefund === true ||
    refundMetadata.reviewRequired === true ||
    refundMetadata.refundType === 'full',
  );
}

function buildDiagnostics(subscription: SubscriptionRow | null, order: PaymentOrderRow | null) {
  return {
    subscriptionId: maskIdentifier(subscription?.id ?? null),
    subscriptionStatus: subscription?.status ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? null,
    billingCycle: subscription?.billing_cycle ?? null,
    membershipPlanId: maskIdentifier(subscription?.membership_plan_id ?? null),
    orderId: maskIdentifier(order?.id ?? null),
    orderStatus: order?.status ?? null,
    paymentStatus: order?.payment_status ?? null,
  };
}

function allowedResult(
  state: EntitlementState,
  level: MembershipLevel,
  source: MembershipEligibilityResult['source'],
  action: MembershipEligibilityNextAction,
  diagnostics?: Record<string, unknown>,
): MembershipEligibilityResult {
  return {
    allowed: true,
    state,
    level,
    source,
    action,
    reasonCode: 'ALLOWED',
    safeMessage: '允许操作',
    diagnostics,
  };
}

function deniedResult(params: {
  state: EntitlementState;
  level: EligibilityLevel;
  source: MembershipEligibilityResult['source'];
  action?: MembershipEligibilityNextAction;
  reasonCode: MembershipEligibilityReasonCode;
  safeMessage: string;
  diagnostics?: Record<string, unknown>;
}): MembershipEligibilityResult {
  return {
    allowed: false,
    ...params,
    action: params.action ?? 'none',
  };
}

function isCurrentOrUnknownPeriodEnd(value: unknown) {
  if (!value || typeof value !== 'string') {
    return true;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return true;
  }

  return timestamp > Date.now();
}

function getManagedSubscriptionMessage(action: MembershipEligibilityAction) {
  if (action === 'admin_update_membership') {
    return '该用户存在有效的 Stripe 订阅，禁止在后台直接修改会员等级。请先通过订阅侧调整或取消后再处理。';
  }

  return '当前会员订阅仍有效，暂不支持重复购买或切换套餐。';
}

function getUpgradeRequiredMessage() {
  return '当前会员订阅仍有效，请通过升级套餐调整现有订阅，不会创建新的 Checkout。';
}

function getDowngradeBlockedMessage(state: EntitlementState) {
  if (state === 'cancel_at_period_end') {
    return '当前权益在本周期结束前仍有效，暂不支持降级。';
  }

  return '当前会员有效，暂不支持降级。';
}

function getCurrentPlanMessage(state: EntitlementState) {
  if (state === 'cancel_at_period_end') {
    return '当前权益在本周期结束前仍有效，无需重复购买同一套餐。';
  }

  return '当前套餐仍有效，无需重复购买。';
}

function classifyPlanTransition(input: {
  currentLevel: MembershipLevel;
  currentBillingCycle: MembershipBillingCycle | null;
  targetLevel: MembershipLevel | null;
  targetBillingCycle: MembershipBillingCycle | null;
}): PlanTransition {
  const { currentLevel, currentBillingCycle, targetLevel, targetBillingCycle } = input;

  if (!targetLevel) {
    return 'purchase';
  }

  if (currentLevel === 'free') {
    return targetLevel === 'free' ? 'current' : 'purchase';
  }

  const currentRank = MEMBERSHIP_LEVEL_RANK[currentLevel];
  const targetRank = MEMBERSHIP_LEVEL_RANK[targetLevel];

  if (targetRank > currentRank) {
    if (currentBillingCycle === 'yearly' && targetBillingCycle === 'monthly') {
      return 'downgrade';
    }

    return 'upgrade';
  }

  if (targetRank < currentRank) {
    return 'downgrade';
  }

  if (currentBillingCycle && targetBillingCycle) {
    if (currentBillingCycle === targetBillingCycle) {
      return 'current';
    }

    return currentBillingCycle === 'monthly' && targetBillingCycle === 'yearly'
      ? 'upgrade'
      : 'downgrade';
  }

  return 'current';
}

export function getState(input: {
  profileLevel: MembershipLevel;
  latestSubscription: SubscriptionRow | null;
  latestMembershipOrder: PaymentOrderRow | null;
}): EntitlementSnapshot {
  const { profileLevel, latestSubscription, latestMembershipOrder } = input;
  const diagnostics = buildDiagnostics(latestSubscription, latestMembershipOrder);

  if (hasFullRefundSignal(latestMembershipOrder)) {
      return {
        state: 'refunded_requires_policy',
        level: profileLevel,
        billingCycle: normalizeBillingCycle(latestSubscription?.billing_cycle),
        source: 'payment_order',
        diagnostics,
      };
  }

  const subscriptionStatus = normalizeStatus(latestSubscription?.status);
  if (latestSubscription && (latestSubscription.mapping_state === 'unknown'
    || !['none', 'mapped'].includes(latestSubscription.mapping_state ?? '')
    || latestSubscription.mapping_state === 'mapped' && latestSubscription.payment_channel !== 'stripe'
    || latestSubscription.mapping_state === 'none' && latestSubscription.payment_channel != null)) {
    return { state: 'inconsistent', level: profileLevel,
      billingCycle: normalizeBillingCycle(latestSubscription.billing_cycle), source: 'conflict', diagnostics };
  }
  const hasStripeSubscription = latestSubscription?.payment_channel === 'stripe' && latestSubscription.mapping_state === 'mapped';
  const isManagedActive = isManagedCurrentSubscription(latestSubscription);

  if (hasStripeSubscription && isManagedActive) {
    if (profileLevel === 'free') {
        return {
          state: 'inconsistent',
          level: profileLevel,
          billingCycle: normalizeBillingCycle(latestSubscription?.billing_cycle),
          source: 'conflict',
          diagnostics,
        };
    }

    if (PAYMENT_ATTENTION_STATUSES.has(subscriptionStatus)) {
        return {
          state: 'payment_attention',
          level: profileLevel,
          billingCycle: normalizeBillingCycle(latestSubscription?.billing_cycle),
          source: 'stripe_subscription',
          diagnostics,
        };
    }

    if (isTruthyText(latestSubscription?.cancel_at_period_end)) {
      if (!isCurrentOrUnknownPeriodEnd(latestSubscription?.current_period_end)) {
        return {
          state: 'inconsistent',
          level: profileLevel,
          billingCycle: normalizeBillingCycle(latestSubscription?.billing_cycle),
          source: 'conflict',
          diagnostics,
        };
      }

        return {
          state: 'cancel_at_period_end',
          level: profileLevel,
          billingCycle: normalizeBillingCycle(latestSubscription?.billing_cycle),
          source: 'stripe_subscription',
          diagnostics,
        };
    }

    return {
      state: 'active',
      level: profileLevel,
      billingCycle: normalizeBillingCycle(latestSubscription?.billing_cycle),
      source: 'stripe_subscription',
      diagnostics,
    };
  }

  if (hasStripeSubscription && CANCELED_STATUSES.has(subscriptionStatus)) {
    if (profileLevel !== 'free') {
        return {
          state: 'inconsistent',
          level: profileLevel,
          billingCycle: normalizeBillingCycle(latestSubscription?.billing_cycle),
          source: 'conflict',
          diagnostics,
        };
    }

    return {
      state: 'canceled',
      level: 'free',
      billingCycle: null,
      source: 'stripe_subscription',
      diagnostics,
    };
  }

  if (profileLevel !== 'free') {
    return {
      state: 'admin_override',
      level: profileLevel,
      billingCycle: null,
      source: hasAdminOverride(latestSubscription) ? 'admin_override' : 'profile',
      diagnostics,
    };
  }

  return {
    state: 'free',
    level: 'free',
    billingCycle: null,
    source: 'profile',
    diagnostics,
  };
}

export async function loadLatestMembershipFacts(supabase: SupabaseLikeClient, userId: string) {
  const result = await supabase.rpc('pay_common_membership_facts', { p_user_id: userId });
  const facts = asRecord(result.data);
  const valid = Array.isArray(facts.subscriptions) && Object.hasOwn(facts, 'latest_order');
  return {
    latestSubscription: valid ? selectEntitlementSubscription(normalizeSubscriptionRows(facts.subscriptions)) : null,
    latestMembershipOrder: valid ? facts.latest_order as PaymentOrderRow | null : null,
    error: result.error ?? (valid ? null : new Error('PAY_COMMON_MEMBERSHIP_FACTS_UNKNOWN')),
  };
}

export function evaluateAction(input: {
  action: MembershipEligibilityAction;
  state: EntitlementState;
  level: MembershipLevel;
  billingCycle: MembershipBillingCycle | null;
  source: MembershipEligibilityResult['source'];
  targetLevel: MembershipLevel | null;
  targetBillingCycle: MembershipBillingCycle | null;
  diagnostics?: Record<string, unknown>;
}) {
  const {
    action,
    state,
    level,
    billingCycle,
    source,
    targetLevel,
    targetBillingCycle,
    diagnostics,
  } = input;

  if (state === 'inconsistent') {
    return deniedResult({
      state,
      level,
      source,
      action: 'contactSupport',
      reasonCode: 'ENTITLEMENT_CONFLICT',
      safeMessage: '会员状态存在冲突，请联系管理员处理后再操作。',
      diagnostics,
    });
  }

  if (state === 'refunded_requires_policy') {
    return deniedResult({
      state,
      level,
      source,
      action: 'contactSupport',
      reasonCode: 'REFUNDED_ORDER_REQUIRES_POLICY',
      safeMessage: '该会员订单存在退款状态，需要人工确认后再操作。',
      diagnostics,
    });
  }

  if (action === 'create_credit_package_checkout') {
    return allowedResult(state, level, source, 'createCreditPackageCheckout', diagnostics);
  }

  if (action === 'admin_update_membership') {
    if (state === 'active' || state === 'payment_attention' || state === 'cancel_at_period_end') {
      return deniedResult({
        state,
        level,
        source,
        action: 'none',
        reasonCode: 'ACTIVE_SUBSCRIPTION_EXISTS',
        safeMessage: getManagedSubscriptionMessage(action),
        diagnostics,
      });
    }

    return allowedResult(state, level, source, 'none', diagnostics);
  }

  if (state === 'payment_attention') {
    return deniedResult({
      state,
      level,
      source,
      action: 'resolvePaymentIssue',
      reasonCode: 'PAYMENT_ATTENTION_REQUIRED',
      safeMessage: '当前订阅存在付款异常，请先处理付款问题后再切换套餐。',
      diagnostics,
    });
  }

  const transition = classifyPlanTransition({
    currentLevel: level,
    currentBillingCycle: billingCycle,
    targetLevel,
    targetBillingCycle,
  });

  if (state === 'active' || state === 'cancel_at_period_end') {
    if (transition === 'upgrade' && state === 'cancel_at_period_end') {
      return deniedResult({ state, level, source, reasonCode: 'RENEWAL_RESTORE_REQUIRED',
        safeMessage: '已安排到期取消，请先通过订阅管理恢复续费后再升级套餐。', diagnostics });
    }
    if (transition === 'upgrade') {
      return deniedResult({
        state,
        level,
        source,
        action: 'changeSubscriptionPlan',
        reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION',
        safeMessage: getUpgradeRequiredMessage(),
        diagnostics,
      });
    }

    if (transition === 'downgrade') {
      return deniedResult({
        state,
        level,
        source,
        action: 'none',
        reasonCode: 'DOWNGRADE_NOT_ALLOWED',
        safeMessage: getDowngradeBlockedMessage(state),
        diagnostics,
      });
    }

    return deniedResult({
      state,
      level,
      source,
      action: 'none',
      reasonCode: 'CURRENT_PLAN',
      safeMessage: getCurrentPlanMessage(state),
      diagnostics,
    });
  }

  if (state === 'admin_override') {
    return deniedResult({
      state,
      level,
      source,
      action: 'none',
      reasonCode: transition === 'current' ? 'CURRENT_PLAN' : 'UPGRADE_DOWNGRADE_UNSUPPORTED',
      safeMessage: '当前会员权益已存在，暂不支持自助重复购买或切换套餐。',
      diagnostics,
    });
  }

  if (transition === 'current') {
    return deniedResult({
      state,
      level,
      source,
      action: 'none',
      reasonCode: 'CURRENT_PLAN',
      safeMessage: getCurrentPlanMessage(state),
      diagnostics,
    });
  }

  if (transition === 'downgrade') {
    return deniedResult({
      state,
      level,
      source,
      action: 'none',
      reasonCode: 'DOWNGRADE_NOT_ALLOWED',
      safeMessage: getDowngradeBlockedMessage(state),
      diagnostics,
    });
  }

  return allowedResult(state, level, source, 'createCheckoutSession', diagnostics);
}

export async function resolveMembershipEligibility(
  input: ResolveMembershipEligibilityInput,
): Promise<MembershipEligibilityResult> {
  if (!input.profile) {
    return deniedResult({
      state: 'inconsistent',
      level: 'free',
      source: 'conflict',
      reasonCode: 'PROFILE_MISSING',
      safeMessage: '用户资料不存在，无法确认会员状态。',
    });
  }

  const targetLevel = input.targetLevel ?? input.targetPlan?.level ?? null;
  const parsedProfileLevel = parseMembershipLevel(input.profile.membership_level);
  if (parsedProfileLevel.unsupportedValue) {
    return deniedResult({
      state: 'inconsistent',
      level: 'unknown',
      source: 'conflict',
      reasonCode: 'UNSUPPORTED_MEMBERSHIP_LEVEL',
      safeMessage: '会员等级状态暂不支持，请联系管理员处理后再操作。',
      diagnostics: {
        unsupportedProfileLevel: parsedProfileLevel.unsupportedValue,
      },
    });
  }

  const parsedTargetLevel = parseMembershipLevel(targetLevel);
  if (targetLevel !== null && targetLevel !== undefined && parsedTargetLevel.unsupportedValue) {
    return deniedResult({
      state: 'inconsistent',
      level: parsedProfileLevel.level,
      source: 'conflict',
      reasonCode: 'UNSUPPORTED_MEMBERSHIP_LEVEL',
      safeMessage: '目标会员等级暂不支持，请联系管理员处理后再操作。',
      diagnostics: {
        unsupportedTargetLevel: parsedTargetLevel.unsupportedValue,
      },
    });
  }

  const facts = await loadLatestMembershipFacts(input.supabase, input.userId);
  if (facts.error) {
    return deniedResult({
      state: 'inconsistent',
      level: parsedProfileLevel.level,
      source: 'conflict',
      reasonCode: 'READ_FAILED',
      safeMessage: '会员状态暂不可用，请稍后重试。',
      diagnostics: {
        errorCode: typeof facts.error?.code === 'string' ? facts.error.code : null,
      },
    });
  }

  const state = getState({
    profileLevel: parsedProfileLevel.level,
    latestSubscription: facts.latestSubscription,
    latestMembershipOrder: facts.latestMembershipOrder,
  });

  return evaluateAction({
    action: input.action,
    state: state.state,
    level: state.level,
    billingCycle: state.billingCycle,
    source: state.source,
    targetLevel: targetLevel === null || targetLevel === undefined ? null : parsedTargetLevel.level,
    targetBillingCycle: input.targetBillingCycle ?? null,
    diagnostics: state.diagnostics,
  });
}
