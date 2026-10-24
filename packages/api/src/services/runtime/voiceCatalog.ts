/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { voiceText, withPrimaryAddenda } from './primaryInstructions';
import { admitVoice, executionVoice, withExecutionVoice, type FrozenVoiceProfile } from './voiceAdmission';
import type { SkillCatalogEntry } from './skillCatalog';

/*
 * VOICE on the load_skill path (Owner 2026-10-23: the voice goes with every writing Skill, however it is loaded). Free chat's
 * model loads Skills itself, so there is no chosen or matched Skill at admission. The catalog's flagged writing Skills are
 * named in the frozen voice, and the executor appends one system-instruction paragraph: the voice, applied only to what the
 * model writes after loading one of those Skills. It is a system instruction, not a tool result: system instructions are never
 * stored in the conversation history, so a later deletion leaves no copy of the voice there (the history keeps the answers,
 * D7), and one copy is sized whatever number of Skills the reply loads.
 */

const guard = (names: string[]) => `\nApply this writing voice only to content you write after loading one of these Skills: ${names.join(', ')}. `
  + 'For every other reply, ignore it completely.';
const flaggedNames = (catalog: readonly SkillCatalogEntry[], modules: readonly string[]) =>
  catalog.filter(entry => modules.includes(entry.moduleId)).map(entry => entry.name);

/** The frozen voice of a catalog and the paragraph it adds (for sizing), or undefined when no writing Skill uses it. */
export async function admitCatalogVoice(admin: SupabaseClient, actorId: string, catalog: readonly SkillCatalogEntry[]):
  Promise<{ frozen: FrozenVoiceProfile; text: string } | undefined> {
  // The flags came with the catalog (skillCatalog.ts): no extra read, and no voice call at all when no Skill uses it.
  const flagged = catalog.filter(entry => entry.usesVoice).map(entry => entry.moduleId);
  const voice = await admitVoice(admin, actorId, flagged, true);
  if (!voice) return undefined;
  return { frozen: voice.frozen,
    text: voiceText({ guide: voice.frozen.guide, profile: voice.profile }) + guard(flaggedNames(catalog, voice.frozen.modules)) };
}

type Options = { database: Parameters<typeof executionVoice>[0]; actor: () => Promise<string> };
type Context = Parameters<typeof withPrimaryAddenda>[1] & { voiceProfile?: FrozenVoiceProfile; skillCatalog?: readonly SkillCatalogEntry[] };

/** The executor's instructions plus the voice: of the chosen or matched Skill (withExecutionVoice), or, in free chat with a
 * Skill catalog, the catalog voice. A bound version that can no longer be read ends the run before any provider request. */
export async function withVoice(options: Options, instructions: string, context: Context, moduleId: string | undefined) {
  const base = await withExecutionVoice(options.database, await options.actor(), instructions, context, moduleId);
  const frozen = context.voiceProfile;
  if (moduleId || !frozen || !context.skillCatalog) return base;
  const voice = await executionVoice(options.database, await options.actor(), frozen, frozen.modules[0]);
  if (frozen.versionId && !voice) throw new Error('VOICE_SOURCE_DELETED');
  return base + voiceText(voice) + guard(flaggedNames(context.skillCatalog, frozen.modules));
}
