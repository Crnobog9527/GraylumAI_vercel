/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

export const membershipLevelSchema = z.enum(['free', 'pro', 'gold']);
export type MembershipLevel = z.infer<typeof membershipLevelSchema>;
export const FUSION_COMPARE_SETTING = 'fusion_compare_max_models';
export const fusionCompareLimitSchema = z.number().int().min(2).max(8);
export const storageBytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const entitlementRowShape = {
  allow_fusion_review: z.boolean(),
  allow_fusion_compare: z.boolean(),
  library_storage_bytes: storageBytesSchema,
};
export const entitlementInputShape = {
  allowFusionReview: z.boolean().optional(),
  allowFusionCompare: z.boolean().optional(),
  libraryStorageBytes: storageBytesSchema.optional(),
};
export type EntitlementPatch = {
  allowFusionReview?: boolean;
  allowFusionCompare?: boolean;
  libraryStorageBytes?: number;
};

// Creation defaults only. Reads never substitute these for missing configuration.
export function defaultMembershipEntitlements(level: MembershipLevel) {
  return {
    allow_fusion_review: level !== 'free',
    allow_fusion_compare: level !== 'free',
    library_storage_bytes: { free: 50_000_000, pro: 500_000_000, gold: 2_000_000_000 }[level],
  };
}

export function membershipEntitlementPatch(input: EntitlementPatch) {
  return {
    ...(input.allowFusionReview !== undefined ? { allow_fusion_review: input.allowFusionReview } : {}),
    ...(input.allowFusionCompare !== undefined ? { allow_fusion_compare: input.allowFusionCompare } : {}),
    ...(input.libraryStorageBytes !== undefined ? { library_storage_bytes: input.libraryStorageBytes } : {}),
  };
}
