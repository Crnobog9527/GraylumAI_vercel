/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

import { entryLocaleHint, type EntryLocale } from '@repo/api/src/shared/replyLanguage';

/**
 * CHAT-LANGUAGE (Owner 2026-10-24, A): a sign-up started from the Traditional Chinese pages carries `lang=zh-Hant`. The
 * login page keeps that hint here until the account exists, then the app applies it once (only while the user never chose
 * a language) and clears it. Only the language code is stored; storage may be unavailable, which just drops the hint.
 */
const KEY = 'graylum.entry-language';

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function rememberEntryLanguage(value: string | null): void {
  const hint = entryLocaleHint(value);
  if (!hint) return;
  try { storage()?.setItem(KEY, hint); } catch { /* storage full or blocked */ }
}

export function pendingEntryLanguage(): EntryLocale | null {
  try { return entryLocaleHint(storage()?.getItem(KEY)); } catch { return null; }
}

export function clearEntryLanguage(): void {
  try { storage()?.removeItem(KEY); } catch { /* storage unavailable */ }
}
