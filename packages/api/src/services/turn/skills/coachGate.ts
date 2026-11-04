/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { swallow } from '../../../lib/swallow';
import { readOwnDataTier } from '../../membershipEntitlements';
import type { SkillCatalogEntry } from './skillCatalog';
import { meetsMemberLevel } from '../../skills/memberOnly';

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
  const limited = entries.some(entry => entry.requiredMemberLevel);
  if (!limited && !entries.some(isCoach)) return entries;
  const tier = await swallow('turn_tools_coach_skill_tier_unavailable', tierOf(actorId), null);
  // MEMBER-ONLY-MODULES: a Skill with a plan requirement is listed and loadable only for a plan at or above it; the coach keeps its own
  // own-data-window rule. An unknown plan hides all of them.
  return entries.filter(entry => (!isCoach(entry) || (tier && tier.ownDataWindowDays > 0))
    && (!entry.requiredMemberLevel || (tier && meetsMemberLevel(tier.level, entry.requiredMemberLevel))));
}
