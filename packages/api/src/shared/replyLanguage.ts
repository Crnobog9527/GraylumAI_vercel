/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/** Owner 2026-10-24 (A): the language a user picks in the profile decides the language of every AI reply.
 * Stored on profiles.reply_language; no value means Simplified Chinese. The interface itself stays Simplified Chinese. */
export const REPLY_LOCALES = ['zh-Hans', 'zh-Hant', 'en'] as const;
export type ReplyLocale = (typeof REPLY_LOCALES)[number];
export const DEFAULT_REPLY_LOCALE = 'zh-Hans' satisfies ReplyLocale;
export const replyLocale = z.enum(REPLY_LOCALES);

/** How each choice is shown in the profile, in its own script. */
export const REPLY_LOCALE_LABELS: Record<ReplyLocale, string> = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English' };

/** The stored value, or the default when the profile has none (or an unknown one). */
export function effectiveReplyLocale(stored: unknown): ReplyLocale {
  const parsed = replyLocale.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_REPLY_LOCALE;
}

/** The `lang` hint a sign-up link carries (the Traditional Chinese pages send zh-Hant); anything else is no hint. */
export type EntryLocale = Exclude<ReplyLocale, typeof DEFAULT_REPLY_LOCALE>;
export const entryLocale = replyLocale.exclude(['zh-Hans']);
export function entryLocaleHint(value: string | null | undefined): EntryLocale | null {
  const parsed = entryLocale.safeParse(value);
  return parsed.success ? parsed.data : null;
}
