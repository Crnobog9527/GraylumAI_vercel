/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import { cacheBuild } from '@/lib/site-config';

/*
 * UI-FINISH: what the logged-in pages read most (the conversation list, the open conversation, the profile and balance) is kept in this
 * browser's localStorage, per user, and shown at once after a reload while the same reads run again behind it and replace it. localStorage
 * is read synchronously, so the saved data is in place before the first paint; an asynchronous store could not do that.
 *
 * It is a convenience, never a source of truth, so every failure (full storage, unreadable data, another user's data, an older build)
 * means "nothing saved": no error, no page effect. Payment, checkout, admin and secret-bearing reads are not on the list below and are never
 * written. It is cleared when the user signs out (trpc/provider.tsx), and refused whenever its user is not the signed-in one.
 */
export const CACHE_KEY = 'graylum:cache:v1';
/** The last read of each recent conversation's messages (lib/persisted-chat.ts); cleared together with the reads above. */
export const CHAT_KEY = 'graylum:chat:v1';
export const CACHE_MAX_AGE_MS = 24 * 3600_000;
/** The saved reads, by procedure path. Nothing outside this list is ever written. */
export const PERSISTED_PATHS: ReadonlySet<string> = new Set([
  'opc.conversations', 'opc.list', 'opc.library', 'opc.catalog', 'opc.businesses', 'opc.sessionResults',
  'runtime.view', 'runtime.choices', 'user.getUserProfile', 'user.getEntitlements', 'credits.getBalance', 'publishMonitor.features',
]);
/** The reads that are per conversation: only the most recent ones are kept. */
const PER_CONVERSATION = new Set(['runtime.view', 'opc.sessionResults']);
export const MAX_CONVERSATIONS = 20;
export const MAX_BYTES = 1_500_000;

type Saved = { v: 1; build: string; userId: string; savedAt: number; queries: DehydratedState['queries'] };
export type Options = { storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; now?: number; build?: string };

export const buildOf = cacheBuild;
export const storageOf = (options?: Options) => { try { return options?.storage ?? globalThis.localStorage ?? null; } catch { return null; } };

/** `opc.conversations` for a tRPC key `[['opc','conversations'], {...}]`; null for anything else. */
export function queryPath(key: readonly unknown[]): string | null {
  const path = key[0];
  return Array.isArray(path) && path.length > 0 && path.every(part => typeof part === 'string') ? path.join('.') : null;
}

export function clearPersistedCache(options?: Options) {
  for (const key of [CACHE_KEY, CHAT_KEY]) {
    try { storageOf(options)?.removeItem(key); } catch { /* nothing saved either way */ }
  }
}

type Queries = DehydratedState['queries'];

/** The listed reads, the per-conversation ones limited to the newest, nothing older than a day. */
export function limitQueries(queries: Queries, now: number): Queries {
  const live = queries.filter(query => PERSISTED_PATHS.has(queryPath(query.queryKey) ?? '') && now - query.state.dataUpdatedAt <= CACHE_MAX_AGE_MS);
  const newest = new Map<string, number[]>();
  for (const query of live) {
    const path = queryPath(query.queryKey) ?? '';
    if (PER_CONVERSATION.has(path)) newest.set(path, [...(newest.get(path) ?? []), query.state.dataUpdatedAt].sort((a, b) => b - a));
  }
  return live.filter(query => {
    const times = newest.get(queryPath(query.queryKey) ?? '');
    return !times || query.state.dataUpdatedAt >= (times[MAX_CONVERSATIONS - 1] ?? 0);
  });
}

/**
 * What is in the client now: the listed reads that succeeded and are still valid. A read marked invalid (a deleted conversation or result
 * invalidates the reads that showed it) is not saved, even when nothing has read it again yet.
 */
export function selectQueries(client: QueryClient, now: number = Date.now()): Queries {
  return limitQueries(dehydrate(client, { shouldDehydrateQuery: query => query.state.status === 'success' && !query.state.isInvalidated }).queries, now);
}

function savedQueries(storage: NonNullable<ReturnType<typeof storageOf>>, userId: string, now: number, build: string): Queries {
  try {
    const saved = JSON.parse(storage.getItem(CACHE_KEY) ?? 'null') as Partial<Saved> | null;
    return saved?.v === 1 && saved.build === build && saved.userId === userId && Array.isArray(saved.queries) ? limitQueries(saved.queries, now) : [];
  } catch { return []; }
}

export function persistQueryCache(client: QueryClient, userId: string | null, options?: Options) {
  const storage = storageOf(options);
  if (!storage) return;
  try {
    if (!userId) { clearPersistedCache(options); return; }
    // What is in memory replaces what was saved for the same read; the rest of what was saved stays (the page may not have asked for it).
    const now = options?.now ?? Date.now(), build = options?.build ?? buildOf();
    const merged = new Map(savedQueries(storage, userId, now, build).map(query => [query.queryHash, query]));
    // What was saved for a read that is invalid now goes too, not only what would be written.
    for (const query of client.getQueryCache().getAll()) if (query.state.isInvalidated) merged.delete(query.queryHash);
    for (const query of selectQueries(client, now)) merged.set(query.queryHash, query);
    let queries = limitQueries([...merged.values()], now);
    const write = () => JSON.stringify({ v: 1, build, userId, savedAt: now, queries } satisfies Saved);
    let text = write();
    // Over the cap: drop the least recently updated per-conversation reads first, then give up.
    while (text.length > MAX_BYTES) {
      const oldest = queries.filter(query => PER_CONVERSATION.has(queryPath(query.queryKey) ?? ''))
        .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)[0];
      if (!oldest) { clearPersistedCache(options); return; }
      queries = queries.filter(query => query !== oldest);
      text = write();
    }
    storage.setItem(CACHE_KEY, text);
  } catch {
    clearPersistedCache(options); // full or refused: nothing saved
  }
}

/** Puts the saved reads of `userId` into the client. False (and the saved data dropped) when there is nothing usable for this user. */
export function restoreQueryCache(client: QueryClient, userId: string | null, options?: Options): boolean {
  const storage = storageOf(options);
  if (!storage) return false;
  try {
    const raw = storage.getItem(CACHE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as Partial<Saved>;
    const usable = userId !== null && saved.v === 1 && saved.build === (options?.build ?? buildOf()) && saved.userId === userId
      && typeof saved.savedAt === 'number' && (options?.now ?? Date.now()) - saved.savedAt <= CACHE_MAX_AGE_MS && Array.isArray(saved.queries);
    if (!usable) { clearPersistedCache(options); return false; }
    const queries = limitQueries(saved.queries as Queries, options?.now ?? Date.now());
    hydrate(client, { mutations: [], queries });
    return queries.length > 0;
  } catch {
    clearPersistedCache(options);
    return false;
  }
}
