/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { refreshStripeTestClockUser } from './payments/stripeTestClock';
import { evaluateAction, getState, loadLatestMembershipFacts } from './membershipEligibility';
import {
  entitlementRowShape, FUSION_COMPARE_SETTING, fusionCompareLimitSchema, membershipLevelSchema,
  publishMonitorEntitlementShape, type MembershipLevel,
} from './membershipEntitlementConfig';

const profileSchema = z.object({
  membership_level: membershipLevelSchema,
  status: z.literal('active'),
  is_deleted: z.literal('false'),
});
const planSchema = z.object({ id: z.string(), level: membershipLevelSchema, ...entitlementRowShape });
const publishPlanSchema = z.object(publishMonitorEntitlementShape);
const PUBLISH_COLUMNS = 'allow_publish,own_data_window_days,allow_benchmark_monitor,allow_weekly_auto_review';
const PUBLISH_CLOSED = Object.freeze({ allow_publish: false, own_data_window_days: 0,
  allow_benchmark_monitor: false, allow_weekly_auto_review: false });

function unavailable(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'ENTITLEMENTS_UNAVAILABLE' });
}

async function readPlan(client: SupabaseClient, level: MembershipLevel) {
  // is_active is a catalog/checkout switch, not revocation of previously granted membership.
  const { data, error } = await client.from('membership_plans')
    .select('id,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,positioning_profile_limit')
    .eq('level', level).limit(2);
  const parsed = z.array(planSchema).length(1).safeParse(data);
  if (error || !parsed.success) unavailable();
  return parsed.data[0]!;
}

async function resolveCurrentMembership(client: SupabaseClient, profileId: string) {
  // All callers provide the server-owned admin client. User-scoped eligibility remains strictly read-only.
  await refreshStripeTestClockUser(client, profileId);
  const [profileResult, facts] = await Promise.all([
    client.from('profiles').select('membership_level,status,is_deleted').eq('id', profileId).single(),
    loadLatestMembershipFacts(client, profileId),
  ]);
  if (profileResult.error || facts.error) unavailable();
  const profile = profileSchema.safeParse(profileResult.data);
  if (!profile.success) {
    if (profileResult.data && (profileResult.data.status !== 'active' || profileResult.data.is_deleted !== 'false')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'ENTITLEMENTS_ACCOUNT_UNAVAILABLE' });
    }
    unavailable();
  }
  const snapshot = getState({ profileLevel: profile.data.membership_level, ...facts });
  let state = snapshot.state;
  let level: MembershipLevel = ['active', 'cancel_at_period_end', 'admin_override'].includes(state)
    ? snapshot.level : 'free';
  let plan = await readPlan(client, level);
  if (['active', 'cancel_at_period_end'].includes(state) && facts.latestSubscription?.membership_plan_id !== plan.id) {
    level = 'free';
    state = 'inconsistent';
    plan = await readPlan(client, level);
  }
  return { profileLevel: profile.data.membership_level, state, level, plan, snapshot };
}

// Used by OPC before its transaction. The RPC locks the profile and applies the
// lower of this fresh effective tier and the locked profile tier.
export async function readPositioningProfileEntitlement(client: SupabaseClient, profileId: string) {
  try {
    const current = await resolveCurrentMembership(client, profileId);
    return Object.freeze({
      level: current.level,
      profileLevel: current.profileLevel,
      positioningProfileLimit: current.plan.positioning_profile_limit,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    unavailable();
  }
}

// PUBLISH-MONITOR fields (0240) are read separately and fail closed, so a database without 0240 (deployment
// window) or a bad value only switches these new features off and never blocks the existing entitlements.
async function readPublishPlan(client: SupabaseClient, planId: string) {
  const { data, error } = await client.from('membership_plans').select(PUBLISH_COLUMNS).eq('id', planId).limit(2);
  const parsed = z.array(publishPlanSchema).length(1).safeParse(data);
  return error || !parsed.success ? PUBLISH_CLOSED : parsed.data[0]!;
}

// A fresh read for a NEW action. This projection is not a Runtime admission token: consumers
// must recheck inside their creation/reservation transaction and freeze the resulting allowance.
// client is server-owned; the public route binds profileId exclusively to authenticated context.
export async function readMembershipEntitlements(client: SupabaseClient, profileId: string) {
  try {
    const [current, settingResult] = await Promise.all([
      resolveCurrentMembership(client, profileId),
      client.from('system_settings').select('value').eq('key', FUSION_COMPARE_SETTING).single(),
    ]);
    if (settingResult.error) unavailable();
    const limit = fusionCompareLimitSchema.safeParse(settingResult.data?.value);
    if (!limit.success) unavailable();
    const publish = await readPublishPlan(client, current.plan.id);
    // Reuse the existing reasons/messages, never the checkout allowed flag as a feature permission.
    const needsAttention = ['payment_attention', 'refunded_requires_policy', 'inconsistent'].includes(current.state);
    const decision = evaluateAction({ ...current.snapshot, state: current.state, action: 'create_membership_checkout',
      targetLevel: null, targetBillingCycle: null });
    return Object.freeze({
      level: current.level,
      state: current.state,
      reasonCode: needsAttention ? decision.reasonCode : 'ENTITLEMENTS_RESOLVED',
      safeMessage: needsAttention ? decision.safeMessage : '',
      allowFusionReview: current.plan.allow_fusion_review,
      allowFusionCompare: current.plan.allow_fusion_compare,
      libraryStorageBytes: current.plan.library_storage_bytes,
      positioningProfileLimit: current.plan.positioning_profile_limit,
      fusionCompareMaxModels: limit.data,
      allowPublish: publish.allow_publish,
      ownDataWindowDays: publish.own_data_window_days,
      allowBenchmarkMonitor: publish.allow_benchmark_monitor,
      allowWeeklyAutoReview: publish.allow_weekly_auto_review,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    unavailable();
  }
}

export type MembershipEntitlements = Awaited<ReturnType<typeof readMembershipEntitlements>>;

// Only trusted, freshly read server values. Do not accept this object from client input;
// the transaction-level consumer must also enforce model availability/allowlists and quotas.
export function assertFusionEntitlement(
  entitlements: MembershipEntitlements,
  mode: 'review' | 'compare',
  modelCount: number,
) {
  if (mode !== 'review' && mode !== 'compare') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'ENTITLEMENTS_INVALID_MODE' });
  }
  if (!(mode === 'review' ? entitlements.allowFusionReview : entitlements.allowFusionCompare)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'ENTITLEMENTS_FUSION_FORBIDDEN' });
  }
  if (mode === 'compare' && (!Number.isInteger(modelCount) || modelCount < 2
    || modelCount > entitlements.fusionCompareMaxModels || modelCount > 8)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'ENTITLEMENTS_COMPARE_MODEL_LIMIT' });
  }
}
