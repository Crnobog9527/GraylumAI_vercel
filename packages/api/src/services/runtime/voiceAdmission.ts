/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { voiceProfile, type VoiceProfile } from '../voice/profile';
import { VOICE_GUIDE, withPrimaryAddenda } from './primaryInstructions';

/** VOICE (Master Plan 5.3 step 4): what admission freezes for a run that may write in the user's voice. Only the version id:
 * its text is read again when the run executes, so a deleted version is never read again (0337 voice_profile_read). */
/** Without a version: the user has no confirmed profile (and has not turned the voice off), so the Skill only hints once. */
export const frozenVoiceProfile = z.object({ guide: z.literal(VOICE_GUIDE), versionId: z.string().uuid().optional(),
  version: z.number().int().positive().optional(), modules: z.array(z.string().uuid()).min(1).max(16) }).strict();
export type FrozenVoiceProfile = z.infer<typeof frozenVoiceProfile>;
type Rpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

/** The confirmed profile, when one of these modules is a writing Skill flagged "使用用户文风" (0337 uses_user_voice) and the
 * user has a confirmed profile with "使用我的文风" on. Any read failure means no voice for this run (never a refused turn). */
export async function admitVoice(admin: SupabaseClient, actorId: string, moduleIds: string[], flagged = false):
  Promise<{ frozen: FrozenVoiceProfile; profile?: VoiceProfile } | undefined> {
  if (!moduleIds.length) return undefined;
  try {
    // `flagged`: the caller already read uses_user_voice with the module row (a chosen Skill: no extra round trip).
    let modules = moduleIds;
    if (!flagged) {
      const rows = await admin.from('modules').select('id,uses_user_voice').in('id', moduleIds);
      if (rows.error) throw new Error('VOICE_MODULES_UNAVAILABLE');
      modules = (rows.data ?? []).filter(row => row.uses_user_voice === true).map(row => String(row.id));
    }
    if (!modules.length) return undefined;
    const current = await admin.rpc('voice_profile_current', { a: actorId });
    if (current.error) throw new Error('VOICE_PROFILE_UNAVAILABLE');
    const view = z.object({ enabled: z.boolean(), versionId: z.string().uuid().nullable(),
      version: z.number().int().positive().nullable() }).parse(current.data);
    if (!view.enabled) return undefined;
    // On, but nothing confirmed yet: the Skill hints once where to set it up (Owner 2026-10-23, A).
    if (!view.versionId || !view.version) return { frozen: { guide: VOICE_GUIDE, modules } };
    const pointer = { versionId: view.versionId, version: view.version };
    const profile = await readVoiceProfile(admin, actorId, pointer.versionId);
    return profile ? { frozen: { guide: VOICE_GUIDE, ...pointer, modules }, profile } : undefined;
  } catch (error) {
    logger.warn('api', 'voice_admission_skipped', { code: error instanceof Error ? error.message : 'unknown' });
    return undefined;
  }
}

/** The text of a frozen version; undefined once the user deleted it or one of its sources. */
export async function readVoiceProfile(db: Rpc, actorId: string, versionId: string): Promise<VoiceProfile | undefined> {
  const read = await db.rpc('voice_profile_read', { a: actorId, vid: versionId });
  if (read.error) throw new Error('VOICE_PROFILE_UNAVAILABLE');
  const parsed = voiceProfile.safeParse((read.data as { profile?: unknown } | null)?.profile);
  return parsed.success ? parsed.data : undefined;
}

/** At execution: the addendum input for the Skill that actually runs (chosen, or matched), or undefined. A version deleted
 * since admission is not injected; the run continues without it. */
export async function executionVoice(db: Rpc, actorId: string, frozen: FrozenVoiceProfile | undefined, moduleId: string | undefined) {
  if (!frozen || !moduleId || !frozen.modules.includes(moduleId)) return undefined;
  if (!frozen.versionId) return { guide: frozen.guide };
  const profile = await readVoiceProfile(db, actorId, frozen.versionId).catch(() => undefined);
  return profile ? { guide: frozen.guide, profile } : undefined;
}

/** The executor's primary addenda (withPrimaryAddenda) plus the voice of the Skill that actually runs: the frozen version's
 * text is read now, so a version deleted since admission is never read again. */
export async function withExecutionVoice(db: Rpc, actorId: string, instructions: string,
  context: Parameters<typeof withPrimaryAddenda>[1] & { voiceProfile?: FrozenVoiceProfile }, moduleId: string | undefined) {
  const voice = await executionVoice(db, actorId, context.voiceProfile, moduleId);
  // Owner 2026-10-23: a deleted voice must not be used, not even by the run in progress. Bound to a version that can no
  // longer be read: end before any provider request (the database also stops it at its next action, 0345).
  if (context.voiceProfile?.versionId && moduleId && context.voiceProfile.modules.includes(moduleId) && !voice) {
    throw new Error('VOICE_SOURCE_DELETED');
  }
  return withPrimaryAddenda(instructions, { ...context, ...(voice ? { voice } : {}) });
}
