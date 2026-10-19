/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

export const membershipLevelSchema = z.enum(['free', 'pro', 'gold']);
export type MembershipLevel = z.infer<typeof membershipLevelSchema>;
export const FUSION_COMPARE_SETTING = 'fusion_compare_max_models';
export const fusionCompareLimitSchema = z.number().int().min(2).max(8);
export const storageBytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positioningProfileLimitSchema = z.number().int().positive().max(1000);
export const entitlementRowShape = {
  allow_fusion_review: z.boolean(),
  allow_fusion_compare: z.boolean(),
  library_storage_bytes: storageBytesSchema,
  positioning_profile_limit: positioningProfileLimitSchema,
};
export const entitlementInputShape = {
  allowFusionReview: z.boolean().optional(),
  allowFusionCompare: z.boolean().optional(),
  libraryStorageBytes: storageBytesSchema.optional(),
  positioningProfileLimit: positioningProfileLimitSchema.optional(),
};
// PUBLISH-MONITOR (migration 0240, Master Plan §2.1 item 51). Read-only here: values change by migration
// until the admin editor gains these fields.
export const publishMonitorEntitlementShape = {
  allow_publish: z.boolean(),
  own_data_window_days: z.number().int().min(0).max(365),
  allow_benchmark_monitor: z.boolean(),
  allow_weekly_auto_review: z.boolean(),
};
export function defaultPublishMonitorEntitlements(level: MembershipLevel) {
  return {
    allow_publish: level !== 'free',
    own_data_window_days: { free: 0, pro: 30, gold: 90 }[level],
    allow_benchmark_monitor: level === 'gold',
    allow_weekly_auto_review: level === 'gold',
  };
}
export type EntitlementPatch = {
  allowFusionReview?: boolean;
  allowFusionCompare?: boolean;
  libraryStorageBytes?: number;
  positioningProfileLimit?: number;
};

// Creation defaults only. Reads never substitute these for missing configuration.
export function defaultMembershipEntitlements(level: MembershipLevel) {
  return {
    allow_fusion_review: level !== 'free',
    allow_fusion_compare: level !== 'free',
    library_storage_bytes: { free: 50_000_000, pro: 500_000_000, gold: 2_000_000_000 }[level],
    positioning_profile_limit: { free: 1, pro: 3, gold: 6 }[level],
  };
}

export function membershipEntitlementPatch(input: EntitlementPatch) {
  return {
    ...(input.allowFusionReview !== undefined ? { allow_fusion_review: input.allowFusionReview } : {}),
    ...(input.allowFusionCompare !== undefined ? { allow_fusion_compare: input.allowFusionCompare } : {}),
    ...(input.libraryStorageBytes !== undefined ? { library_storage_bytes: input.libraryStorageBytes } : {}),
    ...(input.positioningProfileLimit !== undefined
      ? { positioning_profile_limit: input.positioningProfileLimit } : {}),
  };
}
