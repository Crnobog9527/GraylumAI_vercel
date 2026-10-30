/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { catalogRead } from '../runtime/catalogCache';
import {
  activateSkill, assertPath, batchBytes, batchFiles, frozenDescriptor, identityOf, readSkillResources, sameIdentity,
  type PackageIdentity, type SkillSource,
} from '../skills/loader';
import { loadOrganizerTemplate } from '../skills/organizerTemplate';
import { SKILL_FILE_MAX_BYTES, SKILL_FILE_TRACE_BYTES, skillFileParameters, skillFileTool, type SkillFileBinding } from '../runtime/skillFile';
import type { RuntimeTool } from '../runtime/runner';

/*
 * CORE-PATH-V2 2.7 (kind=mentor): the pinned Skill of a positioning draft. turn_open has already checked, in the same
 * transaction that froze the turn, that the module is active, the Skill published and this revision not revoked
 * (turn_mentor_context). After that the package is content addressed (revision + packageHash never change), so its descriptor
 * and file texts come from the loader's process caches; only a cold cache reads read_skill_package (a catalog read, before the
 * first model call). Everything a turn may read is prepared before its first model call: the step's Skill text, every file
 * read_skill_file may return and the organizer template. Between model calls nothing touches the database: the tool answers
 * from this turn's own copy, writes no row and costs the user nothing (plan 2.5.3: its continuation is one of the turn's calls).
 */
export type MentorSkill = { actorId: string; moduleId: string; skillId: string; revisionId: string; packageHash: string };

/** The Skill checks of a mentor turn, from the Skill catalog cache (versioned by the tables they read); no database read on a hit. */
export async function mentorSkillAvailable(admin: Pick<SupabaseClient, 'rpc'>, skill: Omit<MentorSkill, 'actorId'>): Promise<boolean> {
  const { data, error } = await catalogRead(admin, 'skills', `mentor-skill:${skill.moduleId}:${skill.skillId}:${skill.revisionId}:${skill.packageHash}`,
    () => admin.rpc('mentor_skill_available', { p_module_id: skill.moduleId, p_skill_id: skill.skillId, p_revision_id: skill.revisionId,
      p_package_hash: skill.packageHash }));
  if (error) throw new Error('TURN_SKILL_UNAVAILABLE');
  return data === true;
}

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

export type MentorSkillFiles = { files: ReadonlyMap<string, { text: string; sha256: string }>; organizerTemplate: string | undefined };

/** The Skill text of one workflow step (SKILL.md first, then the step's resources) and where the SKILL.md section ends. */
export async function loadMentorSkill(source: SkillSource, binding: SkillFileBinding, resources: readonly string[], maxBytes: number) {
  const loaded = await activateSkill(source, binding, { resources, maxContextBytes: maxBytes });
  const text = loaded.forModel();
  return { text, entryChars: skillEntryChars(text, binding) };
}

/**
 * Before the first model call: every declared file read_skill_file may return (at most SKILL_FILE_MAX_BYTES each; a warm
 * loader cache reads nothing, a cold one reads them in batches of 64) and the organizer template when the turn organizes.
 */
export async function prepareMentorFiles(source: SkillSource, binding: SkillFileBinding, organize: boolean): Promise<MentorSkillFiles> {
  const [descriptor] = await source.list();
  if (!descriptor || !sameIdentity(descriptor, binding)) throw new Error('TURN_SKILL_UNAVAILABLE');
  const readable = descriptor.files.filter(f => f.bytes <= SKILL_FILE_MAX_BYTES);
  const files = new Map<string, { text: string; sha256: string }>();
  for (let offset = 0; offset < readable.length; offset += 64) {
    const chunk = readable.slice(offset, offset + 64);
    const texts = await readSkillResources(source, binding, chunk.map(f => f.path), SKILL_FILE_MAX_BYTES);
    for (const file of chunk) files.set(file.path, { text: texts.get(file.path)!, sha256: file.sha256 });
  }
  return { files, organizerTemplate: organize ? await loadOrganizerTemplate(source, binding.revisionId) : undefined };
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

/**
 * Request bytes a read_skill_file continuation may add, measured on this turn's prepared files as skillFileContinuationBytes
 * measures them (runtime/skillFile.ts): the tool result is a JSON string embedded in the request JSON, so it is measured
 * escaped twice; plus the call itself and its trace.
 */
export function skillFileReserveBytes(prepared: MentorSkillFiles, binding: SkillFileBinding): number {
  let largest = 0;
  for (const [path, file] of prepared.files) largest = Math.max(largest,
    Buffer.byteLength(JSON.stringify(JSON.stringify({ ...binding, path, sha256: file.sha256, content: file.text }))));
  return largest + 4096 + SKILL_FILE_TRACE_BYTES;
}

/** read_skill_file for the mentor: one declared file of the frozen package, from this turn's prepared copy only. */
export function mentorSkillFileTool(prepared: MentorSkillFiles, binding: SkillFileBinding): RuntimeTool {
  return skillFileTool(async arguments_ => {
    const { path } = skillFileParameters.parse(arguments_);
    assertPath(path);
    const file = prepared.files.get(path);
    // Undeclared, or larger than the tool may return: refused as the old tool refused it, without any read.
    if (!file) throw new Error('RUNTIME_SKILL_FILE_DENIED');
    return JSON.stringify({ ...binding, path, sha256: file.sha256, content: file.text });
  });
}
