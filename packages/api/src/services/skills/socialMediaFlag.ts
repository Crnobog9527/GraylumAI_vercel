/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/** POSITIONING-GATE: the administrator's per-Skill "与社交媒体相关" flag, saved on its own. */
export const SOCIAL_MEDIA_FLAG_ERRORS = ['SOCIAL_MEDIA_FLAG_UNAVAILABLE', 'SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND',
  'SOCIAL_MEDIA_FLAG_CONFLICT', 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL'] as const;
export type SocialMediaFlagError = typeof SOCIAL_MEDIA_FLAG_ERRORS[number];

export async function readSocialMediaFlag(db: SupabaseClient, moduleId: string) {
  const result = await db.from('modules').select('id,social_media_related,updated_at').eq('id', moduleId).maybeSingle();
  if (result.error) throw new Error('SOCIAL_MEDIA_FLAG_UNAVAILABLE');
  if (!result.data) throw new Error('SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND');
  return { moduleId: result.data.id as string, socialMediaRelated: result.data.social_media_related === true,
    moduleUpdatedAt: result.data.updated_at as string };
}

/**
 * Compare-and-set on both the flag and the module version the editor opened. The editor may then adopt
 * the new version without hiding any other change, so its later module save still detects edits made elsewhere.
 */
export async function saveSocialMediaFlag(db: SupabaseClient, input: {
  moduleId: string; socialMediaRelated: boolean; expectedSocialMediaRelated: boolean; expectedModuleUpdatedAt: string;
}) {
  await readSocialMediaFlag(db, input.moduleId);
  const result = await db.from('modules')
    .update({ social_media_related: input.socialMediaRelated, updated_at: new Date().toISOString() })
    .eq('id', input.moduleId).eq('social_media_related', input.expectedSocialMediaRelated)
    .eq('updated_at', input.expectedModuleUpdatedAt).select('id,social_media_related,updated_at');
  // The database refuses flagging the positioning Skill (0219 guard); turning the flag off is always allowed.
  if (result.error?.message === 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL') throw new Error('SOCIAL_MEDIA_FLAG_POSITIONING_SKILL');
  if (result.error) throw new Error('SOCIAL_MEDIA_FLAG_UNAVAILABLE');
  if (result.data?.length !== 1) throw new Error('SOCIAL_MEDIA_FLAG_CONFLICT');
  // The version comes from this conditional write itself, never from a later read another save could move.
  const row = result.data[0]!;
  return { moduleId: row.id as string, socialMediaRelated: row.social_media_related === true, moduleUpdatedAt: row.updated_at as string };
}
