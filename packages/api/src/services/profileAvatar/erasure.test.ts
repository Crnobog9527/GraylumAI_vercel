/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { chainErasureStorage, createAvatarErasureAdapter } from './erasure';

const me = '00000000-0000-4000-8000-000000000001';
const file = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}.webp`;
function bucket(pages: unknown[], removed: { error: unknown } = { error: null }) {
  const list = vi.fn();
  for (const page of pages) list.mockResolvedValueOnce(page instanceof Error ? { data: null, error: page } : { data: page, error: null });
  const remove = vi.fn().mockResolvedValue({ data: [], error: removed.error });
  const from = vi.fn().mockReturnValue({ list, remove });
  return { client: { storage: { from } }, list, remove, from };
}

describe('avatar erasure', () => {
  it('deletes every avatar under the subject prefix and is complete only when a fresh listing is empty', async () => {
    const b = bucket([[{ name: file(1), id: 'a' }, { name: file(2), id: 'b' }], []]);
    expect(await createAvatarErasureAdapter(b.client).cleanSubject(me)).toEqual({ complete: true, remaining: 0, manualReview: 0 });
    expect(b.from).toHaveBeenCalledWith('profile-avatars');
    expect(b.list).toHaveBeenNthCalledWith(1, me, expect.objectContaining({ limit: 100 }));
    expect(b.remove).toHaveBeenCalledExactlyOnceWith([`${me}/${file(1)}`, `${me}/${file(2)}`]);
  });

  it('nothing stored: complete without deleting (a replay after success)', async () => {
    const b = bucket([[], []]);
    expect(await createAvatarErasureAdapter(b.client).cleanSubject(me)).toEqual({ complete: true, remaining: 0, manualReview: 0 });
    expect(b.remove).not.toHaveBeenCalled();
  });

  it('a listing or delete failure, or objects still there, is never complete', async () => {
    const failedList = bucket([new Error('down')]);
    expect(await createAvatarErasureAdapter(failedList.client).cleanSubject(me))
      .toEqual({ complete: false, remaining: 1, manualReview: 0, errorCode: 'ERASURE_AVATAR_STORAGE_UNKNOWN' });
    const failedRemove = bucket([[{ name: file(1), id: 'a' }]], { error: new Error('denied') });
    expect((await createAvatarErasureAdapter(failedRemove.client).cleanSubject(me)).complete).toBe(false);
    const stillThere = bucket([[{ name: file(1), id: 'a' }], [{ name: file(1), id: 'a' }]]);
    expect(await createAvatarErasureAdapter(stillThere.client).cleanSubject(me)).toEqual({ complete: false, remaining: 1, manualReview: 0 });
    const badShape = bucket([{ not: 'a list' }]);
    expect((await createAvatarErasureAdapter(badShape.client).cleanSubject(me)).errorCode).toBe('ERASURE_AVATAR_STORAGE_UNKNOWN');
  });

  it('a folder or a name the service never writes goes to manual review, not silently deleted or skipped', async () => {
    const b = bucket([[{ name: 'nested', id: null }, { name: 'evil.svg', id: 'x' }, { name: file(1), id: 'a' }],
      [{ name: 'nested', id: null }, { name: 'evil.svg', id: 'x' }]]);
    expect(await createAvatarErasureAdapter(b.client).cleanSubject(me))
      .toEqual({ complete: false, remaining: 2, manualReview: 2, errorCode: 'ERASURE_AVATAR_STORAGE_REVIEW' });
    expect(b.remove).toHaveBeenCalledExactlyOnceWith([`${me}/${file(1)}`]);
  });
});

describe('chainErasureStorage', () => {
  it('runs the next bucket only after the previous one is complete', async () => {
    const first = { cleanSubject: vi.fn().mockResolvedValue({ complete: false, remaining: 3, manualReview: 0 }) };
    const second = { cleanSubject: vi.fn().mockResolvedValue({ complete: true, remaining: 0, manualReview: 0 }) };
    expect(await chainErasureStorage(first, second).cleanSubject(me)).toEqual({ complete: false, remaining: 3, manualReview: 0 });
    expect(second.cleanSubject).not.toHaveBeenCalled();
    first.cleanSubject.mockResolvedValue({ complete: true, remaining: 0, manualReview: 0 });
    second.cleanSubject.mockResolvedValue({ complete: false, remaining: 1, manualReview: 0, errorCode: 'ERASURE_AVATAR_STORAGE_UNKNOWN' });
    expect((await chainErasureStorage(first, second).cleanSubject(me)).errorCode).toBe('ERASURE_AVATAR_STORAGE_UNKNOWN');
  });
});
