/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { effectiveReplyLocale, type ReplyLocale } from '../../shared/replyLanguage';
import { stagingRpcFailure } from './stagingErrors';

/** Owner 2026-10-24 (A): replies follow the language set in the profile, not the language of the user's messages
 * (which replaced reply-language-v1); an explicit request for another language wins for what was asked.
 * v3 (2026-10-25, the same decision written out): what the reply creates (titles, names, examples, copy) is in the set
 * language too, unless the user explicitly asks for another language or says which language their audience uses.
 * Admission freezes one of these values into the execution, so its text replays byte-identical after a settings change
 * or a later wording. */
export const REPLY_LANGUAGE_SETTINGS = {
  'zh-Hans': 'reply-language-v3-zh-Hans', 'zh-Hant': 'reply-language-v3-zh-Hant', en: 'reply-language-v3-en',
} as const satisfies Record<ReplyLocale, string>;
const EARLIER_SETTINGS = {
  'zh-Hans': 'reply-language-v2-zh-Hans', 'zh-Hant': 'reply-language-v2-zh-Hant', en: 'reply-language-v2-en',
} as const satisfies Record<ReplyLocale, string>;
export type FrozenReplySetting = (typeof REPLY_LANGUAGE_SETTINGS)[ReplyLocale] | (typeof EARLIER_SETTINGS)[ReplyLocale];
export const FROZEN_REPLY_SETTINGS = [...Object.values(EARLIER_SETTINGS), ...Object.values(REPLY_LANGUAGE_SETTINGS)] as
  [FrozenReplySetting, ...FrozenReplySetting[]];

const LANGUAGE_NAMES: Record<ReplyLocale, string> = {
  'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese (Taiwan usage)', en: 'English' };

/** The v2 wording, kept for executions frozen with it. */
function replySettingInstructionsV2(locale: ReplyLocale): string {
  return `\nReply language (host rule, takes precedence over any language rule in the Skill): the user set their language to `+
    `${LANGUAGE_NAMES[locale]}. Write replies, questions, card options, drafts and reports in ${LANGUAGE_NAMES[locale]}, `+
    'whatever language the Skill, the material or the user\'s messages are written in. Only when the user explicitly asks '+
    'for another language (for example "write an English version" or "用英文回答"), write what they asked for in that '+
    'language, and keep everything else in the set language. Keep required exact strings (report headings, ids, JSON keys) unchanged.';
}

/** The host rule of one language (current wording). The Skill and host texts are in Chinese; that never decides the reply
 * language, and neither does the language of the user's message. */
export function replySettingInstructions(locale: ReplyLocale): string {
  const name = LANGUAGE_NAMES[locale];
  return `\nReply language (host rule, takes precedence over any language rule in the Skill): the user set their language to `+
    `${name}. Write everything in ${name}: the reply itself and everything it creates, such as titles, names, examples, `+
    `scripts and copy, as well as questions, card options, drafts and reports, whatever language the Skill, the material or `+
    'the user\'s messages are written in. Only when the user explicitly asks for another language (for example "write an '+
    'English version" or "用英文回答"), or explicitly says which language their audience uses, write what that applies to in '+
    'that language, and keep everything else in the set language. Keep required exact strings (report headings, ids, JSON keys) unchanged.';
}

const RULES = new Map<string, string>((Object.keys(LANGUAGE_NAMES) as ReplyLocale[]).flatMap(locale => [
  [EARLIER_SETTINGS[locale], replySettingInstructionsV2(locale)], [REPLY_LANGUAGE_SETTINGS[locale], replySettingInstructions(locale)],
] as Array<[string, string]>));
/** The rule text a frozen value stands for, or undefined for any other value (older executions, unknown text). */
export const frozenReplyRule = (value: unknown): string | undefined => typeof value === 'string' ? RULES.get(value) : undefined;

/** The language set in the user's profile (Simplified Chinese when none). An unreadable profile throws: a turn is refused
 * instead of guessing a language. */
export async function readReplyLocale(admin: SupabaseClient, profileId: string): Promise<ReplyLocale> {
  const { data, error } = await admin.from('profiles').select('reply_language').eq('id', profileId).single();
  if (error) stagingRpcFailure(error);
  return effectiveReplyLocale((data as { reply_language?: unknown } | null)?.reply_language);
}

/** A new execution's frozen value and host rule. Started early and awaited later, so a rejection is never left unhandled. */
export function readReplySetting(admin: SupabaseClient, profileId: string): Promise<{ setting: FrozenReplySetting; rule: string }> {
  const read = readReplyLocale(admin, profileId)
    .then(locale => ({ setting: REPLY_LANGUAGE_SETTINGS[locale], rule: replySettingInstructions(locale) }));
  read.catch(() => {});
  return read;
}
