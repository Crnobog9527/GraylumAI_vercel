/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { identityOf, readSkillResources, sha256 as hashBytes, type PackageDescriptor, type SkillSource } from '../../skills/loader';
import { loadSkillParameters, loadSkillTool, SKILL_LOAD_REFUSED } from '../skills/loadSkillTool';
import { entryInstructions, loadSkillResult, type SkillCatalogEntry } from '../skills/skillCatalog';
import { SKILL_FILE_MAX_BYTES, skillFileParameters, skillFileTool } from '../skills/skillFile';
import type { RuntimeTool } from '../agent/runner';

/*
 * CORE-PATH-V2 V2-6, 2.4 / 2.7: the Skill tools read nothing from the database during the turn. Before turn_open the kind
 * prefetches, through the process cache keyed by package hash (one access check per request, made at its start), the
 * instructions of every catalog entry (load_skill) or the declared files of the turn's frozen package (read_skill_file).
 * load_skill is a free tool: no row and no read (Owner 10-28); the model call that reads it is one of the turn's M.
 * read_skill_file writes nothing: it is served in the same SDK run from the frozen package (2.5.3, mentor).
 */

/** The loadable Skills of this turn: name → the exact tool result, built before turn_open. */
export type PreparedSkills = ReadonlyMap<string, string>;

/** At most this many entries are read at once: each read is a few database requests, and a busy site answers many turns together. */
const PREPARE_CONCURRENCY = 3;

/** Reads each entry's instructions now (catalog reads are cached by package hash); an entry that cannot load is left out. The
 * entries are read a few at a time and put in the map in catalog order, whichever finishes first. */
export async function prepareSkills(entries: readonly SkillCatalogEntry[], sourceOf: (entry: SkillCatalogEntry) => SkillSource,
  maxResultBytes: number): Promise<PreparedSkills> {
  const results: Array<string | undefined> = new Array(entries.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const index = next++, entry = entries[index]!;
      try {
        const instructions = await entryInstructions(sourceOf(entry), entry, maxResultBytes);
        results[index] = JSON.stringify(loadSkillResult(entry, instructions));
      } catch { /* not loadable this turn: the model is told so if it asks */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PREPARE_CONCURRENCY, entries.length) }, worker));
  const prepared = new Map<string, string>();
  entries.forEach((entry, index) => { const result = results[index]; if (result !== undefined) prepared.set(entry.name, result); });
  return prepared;
}

/** The catalog with its module's entry replaced by the pinned one; without one (unreadable), the module is not offered at all. */
export function withPinnedSkill(catalog: readonly SkillCatalogEntry[], pin: { moduleId: string }, entry: SkillCatalogEntry | null): SkillCatalogEntry[] {
  const others = catalog.filter(item => item.moduleId !== pin.moduleId && item.name !== entry?.name);
  return entry ? [...others, entry] : others;
}

export function turnLoadSkillTool(skills: PreparedSkills, maxLoads: number, onLoad?: () => void): RuntimeTool {
  let loads = 0;
  return loadSkillTool(async arguments_ => {
    const parsed = loadSkillParameters.safeParse(arguments_);
    const result = parsed.success ? skills.get(parsed.data.name) : undefined;
    // Unknown name, unloadable package, or the per-turn limit: nothing is written and the model answers without it.
    if (!result || loads >= maxLoads) return SKILL_LOAD_REFUSED;
    loads++;
    onLoad?.();
    return result;
  }, () => loads < maxLoads);
}

/** The declared files of one frozen package, verified by hash, read before turn_open. Oversized files are left out. */
export type PreparedSkillFiles = { binding: ReturnType<typeof identityOf>; files: ReadonlyMap<string, string> };
export async function prepareSkillFiles(source: SkillSource, descriptor: PackageDescriptor): Promise<PreparedSkillFiles> {
  const binding = identityOf(descriptor);
  const paths = descriptor.files.filter(file => file.bytes <= SKILL_FILE_MAX_BYTES).map(file => file.path);
  const texts = paths.length ? await readSkillResources(source, binding, paths, SKILL_FILE_MAX_BYTES) : new Map<string, string>();
  return { binding, files: texts };
}

export const SKILL_FILE_UNAVAILABLE = JSON.stringify({ status: 'unavailable', reason: 'SKILL_FILE_NOT_DECLARED' });
export function turnSkillFileTool(prepared: PreparedSkillFiles): RuntimeTool {
  return skillFileTool(async arguments_ => {
    const parsed = skillFileParameters.safeParse(arguments_);
    const content = parsed.success ? prepared.files.get(parsed.data.path) : undefined;
    if (content === undefined) return SKILL_FILE_UNAVAILABLE;
    return JSON.stringify({ ...prepared.binding, path: parsed.data!.path, sha256: hashBytes(Buffer.from(content)), content });
  });
}
