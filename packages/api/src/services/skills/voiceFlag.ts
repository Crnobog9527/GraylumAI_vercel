/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/** VOICE: the administrator's per-Skill "使用用户文风" flag (modules.uses_user_voice, 0337), saved on its own.
 * Same compare-and-set as the social media flag (socialMediaFlag.ts). */
export const VOICE_FLAG_ERRORS = ['VOICE_FLAG_UNAVAILABLE', 'VOICE_FLAG_MODULE_NOT_FOUND', 'VOICE_FLAG_CONFLICT'] as const;

export async function readVoiceFlag(db: SupabaseClient, moduleId: string) {
  const result = await db.from('modules').select('id,uses_user_voice,updated_at').eq('id', moduleId).maybeSingle();
  if (result.error) throw new Error('VOICE_FLAG_UNAVAILABLE');
  if (!result.data) throw new Error('VOICE_FLAG_MODULE_NOT_FOUND');
  return { moduleId: result.data.id as string, usesUserVoice: result.data.uses_user_voice === true,
    moduleUpdatedAt: result.data.updated_at as string };
}

export async function saveVoiceFlag(db: SupabaseClient, input: {
  moduleId: string; usesUserVoice: boolean; expectedUsesUserVoice: boolean; expectedModuleUpdatedAt: string;
}) {
  await readVoiceFlag(db, input.moduleId);
  const result = await db.from('modules')
    .update({ uses_user_voice: input.usesUserVoice, updated_at: new Date().toISOString() })
    .eq('id', input.moduleId).eq('uses_user_voice', input.expectedUsesUserVoice)
    .eq('updated_at', input.expectedModuleUpdatedAt).select('id,uses_user_voice,updated_at');
  if (result.error) throw new Error('VOICE_FLAG_UNAVAILABLE');
  if (result.data?.length !== 1) throw new Error('VOICE_FLAG_CONFLICT');
  const row = result.data[0]!;
  return { moduleId: row.id as string, usesUserVoice: row.uses_user_voice === true, moduleUpdatedAt: row.updated_at as string };
}
