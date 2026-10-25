/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const db = vi.hoisted(() => ({ stored: null as string | null, readError: null as unknown, writeError: null as unknown,
  writes: [] as Array<{ value: unknown; id: string }>, reads: [] as string[] }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: (table: string) => {
    if (table !== 'profiles') throw new Error('unexpected ' + table);
    let value: unknown = null;
    const q = {
      select: () => q,
      update: (next: unknown) => { value = next; return q; },
      eq: (_column: string, id: string) => {
        if (value) { db.writes.push({ value, id }); return Promise.resolve({ error: db.writeError }); }
        db.reads.push(id); return q;
      },
      single: async () => ({ data: db.readError ? null : { reply_language: db.stored }, error: db.readError }),
    };
    return q;
  } }),
}));
const logged = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server-log', () => ({ logServerError: logged }));

const { withEntryLanguage } = await import('./entry-language-server');
const request = (query: string) => new NextRequest(`https://auth-staging.graylum.com/login?${query}`);
const target = () => new URL('https://auth-staging.graylum.com/app/positioning');

beforeEach(() => {
  Object.assign(db, { stored: 'zh-Hans', readError: null, writeError: null, writes: [], reads: [] });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://synthetic.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic');
  logged.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('a signed-in visitor sent on from a public page login link (CHAT-LANGUAGE, Owner 2026-10-25)', () => {
  it('saves the page language for that user on the server and only tells the app what changed', async () => {
    const url = await withEntryLanguage(target(), request('action=signup&lang=zh-Hant'), 'user-1');
    expect(url.searchParams.get('entry_notice')).toBe('zh-Hans.zh-Hant');
    expect(url.searchParams.has('entry_lang')).toBe(false);
    expect(db.writes).toEqual([{ value: { reply_language: 'zh-Hant' }, id: 'user-1' }]);
    db.stored = null;
    expect((await withEntryLanguage(target(), request('lang=en'), 'user-1')).searchParams.get('entry_notice')).toBe('zh-Hans.en');
  });

  it('passes the language on for the app when it cannot save it, or the visitor is not verified yet', async () => {
    db.writeError = { code: '57014' };
    expect((await withEntryLanguage(target(), request('lang=zh-Hant'), 'user-1')).searchParams.get('entry_lang')).toBe('zh-Hant');
    expect(logged).toHaveBeenCalledWith('auth', 'proxy_entry_language_save_failed', { code: '57014' });
    db.writes = []; db.reads = [];
    expect((await withEntryLanguage(target(), request('lang=zh-Hant'), null)).searchParams.get('entry_lang')).toBe('zh-Hant');
    expect([db.writes, db.reads]).toEqual([[], []]);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect((await withEntryLanguage(target(), request('lang=en'), 'user-1')).searchParams.get('entry_lang')).toBe('en');
  });

  it('does nothing without a valid page language', async () => {
    for (const query of ['', 'lang=fr', 'lang=']) {
      const url = await withEntryLanguage(target(), request(query), 'user-1');
      expect(url.search).toBe('');
    }
    expect(db.writes).toEqual([]);
  });
});
