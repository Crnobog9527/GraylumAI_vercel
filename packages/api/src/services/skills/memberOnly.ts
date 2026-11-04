/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { swallow } from '../../lib/swallow';
import { readOwnDataTier } from '../membershipEntitlements';

/*
 * MEMBER-ONLY-MODULES (Owner 2026-11-04): a Skill limited to members stays visible to everyone; `modules.required_member_level` is the
 * lowest membership level that may use it (null = everyone, 'pro' = Pro and Gold, 'gold' = Gold). Levels are the entitlement names.
 */
export type RequiredMemberLevel = 'pro' | 'gold';
const RANK: Record<string, number> = { free: 0, pro: 1, gold: 2 };

/** `level` null/unknown counts as free; an unknown requirement is never met (fails closed). */
export function meetsMemberLevel(level: string | null | undefined, required: string | null | undefined): boolean {
  if (!required) return true;
  return (RANK[level ?? 'free'] ?? 0) >= (RANK[required] ?? Number.POSITIVE_INFINITY);
}

export const asRequiredLevel = (value: unknown): RequiredMemberLevel | null => (value === 'pro' || value === 'gold' ? value : null);

/** Whether the Skill list marks a module locked for this plan read. A plan that could not be read locks nothing: the page must not sell
 *  a plan to a paying member after a transient failure, and the real gate (the chat catalog's own plan check) still holds. */
export const lockedForTier = (tier: { level: string } | null, required: RequiredMemberLevel | null): boolean =>
  tier !== null && !meetsMemberLevel(tier.level, required);

/**
 * The server-side gate of a module with a requirement: true when this account's plan is below it (an unreadable plan counts as below:
 * a load is refused rather than given to someone unverified). A module with no requirement reads no plan.
 */
export async function memberLevelDenied(admin: SupabaseClient, actorId: string, required: unknown): Promise<boolean> {
  const level = asRequiredLevel(required);
  if (!level) return false;
  const tier = await swallow('member_only_tier_unavailable', readOwnDataTier(admin, actorId), null);
  return !tier || !meetsMemberLevel(tier.level, level);
}
