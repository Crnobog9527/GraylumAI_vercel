/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { logServerError } from '@/lib/server-log';

/**
 * CHAT-LANGUAGE (Owner 2026-10-25): a public page's login and sign-up links carry the page's language as `lang`. A signed-in
 * visitor never sees the login page: the proxy sends them straight on. For a verified visitor the language is saved here,
 * on the server, before that redirect (the browser may reload the address on its way between the two sites and lose a
 * parameter), and the target only carries `entry_notice=<from>.<to>` for the app to say what changed. Anything else
 * (not verified yet, the save failed) passes the language on as `entry_lang` for the app to apply once it can.
 */
const LANGUAGES = new Set(['zh-Hans', 'zh-Hant', 'en']);
type Language = 'zh-Hans' | 'zh-Hant' | 'en';
const isLanguage = (value: unknown): value is Language => typeof value === 'string' && LANGUAGES.has(value);

export function entryLanguageOf(request: NextRequest): Language | null {
  const lang = request.nextUrl.searchParams.get('lang');
  return isLanguage(lang) ? lang : null;
}

/** A background prefetch of the link (Next's router, or the browser's speculative loading): the visitor has not followed it. */
export function isPrefetch(request: NextRequest): boolean {
  const h = request.headers;
  return h.has('next-router-prefetch') || h.has('x-middleware-prefetch') || h.get('purpose') === 'prefetch'
    || (h.get('sec-purpose') ?? '').includes('prefetch');
}

export async function withEntryLanguage(target: URL, request: NextRequest, verifiedUserId: string | null): Promise<URL> {
  const language = entryLanguageOf(request);
  if (!language) return target;
  // Never saved for a prefetch: only following the link takes the page language. If the click then reuses the prefetched
  // redirect, the app applies the entry_lang it carries.
  if (verifiedUserId && !isPrefetch(request)) {
    const previous = await saveEntryLanguage(verifiedUserId, language);
    if (previous) {
      target.searchParams.set('entry_notice', `${previous}.${language}`);
      return target;
    }
  }
  target.searchParams.set('entry_lang', language);
  return target;
}

/** Writes the caller's own reply language with the service role; returns the one before, or null when it could not. */
async function saveEntryLanguage(userId: string, language: Language): Promise<Language | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const before = await admin.from('profiles').select('reply_language').eq('id', userId).single();
    if (before.error) throw before.error;
    const stored = (before.data as { reply_language?: unknown } | null)?.reply_language;
    const update = await admin.from('profiles').update({ reply_language: language }).eq('id', userId);
    if (update.error) throw update.error;
    return isLanguage(stored) ? stored : 'zh-Hans';
  } catch (error) {
    logServerError('auth', 'proxy_entry_language_save_failed', { code: (error as { code?: string } | null)?.code ?? null });
    return null;
  }
}
