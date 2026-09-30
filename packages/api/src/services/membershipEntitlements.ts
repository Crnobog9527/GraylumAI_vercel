/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { hasFullRefundSignal } from './membershipEligibility';
import {
  entitlementRowShape, FUSION_COMPARE_SETTING, fusionCompareLimitSchema, membershipLevelSchema,
  type MembershipLevel,
} from './membershipEntitlementConfig';

const profileSchema = z.object({
  membership_level: membershipLevelSchema,
  status: z.literal('active'),
  is_deleted: z.literal('false'),
});
const subscriptionSchema = z.object({
  membership_plan_id: z.string().nullable(),
  status: z.string(),
  current_period_end: z.string().nullable(),
});
const orderSchema = z.object({
  status: z.string().nullable(),
  payment_status: z.string().nullable(),
  metadata: z.unknown(),
});
const planSchema = z.object({ id: z.string(), level: membershipLevelSchema, ...entitlementRowShape });
const ENDED_STATUSES = ['canceled', 'cancelled', 'incomplete_expired'];
const PAYMENT_ATTENTION = ['past_due', 'incomplete', 'unpaid', 'paused'];
type State = 'free' | 'active' | 'admin_override' | 'expired' | 'payment_attention' | 'inconsistent';

function unavailable(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'ENTITLEMENTS_UNAVAILABLE' });
}

async function readPlan(client: SupabaseClient, level: MembershipLevel) {
  // is_active is a catalog/checkout switch, not revocation of previously granted membership.
  const { data, error } = await client.from('membership_plans')
    .select('id,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes').eq('level', level).limit(2);
  const parsed = z.array(planSchema).length(1).safeParse(data);
  if (error || !parsed.success) unavailable();
  return parsed.data[0]!;
}

// A fresh read for a NEW action. This projection is not a Runtime admission token: consumers
// must recheck inside their creation/reservation transaction and freeze the resulting allowance.
// client is server-owned; the public route binds profileId exclusively to authenticated context.
export async function readMembershipEntitlements(client: SupabaseClient, profileId: string, now = Date.now()) {
  try {
    const [profileResult, currentResult, orderResult, settingResult] = await Promise.all([
      client.from('profiles').select('membership_level,status,is_deleted').eq('id', profileId).single(),
      // Unlike the checkout reader's last-ten heuristic, inspect all non-ended candidates,
      // capped at two only to detect ambiguity (never arbitrarily choose the first).
      client.from('user_subscriptions').select('membership_plan_id,status,current_period_end')
        .eq('user_id', profileId).not('status', 'in', `(${ENDED_STATUSES.join(',')})`).limit(2),
      client.from('payment_orders').select('status,payment_status,metadata').eq('user_id', profileId)
        .eq('item_type', 'membership_plan').order('updated_at', { ascending: false }).limit(1).maybeSingle(),
      client.from('system_settings').select('value').eq('key', FUSION_COMPARE_SETTING).single(),
    ]);
    if (profileResult.error || currentResult.error || orderResult.error || settingResult.error) unavailable();
    const profile = profileSchema.safeParse(profileResult.data);
    if (!profile.success) {
      if (profileResult.data && (profileResult.data.status !== 'active' || profileResult.data.is_deleted !== 'false')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'ENTITLEMENTS_ACCOUNT_UNAVAILABLE' });
      }
      unavailable();
    }
    const candidates = z.array(subscriptionSchema).safeParse(currentResult.data);
    const order = orderSchema.nullable().safeParse(orderResult.data);
    const limit = fusionCompareLimitSchema.safeParse(settingResult.data?.value);
    if (!candidates.success || !order.success || !limit.success) unavailable();

    let subscription: z.infer<typeof subscriptionSchema> | undefined = candidates.data[0];
    if (candidates.data.length === 0) {
      const latest = await client.from('user_subscriptions').select('membership_plan_id,status,current_period_end')
        .eq('user_id', profileId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      const parsed = subscriptionSchema.nullable().safeParse(latest.data);
      if (latest.error || !parsed.success) unavailable();
      subscription = parsed.data ?? undefined;
    }
    let level = profile.data.membership_level;
    let state: State = level === 'free' ? 'free' : 'admin_override';
    const paymentStatuses = [order.data?.status, order.data?.payment_status].filter(value => value != null);
    const knownOrderStatuses = ['completed', 'paid', 'succeeded', 'failed', 'canceled', 'cancelled', 'expired'];
    const paymentUncertain = hasFullRefundSignal(order.data)
      || paymentStatuses.some(status => !knownOrderStatuses.includes(status));
    if (candidates.data.length > 1) {
      level = 'free';
      state = 'inconsistent';
    } else if (paymentUncertain || (subscription && PAYMENT_ATTENTION.includes(subscription.status))) {
      level = 'free';
      state = 'payment_attention';
    } else if (subscription) {
      if (ENDED_STATUSES.includes(subscription.status)) {
        level = 'free';
        state = 'expired';
      } else if (subscription.status === 'admin_override') {
        state = level === 'free' ? 'free' : 'admin_override';
      } else if (['active', 'trialing'].includes(subscription.status)) {
        const end = Date.parse(subscription.current_period_end ?? '');
        if (!Number.isFinite(end)) {
          level = 'free';
          state = 'inconsistent';
        } else if (end <= now) {
          level = 'free';
          state = 'expired';
        } else if (level === 'free') {
          state = 'inconsistent';
        } else {
          state = 'active';
        }
      } else {
        level = 'free';
        state = 'inconsistent';
      }
    }
    if (!subscription && order.data && state === 'admin_override') {
      level = 'free';
      state = 'inconsistent';
    }
    let plan = await readPlan(client, level);
    if (state === 'active' && subscription?.membership_plan_id !== plan.id) {
      level = 'free';
      state = 'inconsistent';
      plan = await readPlan(client, level);
    }
    const needsAttention = state === 'payment_attention' || state === 'inconsistent';
    return Object.freeze({
      level,
      state,
      reasonCode: needsAttention ? 'ENTITLEMENTS_PAYMENT_OR_SUPPORT_REQUIRED' : 'ENTITLEMENTS_RESOLVED',
      safeMessage: needsAttention ? '请先解决付款问题或联系支持，确认后即可恢复会员功能。' : '',
      allowFusionReview: plan.allow_fusion_review,
      allowFusionCompare: plan.allow_fusion_compare,
      libraryStorageBytes: plan.library_storage_bytes,
      fusionCompareMaxModels: limit.data,
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
