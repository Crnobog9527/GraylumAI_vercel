/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { identityOf, readSkillResources, sha256 as hashBytes, type PackageDescriptor, type SkillSource } from '../../skills/loader';
import { loadSkillParameters, loadSkillTool, SKILL_LOAD_REFUSED } from '../../runtime/loadSkillTool';
import { entryInstructions, loadSkillResult, type SkillCatalogEntry } from '../../runtime/skillCatalog';
import { SKILL_FILE_MAX_BYTES, skillFileParameters, skillFileTool } from '../../runtime/skillFile';
import type { RuntimeTool } from '../../runtime/runner';
import { freeToolCall, ToolLimitReached } from './meter';
import type { ToolCallDeps } from './types';

/*
 * CORE-PATH-V2 V2-6, 2.4 / 2.7: the Skill tools read nothing from the database during the turn. Before turn_open the kind
 * prefetches, through the process cache keyed by package hash (one access check per request, made at its start), the
 * instructions of every catalog entry (load_skill) or the declared files of the turn's frozen package (read_skill_file).
 * load_skill is a free tool: one zero-bound row (begin + record), and the model call that reads it is one of the turn's M.
 * read_skill_file writes nothing: it is served in the same SDK run from the frozen package (2.5.3, mentor).
 */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The loadable Skills of this turn: name → the exact tool result, built before turn_open. */
export type PreparedSkills = ReadonlyMap<string, string>;

/** Reads each entry's instructions now (catalog reads are cached by package hash); an entry that cannot load is left out. */
export async function prepareSkills(entries: readonly SkillCatalogEntry[], sourceOf: (entry: SkillCatalogEntry) => SkillSource,
  maxResultBytes: number): Promise<PreparedSkills> {
  const prepared = new Map<string, string>();
  for (const entry of entries) {
    try {
      const instructions = await entryInstructions(sourceOf(entry), entry, maxResultBytes);
      prepared.set(entry.name, JSON.stringify(loadSkillResult(entry, instructions)));
    } catch { /* not loadable this turn: the model is told so if it asks */ }
  }
  return prepared;
}

export function turnLoadSkillTool(calls: ToolCallDeps, skills: PreparedSkills, maxLoads: number, multiplier: string,
  onLoad?: () => void): RuntimeTool {
  let loads = 0;
  return loadSkillTool(async arguments_ => {
    const parsed = loadSkillParameters.safeParse(arguments_);
    const result = parsed.success ? skills.get(parsed.data.name) : undefined;
    // Unknown name, unloadable package, or the per-turn limit: nothing is written and the model answers without it.
    if (!result || loads >= maxLoads) return SKILL_LOAD_REFUSED;
    try {
      const value = await freeToolCall(calls, { toolName: 'load_skill', requestHash: sha256(parsed.data!.name), multiplier },
        async () => ({ value: result, raw: result }));
      loads++;
      onLoad?.();
      return value;
    } catch (error) {
      if (error instanceof ToolLimitReached) { loads = maxLoads; return SKILL_LOAD_REFUSED; }
      throw error;
    }
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
