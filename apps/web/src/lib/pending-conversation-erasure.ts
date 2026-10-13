/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { classifyErasureError, type ContentErasureResult } from '@/lib/content-erasure';
import { getErrorMessageText } from '@/lib/safe-error-message';
import { REVIEW_NOTICE, type ConversationNotice } from '@/lib/conversation-erasure';

/**
 * Conversations whose deletion request was sent but not yet answered, kept per browser tab so a
 * reload or page change cannot bring the row back while the server is still deleting it. Only IDs
 * and a time are stored (ENGINEERING §4: pending request IDs). One key per conversation, because
 * the existing post-deletion cleanup removes every local key that names a deleted ID.
 */
const PREFIX = 'graylum-pending-conversation-erasure:';
const MAX_AGE_MS = 10 * 60 * 1000;

export function rememberPending(store: Storage | null, sessionId: string, now = Date.now()) {
  try { store?.setItem(PREFIX + sessionId, String(now)); } catch { /* The server state is authoritative. */ }
}

export function forgetPending(store: Storage | null, sessionId: string) {
  try { store?.removeItem(PREFIX + sessionId); } catch { /* Nothing to forget without storage. */ }
}

/** Pending IDs younger than ten minutes; older or malformed entries are dropped. */
export function readPending(store: Storage | null, now = Date.now()): string[] {
  if (!store) return [];
  const found: string[] = [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const at = Number(store.getItem(key));
      const id = key.slice(PREFIX.length);
      if (Number.isFinite(at) && now - at < MAX_AGE_MS && /^[0-9a-f-]{36}$/.test(id)) found.push(id);
      else store.removeItem(key);
    }
  } catch {
    return found;
  }
  return found;
}

export type ResumeDeps = {
  erase: (sessionId: string) => Promise<ContentErasureResult>;
  afterErased: (sessionId: string) => void;
  restore: (sessionId: string) => void;
  resync: () => void;
  notify: (notice: ConversationNotice | null) => void;
  wait: (ms: number) => Promise<void>;
};

const BUSY_RETRIES = 5;

/**
 * After a reload: the row stays hidden and the deletion is sent again (it is idempotent: an already
 * marked conversation returns at once). While the first request still holds the conversation the
 * repeat is busy, so it waits and retries. A real refusal puts the row back with a plain reason.
 */
export async function resumeConversationErasure(deps: ResumeDeps, sessionId: string) {
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt += 1) {
    try {
      const result = await deps.erase(sessionId);
      deps.afterErased(sessionId);
      if (result.status === 'review_required') deps.notify(REVIEW_NOTICE);
      return 'deleted' as const;
    } catch (error) {
      if (classifyErasureError(error, 'confirm').type === 'gone') {
        deps.afterErased(sessionId);
        return 'deleted' as const;
      }
      if (getErrorMessageText(error).includes('CONTENT_ERASURE_BUSY') && attempt < BUSY_RETRIES) {
        await deps.wait(1500);
        continue;
      }
      deps.restore(sessionId);
      deps.resync();
      deps.notify({ tone: 'error', text: '上次删除的对话没有确认删除，已放回列表。可以再删一次，重复删除不会重复扣费。' });
      return 'failed' as const;
    }
  }
  return 'failed' as const;
}
