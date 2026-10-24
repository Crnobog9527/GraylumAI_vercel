/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { serializedResultBytes } from './skillCatalog';
import { voiceText } from './primaryInstructions';
import { admitVoice, executionVoice, type FrozenVoiceProfile } from './voiceAdmission';

/*
 * VOICE on the load_skill path (Owner 2026-10-23: the voice goes with every writing Skill, however it is loaded). Free chat's
 * model loads Skills itself, so there is no chosen or matched Skill at admission: the catalog's flagged writing Skills are
 * frozen with the confirmed version, and a load of one of them appends the voice to the loaded instructions. The voice text
 * is never journaled with the load (a deleted voice must not stay in a stored tool result): it is read when the load runs
 * and appended after the journaled result, for the first load and for a replay alike.
 */

/** The frozen voice of a catalog and the request bytes it reserves: each load of a flagged Skill appends it once. */
export async function admitCatalogVoice(admin: SupabaseClient, actorId: string, moduleIds: string[], maxLoads: number):
  Promise<FrozenVoiceProfile | undefined> {
  const voice = await admitVoice(admin, actorId, moduleIds);
  if (!voice) return undefined;
  const unit = serializedResultBytes(voiceText({ guide: voice.frozen.guide, profile: voice.profile }));
  return { ...voice.frozen, reserveBytes: unit * Math.min(maxLoads, voice.frozen.modules.length) };
}

type Options = { database: Parameters<typeof executionVoice>[0]; actor: () => Promise<string> };
/** The text a load of this module appends, or null when the module does not use the voice. A bound version that can no
 * longer be read refuses the load for good (the run is then ended by its deletion binding, 0345). */
export function voiceLoader(options: Options, context: { voiceProfile?: FrozenVoiceProfile }) {
  return async (moduleId: string): Promise<string | null> => {
    const frozen = context.voiceProfile;
    if (!frozen || !frozen.modules.includes(moduleId)) return null;
    const voice = await executionVoice(options.database, await options.actor(), frozen, moduleId);
    if (frozen.versionId && !voice) throw new Error('RUNTIME_SKILL_LOAD_DENIED');
    return voiceText(voice) || null;
  };
}
