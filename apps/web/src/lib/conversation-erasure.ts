/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { classifyErasureError, type ContentErasureResult } from '@/lib/content-erasure';
import { getErrorMessageText } from '@/lib/safe-error-message';
import { outcomeUnknown } from '@/lib/request-outcome';

/** Owner 2026-10-13: the only warning before deleting a whole conversation. */
export const CONVERSATION_ERASURE_WARNING = '删除后无法恢复。';

export type ConversationNotice = { tone: 'error' | 'notice'; text: string };

/** Content is gone; only money records on the deleted conversation are still being checked. */
export const REVIEW_NOTICE: ConversationNotice = { tone: 'notice', text: '对话已删除，部分账务记录仍在核对中。' };

/** A late background notice never hides a failure the user still has to act on. */
export function laterNotice(current: ConversationNotice | null, incoming: ConversationNotice) {
  return current?.tone === 'error' ? current : incoming;
}

export type ConversationErasureDeps = {
  /** Remove the row from the list at once (optimistic). */
  hide: (sessionId: string) => void;
  /** Put the row back after a failure. */
  restore: (sessionId: string) => void;
  /** Leave the page if it is showing this conversation. */
  leave: (sessionId: string) => void;
  erase: (sessionId: string) => Promise<ContentErasureResult>;
  /** Drop local copies, tell other tabs, refetch in the background. Must not be awaited by the UI. */
  afterErased: (sessionId: string) => void;
  /** Refetch the list so it shows the server's truth after an uncertain or failed attempt. */
  resync: () => void;
  notify: (notice: ConversationNotice | null) => void;
  /** The outcome is unknown: keep the row hidden and the pending record, and send the deletion again. */
  resume: (sessionId: string) => void;
};

const FAILURES: Array<[string, string]> = [
  ['CONTENT_ERASURE_BUSY', '这个对话正在使用中（例如回复还在生成），没有删除，已放回列表。请稍后再试。'],
  ['CONTENT_NOT_FOUND', '找不到这个对话，或你没有权限删除它，没有删除任何内容。'],
  ['CONTENT_ERASURE_PREVIEW_CHANGED', '这个对话刚刚有新内容写入，没有删除，已放回列表。请稍后再试。'],
];

function failureMessage(error: unknown): string {
  const text = getErrorMessageText(error);
  const known = FAILURES.find(([code]) => text.includes(code));
  if (known) return known[1];
  const generic = classifyErasureError(error, 'confirm').message;
  return generic.startsWith('删除结果暂未确认')
    ? '删除结果暂未确认，请不要当作已删除。列表已按服务器结果刷新，可以再删一次，重复删除不会重复扣费。'
    : generic;
}

/**
 * One click: the row disappears and the page leaves at once; the server call runs behind it.
 * A failure puts the row back with a plain reason, and never reports success.
 */
export async function runConversationErasure(deps: ConversationErasureDeps, sessionId: string) {
  deps.notify(null);
  deps.hide(sessionId);
  deps.leave(sessionId);
  try {
    const result = await deps.erase(sessionId);
    deps.afterErased(sessionId);
    // The content is already unreadable; only money records are still being checked.
    if (result.status === 'review_required') {
      deps.notify(REVIEW_NOTICE);
    }
    return 'deleted' as const;
  } catch (error) {
    if (classifyErasureError(error, 'confirm').type === 'gone') {
      deps.afterErased(sessionId);
      return 'deleted' as const;
    }
    // No answer from the server (the page was reloaded or left, the network dropped) or an unexpected
    // server failure: the deletion may still have happened. Never put the row back on a guess.
    if (outcomeUnknown(error)) {
      deps.notify({ tone: 'notice', text: '删除结果还在确认中，正在重试。' });
      deps.resume(sessionId);
      return 'pending' as const;
    }
    deps.restore(sessionId);
    deps.resync();
    deps.notify({ tone: 'error', text: failureMessage(error) });
    return 'failed' as const;
  }
}
