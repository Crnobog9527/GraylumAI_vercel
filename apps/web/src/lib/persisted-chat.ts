/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { TurnView } from '@repo/api/src/services/turn/view';
import { buildOf, CACHE_MAX_AGE_MS, CHAT_KEY, MAX_BYTES, MAX_CONVERSATIONS, storageOf, type Options } from '@/lib/persisted-cache';

/*
 * UI-FINISH: the last read of a conversation's messages (GET /api/turn, which is not a React Query read) for the 20 most recent
 * conversations, per user, in localStorage: a reload shows them at once and the read behind replaces them. Same rules as
 * persisted-cache.ts: a convenience, so every failure means "nothing saved"; refused for another user, another build, or after 24 hours.
 */
type Entry = { sessionId: string; savedAt: number; view: TurnView };
type Saved = { v: 1; build: string; userId: string; entries: Entry[] };
/** One conversation larger than this is not kept (it would crowd out the others). */
export const MAX_CONVERSATION_BYTES = 300_000;

function load(userId: string | null, options?: Options): Entry[] {
  const storage = storageOf(options);
  const raw = userId ? storage?.getItem(CHAT_KEY) : null;
  if (!raw) return [];
  try {
    const saved = JSON.parse(raw) as Partial<Saved>;
    return saved.v === 1 && saved.build === (options?.build ?? buildOf()) && saved.userId === userId && Array.isArray(saved.entries) ? saved.entries : [];
  } catch { return []; }
}

export function readCachedChatView(userId: string | null, sessionId: string, options?: Options): TurnView | null {
  try {
    const entry = load(userId, options).find(item => item.sessionId === sessionId);
    return entry && (options?.now ?? Date.now()) - entry.savedAt <= CACHE_MAX_AGE_MS ? entry.view : null;
  } catch { return null; }
}

export function writeCachedChatView(userId: string | null, sessionId: string, view: TurnView, options?: Options) {
  const storage = storageOf(options);
  if (!storage || !userId) return;
  try {
    const own = JSON.stringify(view);
    const others = load(userId, options).filter(item => item.sessionId !== sessionId);
    let entries = own.length > MAX_CONVERSATION_BYTES ? others : [{ sessionId, savedAt: options?.now ?? Date.now(), view }, ...others];
    entries = entries.slice(0, MAX_CONVERSATIONS);
    const write = () => JSON.stringify({ v: 1, build: options?.build ?? buildOf(), userId, entries } satisfies Saved);
    let text = write();
    while (text.length > MAX_BYTES && entries.length > 0) { entries = entries.slice(0, -1); text = write(); }
    storage.setItem(CHAT_KEY, text);
  } catch {
    try { storage.removeItem(CHAT_KEY); } catch { /* nothing saved either way */ }
  }
}
