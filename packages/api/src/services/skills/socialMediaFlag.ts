/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';

/** POSITIONING-GATE: the administrator's per-Skill "与社交媒体相关" flag, saved on its own. */
export const SOCIAL_MEDIA_FLAG_ERRORS = ['SOCIAL_MEDIA_FLAG_UNAVAILABLE', 'SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND',
  'SOCIAL_MEDIA_FLAG_CONFLICT'] as const;
export type SocialMediaFlagError = typeof SOCIAL_MEDIA_FLAG_ERRORS[number];

export async function readSocialMediaFlag(db: SupabaseClient, moduleId: string) {
  const result = await db.from('modules').select('id,social_media_related').eq('id', moduleId).maybeSingle();
  if (result.error) throw new Error('SOCIAL_MEDIA_FLAG_UNAVAILABLE');
  if (!result.data) throw new Error('SOCIAL_MEDIA_FLAG_MODULE_NOT_FOUND');
  return { moduleId: result.data.id as string, socialMediaRelated: result.data.social_media_related === true };
}

/** Compare-and-set: a page that read an older value cannot overwrite a newer one. */
export async function saveSocialMediaFlag(db: SupabaseClient, input: {
  moduleId: string; socialMediaRelated: boolean; expectedSocialMediaRelated: boolean;
}) {
  await readSocialMediaFlag(db, input.moduleId);
  const result = await db.from('modules')
    .update({ social_media_related: input.socialMediaRelated, updated_at: new Date().toISOString() })
    .eq('id', input.moduleId).eq('social_media_related', input.expectedSocialMediaRelated).select('id');
  if (result.error) throw new Error('SOCIAL_MEDIA_FLAG_UNAVAILABLE');
  if (result.data?.length !== 1) throw new Error('SOCIAL_MEDIA_FLAG_CONFLICT');
  return readSocialMediaFlag(db, input.moduleId);
}
