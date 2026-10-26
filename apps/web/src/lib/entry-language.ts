/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { entryLocaleHint, REPLY_LOCALE_LABELS, type ReplyLocale } from '@repo/api/src/shared/replyLanguage';

/**
 * CHAT-LANGUAGE (Owner 2026-10-25): a public page's login and sign-up links carry the page's language (`lang` on the login
 * page, `entry_lang` after the server sends a signed-in visitor straight on). It is kept here; once the user is signed in the
 * app applies it (over any earlier choice) and clears it. It lapses after two hours, so an abandoned visit never changes a
 * later sign-in; an address without it changes nothing (e-mail verification returns to the plain login page mid-way).
 * Only the language code and a time are stored; storage may be unavailable, which drops the hint.
 */
const KEY = 'graylum.entry-language';
export const ENTRY_LANGUAGE_TTL_MS = 2 * 60 * 60 * 1000;

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Keep the language a public page passed on; anything else (none, unknown) leaves an earlier one as it was. */
export function rememberEntryLanguage(value: string | null, now = Date.now()): void {
  const hint = entryLocaleHint(value);
  if (!hint) return;
  try { storage()?.setItem(KEY, JSON.stringify({ language: hint, at: now })); } catch { /* storage full or blocked */ }
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

const CHANGE_KEY = 'graylum.entry-language.change';
/** How long a change just made still explains a repeat that finds nothing to change. */
export const ENTRY_CHANGE_WINDOW_MS = 60 * 1000;

/**
 * What the app says after applying it: which language AI replies now use, and what it replaced. Coming from a page under
 * another root layout (the Traditional Chinese site), the browser opens the app address once inside that page and then
 * loads it again as a new page, so the language is applied twice: the first time records the change, which the page that
 * stays then shows (the repeat finds nothing to change).
 */
export function entryLanguageNotice(applied: { language: ReplyLocale; previous: ReplyLocale }, now = Date.now()):
  { title: string; description: string } {
  let from = applied.previous;
  try {
    if (applied.previous !== applied.language) {
      storage()?.setItem(CHANGE_KEY, JSON.stringify({ from: applied.previous, to: applied.language, at: now, shows: 1 }));
    } else {
      const earlier = recentChange(applied.language, now)?.from ?? null;
      if (earlier) from = earlier;
    }
  } catch { /* storage unavailable: describe this application alone */ }
  return noticeText(from, applied.language);
}

function noticeText(from: ReplyLocale, language: ReplyLocale) {
  const current = REPLY_LOCALE_LABELS[language];
  return { title: `AI 回复语言：${current}`, description: from === language
    ? '按你进入的页面设置。可在右上角「语言」修改。'
    : `已按你进入的页面，从${REPLY_LOCALE_LABELS[from]}改为${current}。可在右上角「语言」修改。` };
}

/** The change recorded within the last minute (to `language` when given), or null. */
function recentChange(language: ReplyLocale | null, now: number) {
  const raw = storage()?.getItem(CHANGE_KEY);
  const change = raw ? JSON.parse(raw) as { from?: unknown; to?: unknown; at?: unknown; shows?: unknown } : null;
  if (!change || typeof change.at !== 'number' || now - change.at < 0 || now - change.at >= ENTRY_CHANGE_WINDOW_MS) return null;
  const from = entryLocaleHint(typeof change.from === 'string' ? change.from : null);
  const to = entryLocaleHint(typeof change.to === 'string' ? change.to : null);
  return from && to && (!language || to === language) ? { from, to, at: change.at, shows: typeof change.shows === 'number' ? change.shows : 1 } : null;
}

/**
 * The page that stays after the two loads (see above) may find nothing to apply: when the server already saved the language
 * (`entry_notice`) or the first load finished applying it, the first load's notice died with that page. So a document that has
 * not announced anything itself repeats a change made within the last minute, once: the second load. Null otherwise.
 */
export function repeatedEntryNotice(now = Date.now()): { title: string; description: string } | null {
  try {
    const change = recentChange(null, now);
    if (!change || change.shows >= 2) return null;
    storage()?.setItem(CHANGE_KEY, JSON.stringify({ from: change.from, to: change.to, at: change.at, shows: 2 }));
    return noticeText(change.from, change.to);
  } catch { return null; }
}

/** The `entry_notice=<from>.<to>` the server adds after saving a public page's language itself (lib/entry-language-server). */
export function parseEntryNotice(value: string | null): { language: ReplyLocale; previous: ReplyLocale } | null {
  const [from, to, extra] = (value ?? '').split('.');
  const previous = entryLocaleHint(from), language = entryLocaleHint(to);
  return previous && language && extra === undefined ? { language, previous } : null;
}
