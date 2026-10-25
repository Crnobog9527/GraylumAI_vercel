/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { effectiveReplyLocale, type ReplyLocale } from '../shared/replyLanguage';

/** CHAT-LANGUAGE (Owner 2026-10-24, A). profiles.reply_language is written only here, with the service role, for the
 * caller's own row (0364): the client UPDATE policy also checks the nickname, which a user may never have set. */
export async function setReplyLanguage(admin: SupabaseClient, profileId: string, locale: ReplyLocale): Promise<ReplyLocale> {
  const { data, error } = await admin.from('profiles').update({ reply_language: locale }).eq('id', profileId)
    .select('reply_language').single();
  if (error) throw new Error('REPLY_LANGUAGE_SAVE_FAILED');
  return effectiveReplyLocale((data as { reply_language?: unknown }).reply_language);
}

/** Owner 2026-10-25: signing in through a public page always takes that page's language, even over an earlier choice
 * ("永远以落地页的语言为准"). Returns the language now in effect and the one before, so the app can say what changed. */
export async function applyEntryReplyLanguage(admin: SupabaseClient, profileId: string, hint: ReplyLocale):
  Promise<{ language: ReplyLocale; previous: ReplyLocale }> {
  const before = await admin.from('profiles').select('reply_language').eq('id', profileId).single();
  if (before.error) throw new Error('REPLY_LANGUAGE_SAVE_FAILED');
  const previous = effectiveReplyLocale((before.data as { reply_language?: unknown }).reply_language);
  return { language: await setReplyLanguage(admin, profileId, hint), previous };
}
