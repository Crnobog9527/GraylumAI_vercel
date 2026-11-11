/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Owner 2026-10-24 (A): the language a user picks in the profile decides the language of every AI reply.
 * Stored on profiles.reply_language; no value means Simplified Chinese. The interface itself stays Simplified Chinese.
 *
 * This file has no imports on purpose: the browser loads it on every page (the language a public page's login link carries,
 * the language switch), so it must not bring the validation library with it. The zod schema is in replyLanguage.ts. */
export const REPLY_LOCALES = ['zh-Hans', 'zh-Hant', 'en'] as const;
export type ReplyLocale = (typeof REPLY_LOCALES)[number];
export const DEFAULT_REPLY_LOCALE = 'zh-Hans' satisfies ReplyLocale;

/** How each choice is shown in the profile, in its own script. */
export const REPLY_LOCALE_LABELS: Record<ReplyLocale, string> = { 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English' };

/** One of the three stored values, exactly as written. */
export function isReplyLocale(value: unknown): value is ReplyLocale {
  return typeof value === 'string' && (REPLY_LOCALES as readonly string[]).includes(value);
}

/** The stored value, or the default when the profile has none (or an unknown one). */
export function effectiveReplyLocale(stored: unknown): ReplyLocale {
  return isReplyLocale(stored) ? stored : DEFAULT_REPLY_LOCALE;
}

/** The `lang` a public page's login or sign-up link carries (the page's language, Owner 2026-10-25); anything else is none. */
export function entryLocaleHint(value: string | null | undefined): ReplyLocale | null {
  return isReplyLocale(value) ? value : null;
}
