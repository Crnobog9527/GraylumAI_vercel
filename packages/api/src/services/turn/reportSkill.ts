/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { activateSkill, batchBytes, batchFiles, fail, identityOf, sameIdentity, validateDescriptor, type PackageDescriptor,
  type SkillSource } from '../skills/loader';

/*
 * CORE-PATH-V2 V2-7a (2.4): the Skill text of a report, kept in the process by its package identity (module, Skill, revision,
 * package hash, the round's resources). A package is immutable under its hash, so the text never goes stale; turn_open has
 * already proved the round is the actor's and bound to this package and that the module is offered (turn_report_admit). A
 * miss reads the package once through read_skill_package, the same checked service read the old report path made, and the
 * loader builds the same bytes (activateSkill with the round's resources).
 */
const texts = new Map<string, string>();
const MAX_ENTRIES = 32;

export type ReportSkill = { actorId: string; moduleId: string; skillId: string; revisionId: string; packageHash: string;
  resources: readonly string[]; maxBytes: number };

/** A request-local source over read_skill_package for one actor and package (the turn's own authorization). */
function packageSource(admin: SupabaseClient, skill: ReportSkill): SkillSource {
  let selected: PackageDescriptor | undefined;
  const read = async (path: string | null, maxBytes = 2097152, paths?: readonly string[]) => {
    const { data, error } = await admin.rpc('read_skill_package', { p_actor_id: skill.actorId, p_module_id: skill.moduleId,
      p_skill_id: skill.skillId, p_revision_id: skill.revisionId, p_package_hash: skill.packageHash, p_path: path,
      p_max_bytes: maxBytes, ...(paths ? { p_paths: paths } : {}) });
    if (error || data === null) fail('UNAVAILABLE');
    return data;
  };
  return {
    async list() { selected ??= validateDescriptor(await read(null)); return [structuredClone(selected)]; },
    async state(identity) {
      if (!selected || !sameIdentity(selected, identity)) return 'denied';
      try { await read(''); return 'enabled'; } catch { return 'denied'; }
    },
    async read(identity, maxBytes) {
      if (!selected || !sameIdentity(selected, identity)) fail('UNAVAILABLE');
      const data = await read(identity.path, maxBytes);
      if (typeof data !== 'string') fail('SOURCE_FAILURE');
      return Buffer.from(data, 'base64');
    },
    async readMany(identity, files) {
      if (!selected || !sameIdentity(selected, identity)) fail('UNAVAILABLE');
      return batchFiles(await read(null, batchBytes(files), files.map(f => f.path)), files);
    },
  };
}

export async function reportSkillText(admin: SupabaseClient, skill: ReportSkill): Promise<string> {
  const key = JSON.stringify([skill.moduleId, skill.skillId, skill.revisionId, skill.packageHash, skill.resources, skill.maxBytes]);
  const hit = texts.get(key);
  if (hit !== undefined) return hit;
  const source = packageSource(admin, skill);
  const descriptor = (await source.list()).find(d => d.revisionId === skill.revisionId && d.packageHash === skill.packageHash);
  if (!descriptor) fail('UNAVAILABLE');
  const text = (await activateSkill(source, identityOf(descriptor), { resources: skill.resources, maxContextBytes: skill.maxBytes }))
    .forModel();
  texts.set(key, text);
  for (const oldest of texts.keys()) { if (texts.size <= MAX_ENTRIES) break; texts.delete(oldest); }
  return text;
}

export function clearReportSkillCache(): void { texts.clear(); }
