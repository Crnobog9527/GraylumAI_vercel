/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { entryLocaleHint, REPLY_LOCALE_LABELS, type ReplyLocale } from '@repo/api/src/shared/replyLanguage';

/**
 * CHAT-LANGUAGE (Owner 2026-10-25): a public page's login and sign-up links carry the page's language (`lang`). The login
 * page keeps it here; once the user is signed in the app applies it (over any earlier choice) and clears it. Opening the
 * login page without `lang` (not from a public page) clears it, and it lapses after two hours, so an abandoned visit never
 * changes a later sign-in. Only the language code and a time are stored; storage may be unavailable, which drops the hint.
 */
const KEY = 'graylum.entry-language';
export const ENTRY_LANGUAGE_TTL_MS = 2 * 60 * 60 * 1000;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** On the login page: keep the link's language, or forget any earlier one when the link carried none. */
export function rememberEntryLanguage(value: string | null, now = Date.now()): void {
  const hint = entryLocaleHint(value);
  try {
    if (hint) storage()?.setItem(KEY, JSON.stringify({ language: hint, at: now }));
    else storage()?.removeItem(KEY);
  } catch { /* storage full or blocked */ }
}

export function pendingEntryLanguage(now = Date.now()): ReplyLocale | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { language?: unknown; at?: unknown };
    const fresh = typeof stored.at === 'number' && now - stored.at >= 0 && now - stored.at < ENTRY_LANGUAGE_TTL_MS;
    return fresh ? entryLocaleHint(typeof stored.language === 'string' ? stored.language : null) : null;
  } catch { return null; }
}

export function clearEntryLanguage(): void {
  try { storage()?.removeItem(KEY); } catch { /* storage unavailable */ }
}

/** What the app says after applying it: which language AI replies now use, and what it replaced. */
export function entryLanguageNotice(applied: { language: ReplyLocale; previous: ReplyLocale }): { title: string; description: string } {
  const now = REPLY_LOCALE_LABELS[applied.language];
  return { title: `AI 回复语言：${now}`, description: applied.previous === applied.language
    ? '按你进入的页面设置。可在右上角「语言」修改。'
    : `已按你进入的页面，从${REPLY_LOCALE_LABELS[applied.previous]}改为${now}。可在右上角「语言」修改。` };
}
