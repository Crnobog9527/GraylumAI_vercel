/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { CACHE_KEY, CACHE_MAX_AGE_MS, CHAT_KEY, MAX_CONVERSATIONS, clearPersistedCache, forgetPending, persistQueryCache, restoreQueryCache } from './persisted-cache';
import { readCachedChatView, writeCachedChatView } from './persisted-chat';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;
const view = { messages: [{ id: 'm1' }] } as never;

function storage(limit = Infinity) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { if (value.length > limit) throw new Error('quota'); data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}
const key = (path: string[], input: unknown = {}) => [path, { input, type: 'query' }];
function client(entries: Array<[unknown[], unknown, number?]>) {
  const qc = new QueryClient();
  for (const [k, data, at] of entries) qc.setQueryData(k, data, { updatedAt: at ?? NOW });
  return qc;
}

describe('persisted query cache', () => {
  it('saves only the listed reads and puts them back for the same user', () => {
    const s = storage();
    const qc = client([[key(['opc', 'conversations']), [{ id: 'c1' }]], [key(['credits', 'createCheckout']), { url: 'https://pay' }], [key(['admin', 'users']), ['x']]]);
    persistQueryCache(qc, USER, { storage: s, now: NOW, build: 'b1' });
    const text = s.data.get(CACHE_KEY) ?? '';
    expect(text).toContain('conversations');
    expect(text).not.toContain('createCheckout');
    expect(text).not.toContain('admin');
    const fresh = new QueryClient();
    expect(restoreQueryCache(fresh, USER, { storage: s, now: NOW + 1000, build: 'b1' })).toBe(true);
    expect(fresh.getQueryData(key(['opc', 'conversations']))).toEqual([{ id: 'c1' }]);
    expect(fresh.getQueryData(key(['credits', 'createCheckout']))).toBeUndefined();
  });

  it('shows nothing of another user, another build, or an older day, and drops what it refused', () => {
    for (const [user, build, now] of [[OTHER, 'b1', NOW], [USER, 'b2', NOW], [USER, 'b1', NOW + CACHE_MAX_AGE_MS + 1], [null, 'b1', NOW]] as const) {
      const s = storage();
      persistQueryCache(client([[key(['opc', 'list']), ['a']]]), USER, { storage: s, now: NOW, build: 'b1' });
      const fresh = new QueryClient();
      expect(restoreQueryCache(fresh, user, { storage: s, now, build })).toBe(false);
      expect(fresh.getQueryData(key(['opc', 'list']))).toBeUndefined();
      expect(s.data.has(CACHE_KEY)).toBe(false);
    }
  });

  it('keeps only the newest conversations of a per-conversation read', () => {
    const s = storage();
    const entries = Array.from({ length: MAX_CONVERSATIONS + 5 }, (_, i): [unknown[], unknown, number] => [key(['runtime', 'view'], { sessionId: `s${i}` }), { i }, NOW - i * 1000]);
    persistQueryCache(client(entries), USER, { storage: s, now: NOW, build: 'b1' });
    const fresh = new QueryClient();
    restoreQueryCache(fresh, USER, { storage: s, now: NOW, build: 'b1' });
    expect(fresh.getQueryCache().getAll()).toHaveLength(MAX_CONVERSATIONS);
    expect(fresh.getQueryData(key(['runtime', 'view'], { sessionId: 's0' }))).toEqual({ i: 0 });
    expect(fresh.getQueryData(key(['runtime', 'view'], { sessionId: `s${MAX_CONVERSATIONS + 4}` }))).toBeUndefined();
  });

  it('treats a full or broken storage as nothing saved, without throwing', () => {
    const full = storage(10);
    expect(() => persistQueryCache(client([[key(['opc', 'list']), ['a']]]), USER, { storage: full, now: NOW })).not.toThrow();
    expect(full.data.size).toBe(0);
    const broken = storage();
    broken.data.set(CACHE_KEY, '{not json');
    expect(restoreQueryCache(new QueryClient(), USER, { storage: broken })).toBe(false);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => persistQueryCache(client([]), USER, { storage: throwing })).not.toThrow();
    expect(restoreQueryCache(new QueryClient(), USER, { storage: throwing })).toBe(false);
    expect(() => clearPersistedCache({ storage: throwing })).not.toThrow();
  });

  it('does not write back a read that was invalidated, nor keep what was saved for it', () => {
    const s = storage();
    const qc = client([[key(['opc', 'sessionResults'], { sessionId: 'gone' }), ['r']], [key(['opc', 'list']), ['a']]]);
    persistQueryCache(qc, USER, { storage: s, now: NOW, build: 'b1' });
    void qc.invalidateQueries({ refetchType: 'none' });
    persistQueryCache(qc, USER, { storage: s, now: NOW, build: 'b1' });
    expect(s.data.get(CACHE_KEY) ?? '').not.toContain('gone');
    expect(s.data.get(CACHE_KEY) ?? '').not.toContain('"a"');
  });

  it('marks what it puts back as needing a read (shown meanwhile, still saved), until something invalidates it', () => {
    const s = storage();
    persistQueryCache(client([[key(['opc', 'list']), ['a']]]), USER, { storage: s, now: NOW, build: 'b1' });
    const fresh = new QueryClient();
    restoreQueryCache(fresh, USER, { storage: s, now: NOW, build: 'b1' });
    const query = fresh.getQueryCache().getAll()[0]!;
    expect(fresh.getQueryData(key(['opc', 'list']))).toEqual(['a']);
    expect(query.isStale(), 'the first mount reads it again whatever staleTime says').toBe(true);
    persistQueryCache(fresh, USER, { storage: s, now: NOW, build: 'b1' });
    expect(s.data.get(CACHE_KEY) ?? '').toContain('"a"');
    forgetPending(query.queryHash); // what the provider does when something invalidates it later (a deletion)
    persistQueryCache(fresh, USER, { storage: s, now: NOW, build: 'b1' });
    expect(s.data.get(CACHE_KEY) ?? '').not.toContain('"a"');
  });

  it('writes nothing for nobody and clears what was there', () => {
    const s = storage();
    persistQueryCache(client([[key(['opc', 'list']), ['a']]]), USER, { storage: s, now: NOW, build: 'b1' });
    persistQueryCache(client([]), null, { storage: s });
    expect(s.data.size).toBe(0);
  });
});

