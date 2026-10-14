/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { classifyErasureError, type ContentErasureResult } from '@/lib/content-erasure';
import { getErrorMessageText } from '@/lib/safe-error-message';
import { REVIEW_NOTICE, type ConversationNotice } from '@/lib/conversation-erasure';
import { outcomeUnknown } from '@/lib/request-outcome';

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
  /** Leave the page if it is showing this conversation (the reload may have landed on it). */
  leave: (sessionId: string) => void;
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
 * repeat is busy, so it waits and retries; if it stays busy the outcome is unknown and the row stays
 * hidden. A real refusal puts the row back with a plain reason.
 */
export async function resumeConversationErasure(deps: ResumeDeps, sessionId: string) {
  deps.leave(sessionId);
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
      const text = getErrorMessageText(error);
      // Worth another try a moment later: still held by the earlier request, rate limited, briefly
      // unavailable, or no answer at all.
      const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
      const retryable = text.includes('CONTENT_ERASURE_BUSY') || outcomeUnknown(error)
        || code === 'TOO_MANY_REQUESTS' || code === 'SERVICE_UNAVAILABLE';
      if (retryable && attempt < BUSY_RETRIES) {
        await deps.wait(1500);
        continue;
      }
      // Only a definitive refusal puts the row back. Anything else (still busy, network, timeout, rate
      // limit, sign-in expired) leaves the outcome unknown: the request from before the reload may yet
      // commit, so the row stays hidden and the record stays (ten-minute expiry; the next load retries).
      if (!text.includes('CONTENT_NOT_FOUND')) {
        deps.notify({ tone: 'notice', text: '这个对话的删除还在处理中，稍后刷新可查看结果。' });
        return 'pending' as const;
      }
      deps.restore(sessionId);
      deps.resync();
      deps.notify({ tone: 'error', text: '上次删除的对话没有确认删除，已放回列表。可以再删一次，重复删除不会重复扣费。' });
      return 'failed' as const;
    }
  }
  return 'failed' as const;
}
