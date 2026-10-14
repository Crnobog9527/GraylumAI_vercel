/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { REVIEW_NOTICE, laterNotice, runConversationErasure, type ConversationErasureDeps } from './conversation-erasure';

const id = '11111111-1111-4111-8111-111111111111';
/** A refusal the server answered (tRPC client errors carry the code in `data`). */
const refused = (message: string, code: string) => Object.assign(new Error(message), { data: { code, httpStatus: 409 } });

const done = { kind: 'session' as const, id, status: 'deleted' as const, alreadyDeleted: false,
  preservedSavedVersions: 0, financialReviewCount: 0 };

function deps(erase: ConversationErasureDeps['erase']) {
  const log: string[] = [];
  const value: ConversationErasureDeps = {
    hide: () => log.push('hide'), restore: () => log.push('restore'), leave: () => log.push('leave'),
    erase: (sessionId) => { log.push('erase'); return erase(sessionId); },
    afterErased: () => log.push('afterErased'), resync: () => log.push('resync'),
    notify: vi.fn(), resume: () => log.push('resume'),
  };
  return { value, log };
}

describe('runConversationErasure', () => {
  it('hides the row and leaves the page before the server answers', async () => {
    const { value, log } = deps(async () => done);
    await expect(runConversationErasure(value, id)).resolves.toBe('deleted');
    expect(log).toEqual(['hide', 'leave', 'erase', 'afterErased']);
  });

  it('treats an earlier deletion (another tab) as done, not as a failure', async () => {
    const { value, log } = deps(async () => { throw new Error('CONTENT_ERASED'); });
    await expect(runConversationErasure(value, id)).resolves.toBe('deleted');
    expect(log).not.toContain('restore');
  });

  it.each([
    ['CONTENT_ERASURE_BUSY', 'CONFLICT', '正在使用中'],
    ['CONTENT_NOT_FOUND', 'NOT_FOUND', '没有权限'],
    ['CONTENT_ERASURE_PREVIEW_CHANGED', 'CONFLICT', '新内容写入'],
    ['too many', 'TOO_MANY_REQUESTS', '操作太频繁'],
  ])('restores the row and explains a refusal the server answered (%s)', async (message, code, text) => {
    const { value, log } = deps(async () => { throw refused(message, code); });
    await expect(runConversationErasure(value, id)).resolves.toBe('failed');
    expect(log).toEqual(['hide', 'leave', 'erase', 'restore', 'resync']);
    expect(value.notify).toHaveBeenLastCalledWith({ tone: 'error', text: expect.stringContaining(text) });
  });

  it.each([
    ['the page was reloaded or the network dropped', new TypeError('Failed to fetch')],
    ['the server failed unexpectedly', refused('boom', 'INTERNAL_SERVER_ERROR')],
  ])('keeps the row hidden and retries when %s: the deletion may have happened', async (_, error) => {
    const { value, log } = deps(async () => { throw error; });
    await expect(runConversationErasure(value, id)).resolves.toBe('pending');
    expect(log).toEqual(['hide', 'leave', 'erase', 'resume']);
    expect(log).not.toContain('restore');
  });

  it('reports review_required as deleted with money still being checked', async () => {
    const { value } = deps(async () => ({ ...done, status: 'review_required' as const, financialReviewCount: 1 }));
    await expect(runConversationErasure(value, id)).resolves.toBe('deleted');
    expect(value.notify).toHaveBeenLastCalledWith({ tone: 'notice', text: expect.stringContaining('账务') });
  });
});

describe('laterNotice', () => {
  it('keeps a newer failure instead of a late accounting notice', () => {
    const failure = { tone: 'error' as const, text: '这个对话正在使用中，没有删除' };
    expect(laterNotice(failure, REVIEW_NOTICE)).toBe(failure);
  });
  it('shows the accounting notice when nothing more important is on screen', () => {
    expect(laterNotice(null, REVIEW_NOTICE)).toBe(REVIEW_NOTICE);
    expect(laterNotice({ tone: 'notice', text: 'x' }, REVIEW_NOTICE)).toBe(REVIEW_NOTICE);
  });
});
