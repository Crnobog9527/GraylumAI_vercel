/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  activateSkill, batchBytes, batchFiles, frozenDescriptor, identityOf, sameIdentity, type PackageIdentity, type SkillSource,
} from '../skills/loader';
import { readFrozenSkillFile, skillFileTool, type SkillFileBinding } from '../runtime/skillFile';
import type { RuntimeTool } from '../runtime/runner';

/*
 * CORE-PATH-V2 2.7 (kind=mentor): the pinned Skill of a positioning draft. turn_open has already checked, in the same
 * transaction that froze the turn, that the module is active, the Skill published and this revision not revoked
 * (turn_mentor_context). After that the package is content addressed (revision + packageHash never change), so its descriptor
 * and file texts come from the loader's process caches; only a cold cache reads read_skill_package (a catalog read, before the
 * first model call). Nothing here runs between model calls: read_skill_file answers from the same cached texts, writes no row
 * and costs the user nothing (plan 2.5.3: its continuation is one of the turn's model calls).
 */
export type MentorSkill = { actorId: string; moduleId: string; skillId: string; revisionId: string; packageHash: string };

export function mentorSkillSource(admin: Pick<SupabaseClient, 'rpc'>, skill: MentorSkill): { source: SkillSource; binding: SkillFileBinding } {
  const binding = { packageId: skill.skillId, revisionId: skill.revisionId, packageHash: skill.packageHash };
  const read = async (path: string | null, maxBytes: number, paths?: readonly string[]) => {
    const { data, error } = await admin.rpc('read_skill_package', { p_actor_id: skill.actorId, p_module_id: skill.moduleId,
      p_skill_id: skill.skillId, p_revision_id: skill.revisionId, p_package_hash: skill.packageHash, p_path: path,
      p_max_bytes: maxBytes, ...(paths ? { p_paths: paths } : {}) });
    if (error || data === null) throw new Error('TURN_SKILL_UNAVAILABLE');
    return data as unknown;
  };
  const own = (identity: PackageIdentity) => sameIdentity(identity, binding);
  const source: SkillSource = {
    list: async () => [await frozenDescriptor(binding, () => read(null, 2097152))],
    // Checked by turn_open for this turn; the identity must still be exactly the frozen one.
    state: async identity => own(identity) ? 'enabled' : 'denied',
    read: async (identity, maxBytes) => {
      if (!own(identity)) throw new Error('TURN_SKILL_UNAVAILABLE');
      const value = await read(identity.path, maxBytes);
      if (typeof value !== 'string') throw new Error('TURN_SKILL_UNAVAILABLE');
      return Buffer.from(value, 'base64');
    },
    // Only files missing from the loader's text cache are read; a warm cache asks for none and reads nothing.
    readMany: async (identity, files) => {
      if (!own(identity)) throw new Error('TURN_SKILL_UNAVAILABLE');
      if (!files.length) return new Map();
      return batchFiles(await read(null, batchBytes(files), files.map(f => f.path)), files);
    },
  };
  return { source, binding };
}

/** The Skill text of one workflow step (SKILL.md first, then the step's resources) and where the SKILL.md section ends. */
export async function loadMentorSkill(source: SkillSource, binding: SkillFileBinding, resources: readonly string[], maxBytes: number) {
  const loaded = await activateSkill(source, binding, { resources, maxContextBytes: maxBytes });
  const text = loaded.forModel();
  return { text, entryChars: skillEntryChars(text, binding) };
}

/**
 * The characters of the loaded Skill text up to the end of its SKILL.md section (the loader's JSON encoding:
 * {"skill":identity,"resources":[{"path":"SKILL.md","content":...}, ...step resources]}). Every step of the workflow shares
 * this prefix, so it is the first prompt cache breakpoint (#1502). 0 when the text is not in that shape: no breakpoint.
 */
export function skillEntryChars(text: string, identity: PackageIdentity): number {
  let parsed: { resources?: Array<{ path?: unknown; content?: unknown }> };
  try { parsed = JSON.parse(text); } catch { return 0; }
  const entry = parsed.resources?.[0];
  if (!entry || entry.path !== 'SKILL.md' || typeof entry.content !== 'string') return 0;
  const prefix = JSON.stringify({ skill: identityOf(identity), resources: [{ path: 'SKILL.md', content: entry.content }] }).slice(0, -2);
  return text.startsWith(prefix) ? prefix.length : 0;
}

/** read_skill_file for the mentor: one declared file of the frozen package, from the cached texts. */
export function mentorSkillFileTool(source: SkillSource, binding: SkillFileBinding): RuntimeTool {
  return skillFileTool(async arguments_ =>
    JSON.stringify(await readFrozenSkillFile({ source, binding, arguments: arguments_, saved: null })));
}
