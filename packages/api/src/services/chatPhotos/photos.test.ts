/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_PHOTO_BUCKET, CHAT_PHOTO_MAX_BYTES, cleanOrphanPhotos, createChatPhotoErasureAdapter, isChatPhotoPath, jpegFromDataUrl,
  keepTurnPhotos, parseChatPhotoPath, readOwnPhoto, removeSessionPhotos, removeTurnPhotos, sessionPhotos, type ChatPhotoClient,
} from './photos';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const SESSION_2 = '00000000-0000-4000-8000-0000000000a2';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const photo = (profile: string, session: string, turn: number, index = 0, n = turn * 10 + index) =>
  `${profile}/${session}.${turn}.${index}.${id(n)}.jpg`;

/** An in-memory bucket, listed as Storage lists a folder: names relative to the prefix, `search` a name prefix, paged. */
function storage(names: string[] = [], bytes: Uint8Array = JPEG) {
  const store = new Set(names);
  const removed: string[][] = [];
  const bucket = {
    upload: vi.fn(async (path: string) => { store.add(path); return { data: { path }, error: null }; }),
    list: vi.fn(async (prefix: string, options: { search?: string; limit: number; offset: number }) => ({ error: null,
      data: [...store].filter(name => name.startsWith(`${prefix}/`)).map(name => ({ name: name.slice(prefix.length + 1), id: name }))
        .filter(row => !options.search || row.name.startsWith(options.search)).sort((a, b) => a.name.localeCompare(b.name))
        .slice(options.offset, options.offset + options.limit) })),
    remove: vi.fn(async (paths: string[]) => { removed.push(paths); paths.forEach(path => store.delete(path)); return { data: [], error: null }; }),
    download: vi.fn(async (path: string) => store.has(path) ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: new Error('none') }),
  };
  const from = vi.fn(() => bucket);
  const rpc = vi.fn(async () => ({ data: [...store], error: null }));
  return { client: { storage: { from }, rpc } as unknown as ChatPhotoClient, store, bucket, from, rpc, removed };
}

describe('photo names', () => {
  it('<profile>/<session>.<turn>.<n>.<uuid>.jpg; the owner and conversation are checked', () => {
    expect(parseChatPhotoPath(photo(ME, SESSION, 42, 3))).toEqual({ profileId: ME, sessionId: SESSION, turnId: 42, index: 3 });
    expect(isChatPhotoPath(photo(ME, SESSION, 1), ME, SESSION)).toBe(true);
    expect(isChatPhotoPath(photo(ME, SESSION, 1), OTHER)).toBe(false);
    expect(isChatPhotoPath(photo(ME, SESSION, 1), ME, SESSION_2)).toBe(false);
    for (const bad of [`${ME}/${SESSION}.1.0.${id(1)}.png`, `${ME}/${SESSION}.0.0.${id(1)}.jpg`, `${ME}/${SESSION}.1.4.${id(1)}.jpg`,
      `${ME}/${SESSION}.1.${id(1)}.jpg`, `../${ME}/${SESSION}.1.0.${id(1)}.jpg`, `${ME}/${SESSION}/1.0.${id(1)}.jpg`])
      expect(isChatPhotoPath(bad), bad).toBe(false);
  });

  it('a chat image is a JPEG data URL; anything else is not kept', () => {
    expect(jpegFromDataUrl(`data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`)).toEqual(Buffer.from(JPEG));
    expect(jpegFromDataUrl(`data:image/png;base64,${Buffer.from(JPEG).toString('base64')}`)).toBeNull();
    expect(jpegFromDataUrl('data:image/jpeg;base64,PGh0bWw+')).toBeNull();
  });
});

describe('keepTurnPhotos: the photos stay with their message', () => {
  it('keeps the message\'s JPEGs under its turn, in order, privately; anything else is left out', async () => {
    const s = storage();
    let n = 0;
    const kept = await keepTurnPhotos({ client: s.client, profileId: ME, sessionId: SESSION, turnId: 7, objectId: () => id(++n),
      photos: [JPEG, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), new Uint8Array(CHAT_PHOTO_MAX_BYTES + 1).fill(0xff), JPEG] });
    expect(kept.map(photo => [photo.turnId, photo.index])).toEqual([[7, 0], [7, 3]]);
    expect(kept.every(item => isChatPhotoPath(item.path, ME, SESSION))).toBe(true);
    expect(s.from).toHaveBeenCalledWith(CHAT_PHOTO_BUCKET);
    expect(s.bucket.upload).toHaveBeenCalledWith(kept[0]!.path, JPEG, expect.objectContaining({ contentType: 'image/jpeg', upsert: false }));
    for (const bad of [{ profileId: 'x' }, { sessionId: 'x' }, { turnId: 0 }, { turnId: 1.5 }])
      expect(await keepTurnPhotos({ client: s.client, profileId: ME, sessionId: SESSION, turnId: 1, photos: [JPEG], ...bad })).toEqual([]);
  });

  it('a failed upload is left out, never retried, and the others still go', async () => {
    const s = storage();
    s.bucket.upload.mockResolvedValueOnce({ data: null, error: new Error('down') } as never);
    const kept = await keepTurnPhotos({ client: s.client, profileId: ME, sessionId: SESSION, turnId: 3, photos: [JPEG, JPEG] });
    expect(kept).toHaveLength(1);
    expect(s.bucket.upload).toHaveBeenCalledTimes(2);
  });
});