describe('persisted chat view', () => {
  it('keeps the last read per conversation for its own user only, and clears with the rest', () => {
    const s = storage();
    writeCachedChatView(USER, 'c1', view, { storage: s, now: NOW, build: 'b1' });
    expect(readCachedChatView(USER, 'c1', { storage: s, now: NOW, build: 'b1' })).toEqual(view);
    expect(readCachedChatView(OTHER, 'c1', { storage: s, now: NOW, build: 'b1' })).toBeNull();
    expect(readCachedChatView(USER, 'c1', { storage: s, now: NOW, build: 'b2' })).toBeNull();
    expect(readCachedChatView(USER, 'c1', { storage: s, now: NOW + CACHE_MAX_AGE_MS + 1, build: 'b1' })).toBeNull();
    expect(readCachedChatView(null, 'c1', { storage: s, now: NOW, build: 'b1' })).toBeNull();
    clearPersistedCache({ storage: s });
    expect(s.data.has(CHAT_KEY)).toBe(false);
  });

  it('forgets a conversation whose read came back empty instead of keeping or showing it', () => {
    const s = storage();
    writeCachedChatView(USER, 'c1', view, { storage: s, now: NOW, build: 'b1' });
    writeCachedChatView(USER, 'c1', { messages: [] } as never, { storage: s, now: NOW, build: 'b1' });
    expect(readCachedChatView(USER, 'c1', { storage: s, now: NOW, build: 'b1' })).toBeNull();
  });

  it('keeps 20 conversations, skips a huge one, and survives a full storage', () => {
    const s = storage();
    for (let i = 0; i < 25; i++) writeCachedChatView(USER, `c${i}`, view, { storage: s, now: NOW, build: 'b1' });
    expect(readCachedChatView(USER, 'c24', { storage: s, now: NOW, build: 'b1' })).toEqual(view);
    expect(readCachedChatView(USER, 'c0', { storage: s, now: NOW, build: 'b1' })).toBeNull();
    writeCachedChatView(USER, 'big', { text: 'x'.repeat(400_000) } as never, { storage: s, now: NOW, build: 'b1' });
    expect(readCachedChatView(USER, 'big', { storage: s, now: NOW, build: 'b1' })).toBeNull();
    expect(() => writeCachedChatView(USER, 'c1', view, { storage: storage(5), now: NOW })).not.toThrow();
  });
});
