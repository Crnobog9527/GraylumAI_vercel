/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { isStripeManagedSubscriptionActive } from './subscriptionOverrides';

export type MembershipLevel = 'free' | 'pro' | 'gold';

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

export type MembershipEligibilityReasonCode =
  | 'ALLOWED'
  | 'ACTIVE_SUBSCRIPTION_EXISTS'
  | 'CURRENT_PLAN'
  | 'UPGRADE_DOWNGRADE_UNSUPPORTED'
  | 'ENTITLEMENT_CONFLICT'
  | 'REFUNDED_ORDER_REQUIRES_POLICY'
  | 'PROFILE_MISSING'
  | 'READ_FAILED';

export type MembershipEligibilityResult = {
  allowed: boolean;
  state: EntitlementState;
  level: MembershipLevel;
  source: 'profile' | 'stripe_subscription' | 'payment_order' | 'admin_override' | 'none' | 'conflict';
  reasonCode: MembershipEligibilityReasonCode;
  safeMessage: string;
  diagnostics?: Record<string, unknown>;
};

type SupabaseLikeClient = {
  from(table: string): any;
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
  stripe_subscription_id?: string | null;
  status?: string | null;
  cancel_at_period_end?: string | boolean | null;
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
  targetLevel?: MembershipLevel | null;
};

const PAYMENT_ATTENTION_STATUSES = new Set(['past_due', 'incomplete', 'unpaid']);
const CANCELED_STATUSES = new Set(['canceled', 'cancelled']);

function normalizeMembershipLevel(value: unknown): MembershipLevel {
  return value === 'pro' || value === 'gold' ? value : 'free';
}

