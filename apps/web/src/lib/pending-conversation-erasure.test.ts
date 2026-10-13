/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { forgetPending, readPending, rememberPending, resumeConversationErasure, type ResumeDeps } from './pending-conversation-erasure';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const done = { kind: 'session' as const, id, status: 'deleted' as const, alreadyDeleted: true,
  preservedSavedVersions: 0, financialReviewCount: 0 };

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
  };
}

function deps(erase: ResumeDeps['erase']) {
  return { erase, leave: vi.fn(), afterErased: vi.fn(), restore: vi.fn(), resync: vi.fn(), notify: vi.fn(), wait: vi.fn(async () => undefined) };
}

describe('pending conversation deletions', () => {
  it('remembers one key per conversation and forgets each independently', () => {
    const store = memoryStorage();
    rememberPending(store, id, 1000);
    rememberPending(store, other, 1000);
    forgetPending(store, id);
    expect(readPending(store, 2000)).toEqual([other]);
  });

  it('drops entries older than ten minutes', () => {
    const store = memoryStorage();
    rememberPending(store, id, 0);
    expect(readPending(store, 11 * 60 * 1000)).toEqual([]);
    expect(store.length).toBe(0);
  });

  it('works without storage', () => {
    expect(readPending(null)).toEqual([]);
    expect(() => rememberPending(null, id)).not.toThrow();
  });
});

describe('resumeConversationErasure', () => {
  it('re-sends the deletion and keeps the row hidden when it succeeds', async () => {
    const d = deps(async () => done);
    await expect(resumeConversationErasure(d, id)).resolves.toBe('deleted');
    expect(d.afterErased).toHaveBeenCalledWith(id);
    expect(d.restore).not.toHaveBeenCalled();
  });

  it('waits while the first request still holds the conversation, then succeeds', async () => {
    const erase = vi.fn().mockRejectedValueOnce(new Error('CONTENT_ERASURE_BUSY')).mockResolvedValueOnce(done);
    const d = deps(erase);
    await expect(resumeConversationErasure(d, id)).resolves.toBe('deleted');
    expect(d.wait).toHaveBeenCalledTimes(1);
    expect(d.restore).not.toHaveBeenCalled();
  });

  it('puts the row back with a reason when the deletion is refused', async () => {
    const d = deps(vi.fn().mockRejectedValue(new Error('CONTENT_NOT_FOUND')));
    await expect(resumeConversationErasure(d, id)).resolves.toBe('failed');
    expect(d.restore).toHaveBeenCalledWith(id);
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'error' }));
  });

  it('keeps a still-busy deletion hidden and pending: its outcome is unknown', async () => {
    const d = deps(vi.fn().mockRejectedValue(new Error('CONTENT_ERASURE_BUSY')));
    await expect(resumeConversationErasure(d, id)).resolves.toBe('pending');
    expect(d.restore).not.toHaveBeenCalled();
    expect(d.afterErased).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ tone: 'notice' }));
  });

  it('leaves the page first when the reload landed on the conversation being deleted', async () => {
    const d = deps(async () => done);
    await resumeConversationErasure(d, id);
    expect(d.leave).toHaveBeenCalledWith(id);
  });

  it('treats an already-deleted conversation as done', async () => {
    const d = deps(async () => { throw new Error('CONTENT_ERASED'); });
    await expect(resumeConversationErasure(d, id)).resolves.toBe('deleted');
  });
});
