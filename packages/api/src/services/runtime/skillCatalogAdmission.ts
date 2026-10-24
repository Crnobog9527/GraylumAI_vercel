/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { discoverSkillCatalog, MAX_SKILL_LOADS_PER_TURN, skillCatalogInstructions, skillCatalogReserveBytes,
  type SkillCatalogEntry } from './skillCatalog';
import { LOAD_SKILL_TOOL, loadSkillToolBytes } from './loadSkillTool';
import { admitCatalogVoice } from './voiceCatalog';
import type { FrozenVoiceProfile } from './voiceAdmission';

export { MAX_SKILL_LOADS_PER_TURN };

/** What admission freezes for a free-chat turn whose model may load Skills itself. */
export type AdmittedSkillCatalog = {
  text: string; reserveBytes: number; frozen: { skillCatalog: SkillCatalogEntry[]; maxSkillLoads: number;
    skillCatalogMaxBytes: number; voiceProfile?: FrozenVoiceProfile };
};

/** Only an ordinary turn of an ordinary free conversation: never a topic window, positioning, a report or a mentor turn. */
export function freeChatCatalogTurn(turn: { selection: { kind: string }; mentorStream?: unknown; stepStream?: unknown;
  hostTurnContext?: unknown; report?: unknown; opcTurnToken?: unknown; scope: unknown }): boolean {
  return turn.selection.kind === 'ordinary' && !turn.mentorStream && !turn.stepStream && !turn.hostTurnContext && !turn.report
    && !turn.opcTurnToken && (turn.scope as { kind?: unknown } | null)?.kind === 'positioning_draft';
}

/**
 * CONTENT-CONVERSATION-DRIVEN: free chat's model may load listed Skills itself (frozen at admission, after the other
 * reserves): the catalog, its frozen instruction text and the capacity it reserves (the tool definition and the largest
 * loads one reply may make). A catalog that does not fit, measured appended to the instructions as it is serialized, is
 * dropped, never the turn: the reply is then ordinary chat. Each load is one more call of the same dialogue model,
 * billed like any other call; there is no matching call and no matching fee.
 */
export async function admitSkillCatalog(user: SupabaseClient, admin: SupabaseClient, options: {
  eligible: boolean; excludeSocial: boolean; actor: () => Promise<string>; inputLimit: number; maxCalls: number;
  fitsWith: (extraBytes: number, text: string) => boolean; strategyReserve?: (calls: number) => number;
}): Promise<AdmittedSkillCatalog | undefined> {
  if (!options.eligible) return undefined;
  // A loaded Skill may take at most a quarter of the dialogue model's input, like a chosen Skill's step files.
  const maxResultBytes = Math.floor(options.inputLimit / 4);
  // The catalog is optional: if it cannot be read now, this reply is ordinary chat rather than a failed turn.
  let catalog: SkillCatalogEntry[];
  try { catalog = await discoverSkillCatalog(user, admin, { maxResultBytes, excludeSocial: options.excludeSocial,
    actorId: await options.actor() }); }
  catch { return undefined; }
  if (!catalog.length) return undefined;
  const text = skillCatalogInstructions(catalog);
  const base = skillCatalogReserveBytes(catalog) + loadSkillToolBytes();
  const strategy = options.strategyReserve?.(options.maxCalls + MAX_SKILL_LOADS_PER_TURN) ?? 0;
  // VOICE: the writing Skills of the catalog are written in the user's confirmed voice (voiceCatalog.ts). The voice is a
  // system-instruction paragraph the executor appends, sized here with the catalog text: it is never a tool result, so it
  // never reaches the stored conversation history. A voice that does not fit is dropped before the catalog is.
  let voice = await admitCatalogVoice(admin, await options.actor(), catalog);
  if (voice && !options.fitsWith(base + strategy, text + voice.text)) voice = undefined;
  if (!options.fitsWith(base + strategy, text + (voice?.text ?? ''))) return undefined;
  return { text, reserveBytes: base, frozen: { skillCatalog: catalog, maxSkillLoads: MAX_SKILL_LOADS_PER_TURN,
    skillCatalogMaxBytes: maxResultBytes, ...(voice ? { voiceProfile: voice.frozen } : {}) } };
}

/** The tool name and the extra calls a catalog adds: each load is one tool call and the model call that reads it. */
export function skillCatalogSlots(admitted: AdmittedSkillCatalog | undefined) {
  return admitted ? { tools: [LOAD_SKILL_TOOL], calls: admitted.frozen.maxSkillLoads } : { tools: [], calls: 0 };
}
