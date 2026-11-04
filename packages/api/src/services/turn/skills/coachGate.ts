/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { swallow } from '../../../lib/swallow';
import { readOwnDataTier } from '../../membershipEntitlements';
import type { SkillCatalogEntry } from './skillCatalog';

/*
 * The coach's review method is a member feature (Owner 2026-10-27): the Skill is listed for a chat only when the account's plan has an
 * own-data window. The review-pack tool is already refused to the others; hiding the Skill keeps the method itself (and what a
 * screenshot analysed by it would give) from an account that has no window. An unknown tier hides it: nothing is lost by not listing.
 */
/** The Skill's `name` in its SKILL.md front matter. */
export const COACH_SKILL_NAME = 'review-coach';

const isCoach = (entry: SkillCatalogEntry) => entry.name.trim().toLowerCase() === COACH_SKILL_NAME;

/** `tierOf`: the request's one read of the plan, when the caller also needs it elsewhere. */
export async function memberCatalog(admin: SupabaseClient, actorId: string, entries: SkillCatalogEntry[],
  tierOf: (actorId: string) => ReturnType<typeof readOwnDataTier> = id => readOwnDataTier(admin, id)): Promise<SkillCatalogEntry[]> {
  if (!entries.some(isCoach)) return entries;
  const tier = await swallow('turn_tools_coach_skill_tier_unavailable', tierOf(actorId), null);
  return tier && tier.ownDataWindowDays > 0 ? entries : entries.filter(entry => !isCoach(entry));
}
