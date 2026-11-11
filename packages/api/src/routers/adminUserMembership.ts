/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { resolveMembershipEligibility, type MembershipEligibilityResult } from '../services/membershipEligibility';
import { ADMIN_PROFILE_COLUMNS, recordAdminActivity } from '../services/adminUserAccess';
import { createAdminOperationError } from './adminShared';

function throwMembershipEligibilityError(result: MembershipEligibilityResult): never {
  throw new TRPCError({
    code: result.reasonCode === 'READ_FAILED' ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST',
    message: result.safeMessage,
  });
}

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminUserMembershipProcedures = {
  /**
   * Update user membership level
   */
  updateUserMembership: adminProcedure
    .input(z.object({
      userId: z.string().uuid(),
      membershipLevel: z.enum(['free', 'pro', 'gold']),
      reason: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get current membership
      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('membership_level, nickname, email')
        .eq('id', input.userId)
        .single();

      if (profileError || !profile) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const previousLevel = profile.membership_level;
      const overrideTimestamp = new Date().toISOString();

      const eligibility = await resolveMembershipEligibility({
        supabase: ctx.supabase,
        userId: input.userId,
        profile,
        action: 'admin_update_membership',
        targetLevel: input.membershipLevel,
      });

      if (!eligibility.allowed) {
        throwMembershipEligibilityError(eligibility);
      }

      const { data: latestSubscription, error: latestSubscriptionError } = await ctx.supabase
        .from('user_subscriptions')
        .select('id, metadata, stripe_subscription_id, status')
        .eq('user_id', input.userId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestSubscriptionError) {
        throw createAdminOperationError('更新用户会员等级', latestSubscriptionError);
      }

      let targetPlanId: string | null = null;
      if (latestSubscription?.id) {
        if (input.membershipLevel !== 'free') {
          const { data: targetPlan, error: targetPlanError } = await ctx.supabase
            .from('membership_plans')
            .select('id')
            .eq('level', input.membershipLevel)
            .eq('is_active', 'true')
            .order('sort_order', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (targetPlanError) {
            throw createAdminOperationError('更新用户会员等级', targetPlanError);
          }

          targetPlanId = targetPlan?.id ?? null;
        }
      }

      // Update membership level only after all guard and lookup checks pass.
      const { data, error } = await ctx.supabase
        .from('profiles')
        .update({ membership_level: input.membershipLevel })
        .eq('id', input.userId)
        .select(ADMIN_PROFILE_COLUMNS)
        .single();

      if (error) {
        throw createAdminOperationError('更新用户会员等级', error);
      }

      if (latestSubscription?.id) {
        const metadata = latestSubscription.metadata && typeof latestSubscription.metadata === 'object'
          ? latestSubscription.metadata
          : {};

        const { error: subscriptionSyncError } = await ctx.supabase
          .from('user_subscriptions')
          .update({
            membership_plan_id: targetPlanId,
            status: 'admin_override',
            updated_at: overrideTimestamp,
            metadata: {
              ...metadata,
              adminOverride: {
                adminId: ctx.profileId,
                overriddenAt: overrideTimestamp,
                previousLevel,
                newLevel: input.membershipLevel,
                reason: input.reason ?? null,
              },
            },
          })
          .eq('id', latestSubscription.id);

        if (subscriptionSyncError) {
          throw createAdminOperationError('更新用户会员等级', subscriptionSyncError);
        }
      }

      // Log the activity
      const auditRecorded = await recordAdminActivity(ctx.supabase, {
        user_id: input.userId,
        admin_id: ctx.profileId,
        action: `会员等级变更: ${previousLevel} → ${input.membershipLevel}`,
        action_type: 'membership_change',
        details: {
          previousLevel,
          newLevel: input.membershipLevel,
          reason: input.reason,
        },
      });

      return { ...data, auditRecorded };
    }),
};
