/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { effectiveReplyLocale, type EntryLocale, type ReplyLocale } from '../shared/replyLanguage';

/** CHAT-LANGUAGE (Owner 2026-10-24, A). profiles.reply_language is written only here, with the service role, for the
 * caller's own row (0364): the client UPDATE policy also checks the nickname, which a user may never have set. */
export async function setReplyLanguage(admin: SupabaseClient, profileId: string, locale: ReplyLocale): Promise<ReplyLocale> {
  const { data, error } = await admin.from('profiles').update({ reply_language: locale }).eq('id', profileId)
    .select('reply_language').single();
  if (error) throw new Error('REPLY_LANGUAGE_SAVE_FAILED');
  return effectiveReplyLocale((data as { reply_language?: unknown }).reply_language);
}

/** A sign-up from the Traditional Chinese pages starts in Traditional Chinese: applied once, only while the user has never
 * chosen a language, so it never overrides a choice. Returns the language now in effect. */
export async function applyEntryReplyLanguage(admin: SupabaseClient, profileId: string, hint: EntryLocale): Promise<ReplyLocale> {
  const update = await admin.from('profiles').update({ reply_language: hint }).eq('id', profileId).is('reply_language', null)
    .select('reply_language');
  if (update.error) throw new Error('REPLY_LANGUAGE_SAVE_FAILED');
  if (update.data?.length) return hint;
  const current = await admin.from('profiles').select('reply_language').eq('id', profileId).single();
  if (current.error) throw new Error('REPLY_LANGUAGE_SAVE_FAILED');
  return effectiveReplyLocale((current.data as { reply_language?: unknown }).reply_language);
}
