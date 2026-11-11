/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { mapBounded } from '../../lib/mapBounded';
import { databaseSkillSource, requestAuthentication, type UserVisibleModule } from './databaseSource';
import { discoverSkills, type SkillSource } from './loader';
import { asRequiredLevel, lockedForTier, type RequiredMemberLevel } from './memberOnly';

/*
 * The Skills the composer offers (runtime.choices): one entry per runnable revision of each visible module.
 * Every module is read from the database twice (its descriptor, then its SKILL.md). The procedure used to do that one
 * module after another, and each read asked the sign-in service who the caller is: 2N identity checks and 2N package reads
 * in a row for N modules (up to 64). Here the request asks once who the caller is, and a few modules are read at a time.
 * What is listed, and in which order, is unchanged; a module whose package cannot be read is still just left out.
 */
export type ChoiceModule = { id: string; skill_id: string | null; title: string; model_id: string | null; required_member_level: unknown };
export type ChoiceSkill = { moduleId: string; revisionId: string; name: string; requiredMemberLevel: RequiredMemberLevel | null; locked: boolean };

/** Modules read at the same time: enough to cut the wait, few enough to leave the request pool (8) to other requests. */
export const CHOICE_MODULES_AT_ONCE = 3;

export async function listChoiceSkills(input: {
  userClient: SupabaseClient; privateClient: SupabaseClient | null;
  /** This request's user-scoped (RLS) read of visible modules; never a service-role row (AC-0c). */
  visible: readonly UserVisibleModule[];
  modules: readonly ChoiceModule[];
  /** The host can run this module at all (its model is among the call policies). */
  runnable: (module: ChoiceModule) => boolean;
  /** The module's Skills are listed on this host (the real host, a work conversation, or the local fixture model). */
  listed: (module: ChoiceModule) => boolean;
  /** A work conversation keeps the method revision it came from. */
  pin?: { moduleId: string; revisionId: string } | null;
  tier: Parameters<typeof lockedForTier>[0];
  /** Test seams; the defaults are the database source and the loader. */
  sourceFor?: (options: Parameters<typeof databaseSkillSource>[0]) => SkillSource;
  discover?: typeof discoverSkills;
}): Promise<ChoiceSkill[]> {
  const sourceFor = input.sourceFor ?? databaseSkillSource, discover = input.discover ?? discoverSkills;
  // One identity check for the whole request, shared by every module's source.
  const authentication = requestAuthentication(input.userClient);
  const perModule = await mapBounded(input.modules, CHOICE_MODULES_AT_ONCE, async (module): Promise<ChoiceSkill[]> => {
    // A module that would not be listed is not read at all: the answer is the same without the two round trips.
    if (!module.skill_id || !input.runnable(module) || !input.listed(module)) return [];
    try {
      const userVisibleModule = input.visible.find(item => item.id === module.id);
      const source = sourceFor({ userClient: input.userClient, privateClient: input.privateClient, moduleId: module.id,
        skillId: module.skill_id, userVisibleModule, authentication,
        ...(input.pin && module.id === input.pin.moduleId ? { revisionId: input.pin.revisionId } : {}) });
      const descriptors = await source.list();
      const found = await discover(source);
      const requiredMemberLevel = asRequiredLevel(module.required_member_level);
      return found.flatMap((skill) => {
        const descriptor = descriptors.find(item => item.revisionId === skill.public.revisionId);
        // A package with tasks is a workflow, not something to pick in the composer.
        if (!descriptor || Object.keys(descriptor.tasks).length) return [];
        return [{ moduleId: module.id, revisionId: skill.public.revisionId, name: module.title, requiredMemberLevel,
          locked: lockedForTier(input.tier, requiredMemberLevel) }];
      });
    } catch { return []; /* unavailable packages are not advertised as runnable */ }
  });
  return perModule.flat();
}