describe('reading back', () => {
  it('a conversation lists every photo it ever kept (no time limit), by turn and position, never another conversation\'s', async () => {
    const names = [photo(ME, SESSION, 10, 1), photo(ME, SESSION, 9, 0), photo(ME, SESSION, 10, 0), photo(ME, SESSION_2, 1),
      `${ME}/${SESSION}.strange.jpg`, photo(OTHER, SESSION, 1)];
    expect((await sessionPhotos(storage(names).client, ME, SESSION)).map(item => [item.turnId, item.index]))
      .toEqual([[9, 0], [10, 0], [10, 1]]);
  });

  it('pages through a long conversation', async () => {
    const names = Array.from({ length: 230 }, (_, n) => photo(ME, SESSION, n + 1, 0));
    const s = storage(names);
    expect(await sessionPhotos(s.client, ME, SESSION)).toHaveLength(230);
    expect(s.bucket.list).toHaveBeenCalledTimes(3);
  });

  it('only the owner reads a photo: another account\'s, a strange name or a missing file is not found', async () => {
    const s = storage([photo(ME, SESSION, 1), photo(OTHER, SESSION, 1)]);
    expect(await readOwnPhoto(s.client, ME, photo(ME, SESSION, 1))).toEqual({ ok: true, bytes: JPEG });
    expect(await readOwnPhoto(s.client, ME, photo(OTHER, SESSION, 1))).toEqual({ ok: false, status: 404 });
    expect(await readOwnPhoto(s.client, ME, `${ME}/x.jpg`)).toEqual({ ok: false, status: 404 });
    expect(await readOwnPhoto(s.client, ME, photo(ME, SESSION, 2))).toEqual({ ok: false, status: 404 });
    expect(await readOwnPhoto(s.client, ME, null)).toEqual({ ok: false, status: 404 });
    expect(s.bucket.download).toHaveBeenCalledTimes(2);
    expect(await readOwnPhoto(storage([photo(ME, SESSION, 1)], new Uint8Array([0x3c, 0x68])).client, ME, photo(ME, SESSION, 1)))
      .toEqual({ ok: false, status: 404 });
  });
});

describe('deletion: with the turn that saved nothing, with the conversation, with the account', () => {
  it('a turn that kept no message takes its photos back', async () => {
    const s = storage([photo(ME, SESSION, 1), photo(ME, SESSION, 2)]);
    await removeTurnPhotos(s.client, [{ path: photo(ME, SESSION, 2), turnId: 2, index: 0 }]);
    expect([...s.store]).toEqual([photo(ME, SESSION, 1)]);
    await removeTurnPhotos(s.client, []);
    expect(s.removed).toHaveLength(1);
  });

  it('deleting a conversation removes all its photos and only them; a failure never throws', async () => {
    const s = storage([photo(ME, SESSION, 1), photo(ME, SESSION, 2, 1), photo(ME, SESSION_2, 3)]);
    expect(await removeSessionPhotos(s.client, ME, SESSION)).toBe(2);
    expect([...s.store]).toEqual([photo(ME, SESSION_2, 3)]);
    s.bucket.remove.mockRejectedValueOnce(new Error('down'));
    expect(await removeSessionPhotos(s.client, ME, SESSION_2)).toBe(0);
    expect(await removeSessionPhotos({} as ChatPhotoClient, ME, SESSION)).toBe(0);
  });

  it('the cron deletes what the database names as orphaned, in batches; a strange name or a failure fails the run', async () => {
    const names = Array.from({ length: 150 }, (_, n) => photo(ME, SESSION, n + 1));
    const s = storage();
    s.rpc.mockResolvedValueOnce({ data: names, error: null });
    expect(await cleanOrphanPhotos(s.client)).toEqual({ removed: 150, failed: 0 });
    expect(s.rpc).toHaveBeenCalledWith('chat_photos_orphaned', { p_limit: 500 });
    expect(s.removed.map(batch => batch.length)).toEqual([100, 50]);
    s.rpc.mockResolvedValueOnce({ data: [photo(ME, SESSION, 1), `${ME}/odd.jpg`], error: null });
    expect(await cleanOrphanPhotos(s.client)).toEqual({ removed: 1, failed: 1 });
    expect(s.removed.at(-1)).toEqual([photo(ME, SESSION, 1)]);
    s.rpc.mockResolvedValueOnce({ data: null, error: new Error('down') } as never);
    expect(await cleanOrphanPhotos(s.client)).toEqual({ removed: 0, failed: 1 });
    s.rpc.mockResolvedValueOnce({ data: [photo(ME, SESSION, 1)], error: null });
    s.bucket.remove.mockResolvedValueOnce({ data: null, error: new Error('down') } as never);
    expect(await cleanOrphanPhotos(s.client)).toEqual({ removed: 0, failed: 1 });
  });

  it('account erasure removes every photo of the account and is complete only when none is left', async () => {
    const s = storage([photo(ME, SESSION, 1), photo(ME, SESSION_2, 2), photo(OTHER, SESSION, 3)]);
    expect(await createChatPhotoErasureAdapter(s.client).cleanSubject(ME)).toEqual({ complete: true, remaining: 0, manualReview: 0 });
    expect([...s.store]).toEqual([photo(OTHER, SESSION, 3)]);
    const strange = storage([photo(ME, SESSION, 1), `${ME}/odd.jpg`]);
    expect(await createChatPhotoErasureAdapter(strange.client).cleanSubject(ME)).toEqual({ complete: false, remaining: 1, manualReview: 1,
      errorCode: 'ERASURE_CHAT_PHOTO_REVIEW' });
    strange.bucket.list.mockResolvedValueOnce({ data: null, error: new Error('down') } as never);
    expect(await createChatPhotoErasureAdapter(strange.client).cleanSubject(ME)).toMatchObject({ complete: false,
      errorCode: 'ERASURE_CHAT_PHOTO_UNKNOWN' });
  });
});
