/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { VOICE_GUIDE, VOICE_GUIDE_FALLBACK, voiceText, withPrimaryAddenda } from '../agent/primaryInstructions';
import { catalogRead } from '../settings/catalogCache';
import { pickExamples, voiceExamplesNote } from '../../voice/examples';
import { swallow } from '../../../lib/swallow';
import { admitVoice, executionVoice, withExecutionVoice, type FrozenVoiceProfile } from './voiceAdmission';
import type { SkillCatalogEntry } from '../skills/skillCatalog';

/*
 * VOICE on the load_skill path (Owner 2026-10-23: the voice goes with every writing Skill, however it is loaded). Free chat's
 * model loads Skills itself, so there is no chosen or matched Skill at admission. The catalog's flagged writing Skills are
 * named in the frozen voice, and the executor appends one system-instruction paragraph: the voice, applied only to what the
 * model writes after loading one of those Skills. It is a system instruction, not a tool result: system instructions are never
 * stored in the conversation history, so a later deletion leaves no copy of the voice there (the history keeps the answers,
 * D7), and one copy is sized whatever number of Skills the reply loads.
 */

const GUARD_TAIL = 'For every other reply, ignore it completely.';
/** voice-v3 adds a closing reminder; executions frozen with an earlier wording replay their own guard byte for byte. */
const REMINDER = ' Before writing the first line of such content, make sure no sentence repeats earlier wording of the user or '
  + 'a stock line from the description above: the opening and first three sentences must be new, about the current topic.';
const guard = (names: string[], guide: string) => '\nApply this writing voice only to content you write after loading one of these Skills: '
  + `${names.join(', ')}. ` + GUARD_TAIL + (guide === 'voice-v3' || guide === 'voice-v4' ? REMINDER : '');

/** VOICE-2 PR-2: the administrator's switch (system_settings key voice_examples; false = voice-v3 without stats or examples).
 * Missing or unreadable: on. */
export const VOICE_EXAMPLES_SETTING = 'voice_examples';
async function examplesOn(admin: SupabaseClient): Promise<boolean> {
  const read = await swallow('turn_voice_examples_setting_unavailable', catalogRead(admin, 'settings', VOICE_EXAMPLES_SETTING,
    () => admin.from('system_settings').select('value').eq('key', VOICE_EXAMPLES_SETTING).maybeSingle()), null);
  return (read?.data as { value?: unknown } | null)?.value !== false;
}
const flaggedNames = (catalog: readonly SkillCatalogEntry[], modules: readonly string[]) =>
  catalog.filter(entry => modules.includes(entry.moduleId)).map(entry => entry.name);

/** The frozen voice of a catalog and the paragraph it adds (for sizing), or undefined when no writing Skill uses it. */
export async function admitCatalogVoice(admin: SupabaseClient, actorId: string, catalog: readonly SkillCatalogEntry[], message = ''):
  Promise<{ frozen: FrozenVoiceProfile; text: string; examples?: string } | undefined> {
  // The flags came with the catalog (skillCatalog.ts): no extra read, and no voice call at all when no Skill uses it.
  const flagged = catalog.filter(entry => entry.usesVoice).map(entry => entry.moduleId);
  if (!flagged.length) return undefined;
  const on = await examplesOn(admin);
  const voice = await admitVoice(admin, actorId, flagged, true, on ? VOICE_GUIDE : VOICE_GUIDE_FALLBACK);
  if (!voice) return undefined;
  const text = voiceText({ guide: voice.frozen.guide, profile: voice.profile, stats: voice.stats })
    + guard(flaggedNames(catalog, voice.frozen.modules), voice.frozen.guide);
  // VOICE-2 PR-2: past pieces of the same type and another topic, for a message that asks for writing. They ride with the
  // current message (never the cached instructions, never the stored history); any failure means no examples, never a refusal.
  const ids = on && voice.frozen.versionId ? pickExamples(voice.documents ?? [], message) : [];
  const passages = ids.length ? await swallow('turn_voice_examples_unavailable', readExamples(admin, actorId, voice.frozen.versionId!, ids), []) : [];
  const examples = voiceExamplesNote(passages);
  return { frozen: voice.frozen, text, ...(examples ? { examples } : {}) };
}

async function readExamples(admin: SupabaseClient, actorId: string, versionId: string, ids: string[]): Promise<Array<{ text: string }>> {
  const read = await admin.rpc('voice_examples_read', { a: actorId, vid: versionId, ids });
  if (read.error) throw new Error('VOICE_EXAMPLES_UNAVAILABLE');
  return (Array.isArray(read.data) ? read.data : []).filter((item): item is { text: string } => typeof item?.text === 'string');
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
  return base + voiceText(voice) + guard(flaggedNames(context.skillCatalog, frozen.modules), frozen.guide);
}
