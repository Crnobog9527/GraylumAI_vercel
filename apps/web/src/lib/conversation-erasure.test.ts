/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { runConversationErasure, type ConversationErasureDeps } from './conversation-erasure';

const id = '11111111-1111-4111-8111-111111111111';
const done = { kind: 'session' as const, id, status: 'deleted' as const, alreadyDeleted: false,
  preservedSavedVersions: 0, financialReviewCount: 0 };

function deps(erase: ConversationErasureDeps['erase']) {
  const log: string[] = [];
  const value: ConversationErasureDeps = {
    hide: () => log.push('hide'), restore: () => log.push('restore'), leave: () => log.push('leave'),
    erase: (sessionId) => { log.push('erase'); return erase(sessionId); },
    afterErased: () => log.push('afterErased'), resync: () => log.push('resync'),
    notify: vi.fn(),
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
    ['CONTENT_ERASURE_BUSY', '正在使用中'],
    ['CONTENT_NOT_FOUND', '没有权限'],
    ['CONTENT_ERASURE_PREVIEW_CHANGED', '新内容写入'],
    ['network down', '删除结果暂未确认'],
  ])('restores the row and explains %s', async (code, text) => {
    const { value, log } = deps(async () => { throw new Error(code); });
    await expect(runConversationErasure(value, id)).resolves.toBe('failed');
    expect(log).toEqual(['hide', 'leave', 'erase', 'restore', 'resync']);
    expect(value.notify).toHaveBeenLastCalledWith({ tone: 'error', text: expect.stringContaining(text) });
  });

  it('reports review_required as deleted with money still being checked', async () => {
    const { value } = deps(async () => ({ ...done, status: 'review_required' as const, financialReviewCount: 1 }));
    await expect(runConversationErasure(value, id)).resolves.toBe('deleted');
    expect(value.notify).toHaveBeenLastCalledWith({ tone: 'notice', text: expect.stringContaining('账务') });
  });
});
