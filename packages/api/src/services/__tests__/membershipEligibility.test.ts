/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import { resolveMembershipEligibility } from '../membershipEligibility';

function createEligibilitySupabase(options: {
  subscription?: Record<string, unknown> | Record<string, unknown>[] | null;
  subscriptionError?: Record<string, unknown> | null;
  order?: Record<string, unknown> | null;
  orderError?: Record<string, unknown> | null;
}) {
  const subscriptionResult = Promise.resolve({
    data: Array.isArray(options.subscription)
      ? options.subscription
      : options.subscription
        ? [options.subscription]
        : [],
    error: options.subscriptionError ?? null,
  });
  const orderResult = Promise.resolve({
    data: options.order ?? null,
    error: options.orderError ?? null,
  });

  return {
    from(table: string) {
      const result = table === 'user_subscriptions' ? subscriptionResult : orderResult;

      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        order() {
          return this;
        },
        limit() {
          return this;
        },
        maybeSingle() {
          return result;
        },
        then: result.then.bind(result),
        catch: result.catch.bind(result),
        finally: result.finally.bind(result),
      };
    },
  };
}

describe('resolveMembershipEligibility', () => {
  it('allows free users with no active subscription to create a membership checkout', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({}),
      userId: 'user-1',
      profile: { membership_level: 'free' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
      targetBillingCycle: 'monthly',
    });

    expect(result).toMatchObject({
      allowed: true,
      state: 'free',
      level: 'free',
      action: 'createCheckoutSession',
      reasonCode: 'ALLOWED',
    });
  });

  it('allows free users to create checkout for Pro or Gold plans', async () => {
    for (const targetLevel of ['pro', 'gold'] as const) {
      const result = await resolveMembershipEligibility({
        supabase: createEligibilitySupabase({}),
        userId: 'user-1',
        profile: { membership_level: 'free' },
        action: 'create_membership_checkout',
        targetPlan: { id: `plan-${targetLevel}`, level: targetLevel },
        targetBillingCycle: 'yearly',
      });

      expect(result).toMatchObject({
        allowed: true,
        state: 'free',
        level: 'free',
        action: 'createCheckoutSession',
        reasonCode: 'ALLOWED',
      });
    }
  });

  it.each([
    [
      'status marker',
      {
        id: 'sub-row-admin-status',
        status: 'admin_override',
        metadata: {},
      },
    ],
    [
      'metadata marker',
      {
        id: 'sub-row-admin-metadata',
        status: 'inactive',
        metadata: { adminOverride: { adminId: 'admin-1' } },
      },
    ],
  ])('allows free users with a stale admin override %s to create a membership checkout', async (_caseName, subscription) => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription,
      }),
      userId: 'user-1',
      profile: { membership_level: 'free' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: true,
      state: 'free',
      level: 'free',
      source: 'profile',
      reasonCode: 'ALLOWED',
    });
  });

  it('blocks duplicate checkout for the current active Stripe-managed subscription', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-1',
          membership_plan_id: 'plan-pro',
          stripe_subscription_id: 'sub_test_active',
          status: 'active',
          cancel_at_period_end: 'false',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'active',
      level: 'pro',
      source: 'stripe_subscription',
      action: 'none',
      reasonCode: 'CURRENT_PLAN',
    });
  });

  it.each(['monthly', 'yearly'] as const)(
    'marks Pro monthly to Gold %s as an upgrade that must use changeSubscriptionPlan',
    async (targetBillingCycle) => {
      const result = await resolveMembershipEligibility({
        supabase: createEligibilitySupabase({
          subscription: {
            id: 'sub-row-1',
            membership_plan_id: 'plan-pro',
            stripe_subscription_id: 'sub_test_active',
            status: 'active',
            billing_cycle: 'monthly',
            cancel_at_period_end: 'false',
          },
        }),
        userId: 'user-1',
        profile: { membership_level: 'pro' },
        action: 'create_membership_checkout',
        targetPlan: { id: 'plan-gold', level: 'gold' },
        targetBillingCycle,
      });

      expect(result).toMatchObject({
        allowed: false,
        state: 'active',
        level: 'pro',
        action: 'changeSubscriptionPlan',
        reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION',
      });
      expect(result.safeMessage).toContain('changeSubscriptionPlan');
    },
  );

  it('blocks Pro monthly to Pro yearly checkout as an upgrade that must use changeSubscriptionPlan', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-1',
          membership_plan_id: 'plan-pro',
          stripe_subscription_id: 'sub_test_active',
          status: 'active',
          billing_cycle: 'monthly',
          cancel_at_period_end: 'false',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
      targetBillingCycle: 'yearly',
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'active',
      level: 'pro',
      action: 'changeSubscriptionPlan',
      reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION',
    });
  });

  it('blocks Gold to Pro as a downgrade', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-1',
          membership_plan_id: 'plan-gold',
          stripe_subscription_id: 'sub_test_active',
          status: 'active',
          billing_cycle: 'monthly',
          cancel_at_period_end: 'false',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'gold' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
      targetBillingCycle: 'monthly',
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'active',
      level: 'gold',
      action: 'none',
      reasonCode: 'DOWNGRADE_NOT_ALLOWED',
    });
  });

  it.each([
    ['Pro monthly', 'pro', 'monthly'],
    ['Pro yearly', 'pro', 'yearly'],
    ['Gold monthly', 'gold', 'monthly'],
    ['Gold yearly', 'gold', 'yearly'],
  ] as const)('blocks Gold yearly to %s checkout', async (_caseName, targetLevel, targetBillingCycle) => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-1',
          membership_plan_id: 'plan-gold',
          stripe_subscription_id: 'sub_test_active',
          status: 'active',
          billing_cycle: 'yearly',
          cancel_at_period_end: 'false',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'gold' },
      action: 'create_membership_checkout',
      targetPlan: { id: `plan-${targetLevel}`, level: targetLevel },
      targetBillingCycle,
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'active',
      level: 'gold',
      action: 'none',
      reasonCode: targetLevel === 'gold' && targetBillingCycle === 'yearly'
        ? 'CURRENT_PLAN'
        : 'DOWNGRADE_NOT_ALLOWED',
    });
  });

  it('prefers an active Stripe-managed subscription over a newer canceled history row for paid profiles', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: [
          {
            id: 'sub-row-canceled-newer',
            stripe_subscription_id: 'sub_test_old_canceled',
            status: 'canceled',
            cancel_at_period_end: 'false',
          },
          {
            id: 'sub-row-active-older',
            membership_plan_id: 'plan-pro',
            stripe_subscription_id: 'sub_test_active',
            status: 'active',
            cancel_at_period_end: 'false',
          },
        ],
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'active',
      level: 'pro',
      source: 'stripe_subscription',
      reasonCode: 'CURRENT_PLAN',
    });
  });

  it('allows credit package checkout for paid active users when a newer canceled history row exists', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: [
          {
            id: 'sub-row-canceled-newer',
            stripe_subscription_id: 'sub_test_old_canceled',
            status: 'canceled',
          },
          {
            id: 'sub-row-active-older',
            stripe_subscription_id: 'sub_test_active',
            status: 'active',
            cancel_at_period_end: 'false',
          },
        ],
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_credit_package_checkout',
    });

    expect(result).toMatchObject({
      allowed: true,
      state: 'active',
      level: 'pro',
      source: 'stripe_subscription',
      reasonCode: 'ALLOWED',
    });
  });

  it('fails closed for free profiles when an active subscription is older than a canceled history row', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: [
          {
            id: 'sub-row-canceled-newer',
            stripe_subscription_id: 'sub_test_old_canceled',
            status: 'canceled',
          },
          {
            id: 'sub-row-active-older',
            stripe_subscription_id: 'sub_test_active',
            status: 'active',
            cancel_at_period_end: 'false',
          },
        ],
      }),
      userId: 'user-1',
      profile: { membership_level: 'free' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'inconsistent',
      level: 'free',
      source: 'conflict',
      reasonCode: 'ENTITLEMENT_CONFLICT',
    });
  });

  it('prefers cancel-at-period-end subscriptions over newer canceled history rows', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: [
          {
            id: 'sub-row-canceled-newer',
            stripe_subscription_id: 'sub_test_old_canceled',
            status: 'canceled',
          },
          {
            id: 'sub-row-canceling-older',
            membership_plan_id: 'plan-pro',
            stripe_subscription_id: 'sub_test_canceling',
            status: 'active',
            cancel_at_period_end: 'true',
          },
        ],
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'cancel_at_period_end',
      level: 'pro',
      source: 'stripe_subscription',
      action: 'none',
      reasonCode: 'CURRENT_PLAN',
    });
  });

  it('treats cancel-at-period-end before period end as active and only exposes upgrade action', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-canceling',
          membership_plan_id: 'plan-pro',
          stripe_subscription_id: 'sub_test_canceling',
          status: 'active',
          billing_cycle: 'monthly',
          cancel_at_period_end: 'true',
          current_period_end: '2099-01-01T00:00:00.000Z',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-gold', level: 'gold' },
      targetBillingCycle: 'monthly',
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'cancel_at_period_end',
      level: 'pro',
      action: 'changeSubscriptionPlan',
      reasonCode: 'UPGRADE_REQUIRES_CHANGE_SUBSCRIPTION',
    });
  });

  it('fails closed when a cancel-at-period-end subscription is past the current period but profile is still paid', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-expired-canceling',
          membership_plan_id: 'plan-pro',
          stripe_subscription_id: 'sub_test_canceling',
          status: 'active',
          billing_cycle: 'monthly',
          cancel_at_period_end: 'true',
          current_period_end: '2000-01-01T00:00:00.000Z',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-gold', level: 'gold' },
      targetBillingCycle: 'monthly',
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'inconsistent',
      level: 'pro',
      action: 'contactSupport',
      reasonCode: 'ENTITLEMENT_CONFLICT',
    });
  });

  it('keeps paid admin overrides as an existing entitlement and blocks duplicate checkout', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-admin-paid',
          status: 'admin_override',
          metadata: { adminOverride: { adminId: 'admin-1' } },
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'admin_override',
      level: 'pro',
      source: 'admin_override',
      reasonCode: 'CURRENT_PLAN',
    });
  });

  it('fails closed for credit package checkout when a free profile has an active Stripe subscription', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-1',
          stripe_subscription_id: 'sub_test_active',
          status: 'active',
          cancel_at_period_end: 'false',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'free' },
      action: 'create_credit_package_checkout',
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'inconsistent',
      level: 'free',
      source: 'conflict',
      reasonCode: 'ENTITLEMENT_CONFLICT',
    });
  });

  it('keeps payment-attention subscriptions managed and blocks plan switches', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-1',
          membership_plan_id: 'plan-pro',
          stripe_subscription_id: 'sub_test_past_due',
          status: 'past_due',
          cancel_at_period_end: 'false',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-gold', level: 'gold' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'payment_attention',
      level: 'pro',
      action: 'resolvePaymentIssue',
      reasonCode: 'PAYMENT_ATTENTION_REQUIRED',
    });
  });

  it.each(['past_due', 'incomplete', 'unpaid'] as const)(
    'blocks %s subscriptions until the payment issue is resolved',
    async (status) => {
      const result = await resolveMembershipEligibility({
        supabase: createEligibilitySupabase({
          subscription: {
            id: `sub-row-${status}`,
            membership_plan_id: 'plan-pro',
            stripe_subscription_id: `sub_test_${status}`,
            status,
            billing_cycle: 'monthly',
            cancel_at_period_end: 'false',
          },
        }),
        userId: 'user-1',
        profile: { membership_level: 'pro' },
        action: 'create_membership_checkout',
        targetPlan: { id: 'plan-gold', level: 'gold' },
        targetBillingCycle: 'yearly',
      });

      expect(result).toMatchObject({
        allowed: false,
        state: 'payment_attention',
        level: 'pro',
        action: 'resolvePaymentIssue',
        reasonCode: 'PAYMENT_ATTENTION_REQUIRED',
      });
    },
  );

  it('prefers payment-attention subscriptions over newer canceled history rows', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: [
          {
            id: 'sub-row-canceled-newer',
            stripe_subscription_id: 'sub_test_old_canceled',
            status: 'canceled',
          },
          {
            id: 'sub-row-past-due-older',
            membership_plan_id: 'plan-pro',
            stripe_subscription_id: 'sub_test_past_due',
            status: 'past_due',
            cancel_at_period_end: 'false',
          },
        ],
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-gold', level: 'gold' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'payment_attention',
      level: 'pro',
      source: 'stripe_subscription',
      action: 'resolvePaymentIssue',
      reasonCode: 'PAYMENT_ATTENTION_REQUIRED',
    });
  });

  it('returns refunded_requires_policy when payment_status is refunded even if order status is not', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        order: {
          id: 'order-1',
          status: 'completed',
          payment_status: 'refunded',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'gold' },
      action: 'admin_update_membership',
      targetLevel: 'free',
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'refunded_requires_policy',
      level: 'gold',
      source: 'payment_order',
      reasonCode: 'REFUNDED_ORDER_REQUIRES_POLICY',
    });
  });

  it('fails closed for unsupported profile membership levels', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({}),
      userId: 'user-1',
      profile: { membership_level: 'legacy_platinum' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'inconsistent',
      level: 'unknown',
      source: 'conflict',
      reasonCode: 'UNSUPPORTED_MEMBERSHIP_LEVEL',
    });
  });

  it('fails closed for unsupported target plan membership levels', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({}),
      userId: 'user-1',
      profile: { membership_level: 'free' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-legacy', level: 'legacy_platinum' },
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'inconsistent',
      level: 'free',
      source: 'conflict',
      reasonCode: 'UNSUPPORTED_MEMBERSHIP_LEVEL',
    });
  });

  it('fails closed when a paid profile only has a canceled Stripe subscription', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: {
          id: 'sub-row-1',
          stripe_subscription_id: 'sub_test_canceled',
          status: 'canceled',
        },
      }),
      userId: 'user-1',
      profile: { membership_level: 'pro' },
      action: 'admin_update_membership',
      targetLevel: 'gold',
    });

    expect(result).toMatchObject({
      allowed: false,
      state: 'inconsistent',
      reasonCode: 'ENTITLEMENT_CONFLICT',
    });
  });

  it('allows membership checkout for free profiles when only canceled subscription history exists', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        subscription: [
          {
            id: 'sub-row-canceled-only',
            stripe_subscription_id: 'sub_test_canceled',
            status: 'canceled',
          },
        ],
      }),
      userId: 'user-1',
      profile: { membership_level: 'free' },
      action: 'create_membership_checkout',
      targetPlan: { id: 'plan-pro', level: 'pro' },
    });

    expect(result).toMatchObject({
      allowed: true,
      state: 'canceled',
      level: 'free',
      source: 'stripe_subscription',
      reasonCode: 'ALLOWED',
    });
  });
});
