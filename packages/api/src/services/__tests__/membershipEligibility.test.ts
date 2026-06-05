/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import { resolveMembershipEligibility } from '../membershipEligibility';

function createEligibilitySupabase(options: {
  subscription?: Record<string, unknown> | null;
  subscriptionError?: Record<string, unknown> | null;
  order?: Record<string, unknown> | null;
  orderError?: Record<string, unknown> | null;
}) {
  return {
    from(table: string) {
      const result = Promise.resolve(
        table === 'user_subscriptions'
          ? {
              data: options.subscription ?? null,
              error: options.subscriptionError ?? null,
            }
          : {
              data: options.order ?? null,
              error: options.orderError ?? null,
            },
      );

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
    });

    expect(result).toMatchObject({
      allowed: true,
      state: 'free',
      level: 'free',
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
      reasonCode: 'CURRENT_PLAN',
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
      reasonCode: 'UPGRADE_DOWNGRADE_UNSUPPORTED',
    });
  });

  it('returns refunded_requires_policy for paid profiles with full-refunded membership orders', async () => {
    const result = await resolveMembershipEligibility({
      supabase: createEligibilitySupabase({
        order: {
          id: 'order-1',
          status: 'refunded',
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
});