function normalizeStatus(value: unknown) {
  return typeof value === 'string' ? value.toLowerCase() : '';
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

function hasFullRefundSignal(order: PaymentOrderRow | null) {
  if (!order) {
    return false;
  }

  const status = normalizeStatus(order.status);
  if (status === 'refunded') {
    return true;
  }

  const metadata = asRecord(order.metadata);
  const refundMetadata = asRecord(
    metadata.stripeRefundReconciliation ??
    metadata.refundReconciliation ??
    metadata.refund,
  );

  return refundMetadata.isFullRefund === true ||
    refundMetadata.fullRefund === true ||
    refundMetadata.refundType === 'full';
}

function buildDiagnostics(subscription: SubscriptionRow | null, order: PaymentOrderRow | null) {
  return {
    subscriptionId: maskIdentifier(subscription?.stripe_subscription_id ?? null),
    subscriptionStatus: subscription?.status ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end ?? null,
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
  diagnostics?: Record<string, unknown>,
): MembershipEligibilityResult {
  return {
    allowed: true,
    state,
    level,
    source,
    reasonCode: 'ALLOWED',
    safeMessage: '允许操作',
    diagnostics,
  };
}

function deniedResult(params: {
  state: EntitlementState;
  level: MembershipLevel;
  source: MembershipEligibilityResult['source'];
  reasonCode: MembershipEligibilityReasonCode;
  safeMessage: string;
  diagnostics?: Record<string, unknown>;
}): MembershipEligibilityResult {
  return {
    allowed: false,
    ...params,
  };
}

function getManagedSubscriptionMessage(action: MembershipEligibilityAction) {
  if (action === 'admin_update_membership') {
    return '该用户存在有效的 Stripe 订阅，禁止在后台直接修改会员等级。请先通过订阅侧调整或取消后再处理。';
  }

  return '当前会员订阅仍有效，暂不支持重复购买或切换套餐。';
}

function getState(input: {
  profileLevel: MembershipLevel;
  latestSubscription: SubscriptionRow | null;
  latestMembershipOrder: PaymentOrderRow | null;
}): Omit<MembershipEligibilityResult, 'allowed' | 'reasonCode' | 'safeMessage'> {
  const { profileLevel, latestSubscription, latestMembershipOrder } = input;
  const diagnostics = buildDiagnostics(latestSubscription, latestMembershipOrder);

  if (hasFullRefundSignal(latestMembershipOrder) && profileLevel !== 'free') {
    return {
      state: 'refunded_requires_policy',
      level: profileLevel,
      source: 'payment_order',
      diagnostics,
    };
  }

  const subscriptionStatus = normalizeStatus(latestSubscription?.status);
  const hasStripeSubscription = Boolean(latestSubscription?.stripe_subscription_id);
  const isManagedActive = isStripeManagedSubscriptionActive({
    stripeSubscriptionId: latestSubscription?.stripe_subscription_id,
    status: latestSubscription?.status,
  });

  if (hasStripeSubscription && isManagedActive) {
    if (profileLevel === 'free') {
      return {
        state: 'inconsistent',
        level: profileLevel,
        source: 'conflict',
        diagnostics,
      };
    }

    if (PAYMENT_ATTENTION_STATUSES.has(subscriptionStatus)) {
      return {
        state: 'payment_attention',
        level: profileLevel,
        source: 'stripe_subscription',
        diagnostics,
      };
    }

    if (isTruthyText(latestSubscription?.cancel_at_period_end)) {
      return {
        state: 'cancel_at_period_end',
        level: profileLevel,
        source: 'stripe_subscription',
        diagnostics,
      };
    }

    return {
      state: 'active',
      level: profileLevel,
      source: 'stripe_subscription',
      diagnostics,
    };
  }

  if (hasStripeSubscription && CANCELED_STATUSES.has(subscriptionStatus)) {
    if (profileLevel !== 'free') {
      return {
        state: 'inconsistent',
        level: profileLevel,
        source: 'conflict',
        diagnostics,
      };
    }

    return {
      state: 'canceled',
      level: 'free',
      source: 'stripe_subscription',
      diagnostics,
    };
  }

  if (hasAdminOverride(latestSubscription) || profileLevel !== 'free') {
    return {
      state: 'admin_override',
      level: profileLevel,
      source: hasAdminOverride(latestSubscription) ? 'admin_override' : 'profile',
      diagnostics,
    };
  }

  return {
    state: 'free',
    level: 'free',
    source: 'profile',
    diagnostics,
  };
}

async function loadLatestMembershipFacts(supabase: SupabaseLikeClient, userId: string) {
  const [subscriptionResult, orderResult] = await Promise.all([
    supabase
      .from('user_subscriptions')
      .select('id, membership_plan_id, stripe_subscription_id, status, cancel_at_period_end, current_period_end, metadata')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('payment_orders')
      .select('id, status, payment_status, metadata')
      .eq('user_id', userId)
      .eq('item_type', 'membership_plan')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    latestSubscription: subscriptionResult.data as SubscriptionRow | null,
    latestMembershipOrder: orderResult.data as PaymentOrderRow | null,
    error: subscriptionResult.error ?? orderResult.error ?? null,
  };
}

function evaluateAction(input: {
  action: MembershipEligibilityAction;
  state: EntitlementState;
  level: MembershipLevel;
  source: MembershipEligibilityResult['source'];
  targetLevel: MembershipLevel | null;
  diagnostics?: Record<string, unknown>;
}) {
  const { action, state, level, source, targetLevel, diagnostics } = input;

  if (state === 'inconsistent') {
    return deniedResult({
      state,
      level,
      source,
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
      reasonCode: 'REFUNDED_ORDER_REQUIRES_POLICY',
      safeMessage: '该会员订单存在退款状态，需要人工确认后再操作。',
      diagnostics,
    });
  }

  if (action === 'create_credit_package_checkout') {
    return allowedResult(state, level, source, diagnostics);
  }

  if (action === 'admin_update_membership') {
    if (state === 'active' || state === 'payment_attention' || state === 'cancel_at_period_end') {
      return deniedResult({
        state,
        level,
        source,
        reasonCode: 'ACTIVE_SUBSCRIPTION_EXISTS',
        safeMessage: getManagedSubscriptionMessage(action),
        diagnostics,
      });
    }

    return allowedResult(state, level, source, diagnostics);
  }

  if (state === 'active' || state === 'payment_attention' || state === 'cancel_at_period_end') {
    return deniedResult({
      state,
      level,
      source,
      reasonCode: targetLevel && targetLevel === level ? 'CURRENT_PLAN' : 'UPGRADE_DOWNGRADE_UNSUPPORTED',
      safeMessage: getManagedSubscriptionMessage(action),
      diagnostics,
    });
  }

  if (state === 'admin_override') {
    return deniedResult({
      state,
      level,
      source,
      reasonCode: targetLevel && targetLevel === level ? 'CURRENT_PLAN' : 'UPGRADE_DOWNGRADE_UNSUPPORTED',
      safeMessage: '当前会员权益已存在，暂不支持自助重复购买或切换套餐。',
      diagnostics,
    });
  }

  return allowedResult(state, level, source, diagnostics);
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

  const profileLevel = normalizeMembershipLevel(input.profile.membership_level);
  const targetLevel = input.targetLevel ?? normalizeMembershipLevel(input.targetPlan?.level);

  if (input.action === 'create_credit_package_checkout' && profileLevel === 'free') {
    return allowedResult('free', 'free', 'profile');
  }

  const facts = await loadLatestMembershipFacts(input.supabase, input.userId);
  if (facts.error) {
    return deniedResult({
      state: 'inconsistent',
      level: profileLevel,
      source: 'conflict',
      reasonCode: 'READ_FAILED',
      safeMessage: '会员状态暂不可用，请稍后重试。',
      diagnostics: {
        errorCode: typeof facts.error?.code === 'string' ? facts.error.code : null,
      },
    });
  }

  const state = getState({
    profileLevel,
    latestSubscription: facts.latestSubscription,
    latestMembershipOrder: facts.latestMembershipOrder,
  });

  return evaluateAction({
    action: input.action,
    state: state.state,
    level: state.level,
    source: state.source,
    targetLevel,
    diagnostics: state.diagnostics,
  });
}
