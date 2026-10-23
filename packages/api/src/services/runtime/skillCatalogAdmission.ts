/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { discoverSkillCatalog, MAX_SKILL_LOADS_PER_TURN, skillCatalogInstructions, skillCatalogReserveBytes,
  type SkillCatalogEntry } from './skillCatalog';
import { LOAD_SKILL_TOOL, loadSkillToolBytes } from './loadSkillTool';

export { MAX_SKILL_LOADS_PER_TURN };

/** What admission freezes for a free-chat turn whose model may load Skills itself. */
export type AdmittedSkillCatalog = {
  text: string; reserveBytes: number; frozen: { skillCatalog: SkillCatalogEntry[]; maxSkillLoads: number;
    skillCatalogMaxBytes: number };
};

/**
 * Free chat only (an ordinary turn of an ordinary conversation): the catalog, its frozen instruction text and the
 * capacity it reserves (the tool definition and the largest loads one reply may make). A catalog that does not fit
 * is dropped, never the turn: the reply is then ordinary chat. Each load is one more call of the same dialogue model,
 * billed like any other call; there is no matching call and no matching fee.
 */
export async function admitSkillCatalog(user: SupabaseClient, admin: SupabaseClient, options: {
  eligible: boolean; excludeSocial: boolean; actor: () => Promise<string>; inputLimit: number; fits: (text: string, extraBytes: number) => boolean;
}): Promise<AdmittedSkillCatalog | undefined> {
  if (!options.eligible) return undefined;
  // A loaded Skill may take at most a quarter of the dialogue model's input, like a chosen Skill's step files.
  const maxResultBytes = Math.floor(options.inputLimit / 4);
  // The catalog is optional: if it cannot be read now, this reply is ordinary chat rather than a failed turn.
  let catalog: SkillCatalogEntry[];
  try { catalog = await discoverSkillCatalog(user, admin, { maxResultBytes, excludeSocial: options.excludeSocial, actorId: await options.actor() }); }
  catch { return undefined; }
  if (!catalog.length) return undefined;
  const text = skillCatalogInstructions(catalog);
  const reserveBytes = skillCatalogReserveBytes(catalog) + loadSkillToolBytes();
  if (!options.fits(text, reserveBytes)) return undefined;
  return { text, reserveBytes,
    frozen: { skillCatalog: catalog, maxSkillLoads: MAX_SKILL_LOADS_PER_TURN, skillCatalogMaxBytes: maxResultBytes } };
}

/** The tool name and the extra calls a catalog adds: each load is one tool call and the model call that reads it. */
export function skillCatalogSlots(admitted: AdmittedSkillCatalog | undefined) {
  return admitted ? { tools: [LOAD_SKILL_TOOL], calls: admitted.frozen.maxSkillLoads } : { tools: [], calls: 0 };
}
