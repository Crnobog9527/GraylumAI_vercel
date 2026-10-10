/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { libraryService } from './service';
import { WORD_MIME } from './wordContent';
import type { LibraryStorage } from './storage';
vi.mock('../../middleware/securityChecks', () => ({ checkRateLimitAsync: vi.fn() }));
const a = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const path = `${a}/${id}/original`, textPath = `${a}/${id}/text`;
const begin = { requestId: id, filename: 'a.docx', contentType: WORD_MIME, bytes: 4, purpose: 'reference' } as const;
let rpc: ReturnType<typeof vi.fn>;
let client: SupabaseClient;
let storage: LibraryStorage;
let doc: { format: string; status: string; path: string; textPath: string; textGuardUntil: string | null };
beforeEach(() => {
  doc = { format: 'docx', status: 'uploading', path, textPath, textGuardUntil: new Date().toISOString() };
  rpc = vi.fn(async (name: string) => {
    if (name === 'library_document_read') return { data: doc };
    if (name === 'library_upload_begin') return { data: { documentId: id, dispatch: true, status: 'uploading', path, textPath } };
    if (name === 'library_word_text_begin') return { data: { documentId: id, dispatch: true, status: 'uploading', path: textPath } };
    if (name === 'library_cleanup_candidates') return { data: [] };
    return { data: { documentId: id, status: 'ready' } };
  });
  client = { rpc } as unknown as SupabaseClient;
  storage = { signUpload: vi.fn(async (p: string) => ({ path: p, signedUrl: 'signed', token: 'token' })),
    inspect: vi.fn(async (p: string) => p === path
      ? { size: 400, contentType: WORD_MIME, bytes: Buffer.from([80, 75, 3, 4]) }
      : { size: 7, contentType: 'text/plain', bytes: Buffer.from('标题\n') }),
    absent: vi.fn(), remove: vi.fn(), scan: vi.fn(), signRead: vi.fn(),
  } as unknown as LibraryStorage;
});
it('reserves both paths but only signs original after bounded cleanup', async () => {
  const result = await libraryService(client, a, storage).beginWord(begin);
  expect(rpc).toHaveBeenCalledWith('library_upload_begin', { a, r: id, n: 'a.docx', f: 'docx', p: 'reference', declared: 4 });
  expect(storage.signUpload).toHaveBeenNthCalledWith(1, path);
  expect(storage.signUpload).toHaveBeenCalledTimes(1);
  expect(result.upload?.path).toBe(path);
  expect(rpc.mock.calls.findIndex(c => c[0] === 'library_cleanup_candidates')).toBeLessThan(
    rpc.mock.calls.findIndex(c => c[0] === 'library_upload_begin'));
  expect(rpc).toHaveBeenCalledWith('library_cleanup_candidates', { a, did: null, n: 4 });
});
it('never reissues either token on repeat admission', async () => {
  rpc.mockImplementation(async (name: string) => ({ data: name === 'library_cleanup_candidates' ? []
    : { documentId: id, status: 'uploading', dispatch: false } }));
  expect((await libraryService(client, a, storage).beginWord(begin)).upload).toBeNull();
  expect(storage.signUpload).not.toHaveBeenCalled();
});
it('partial signing failure marks both paths for guarded cleanup', async () => {
  vi.mocked(storage.signUpload).mockRejectedValueOnce(new Error('timeout'));
  await expect(libraryService(client, a, storage).beginWord(begin)).rejects.toThrow('LIBRARY_UPLOAD_UNAVAILABLE');
  expect(rpc).toHaveBeenCalledWith('library_delete', { a, did: id, unfinished_only: true });
});
it('inspects only Word header, reads plain text and publishes exact server-generated segments', async () => {
  await libraryService(client, a, storage).completeWord({ documentId: id, headings: [{ offset: 0, level: 1, text: '标题' }] });
  expect(storage.inspect).toHaveBeenNthCalledWith(1, path, false);
  expect(storage.inspect).toHaveBeenNthCalledWith(2, textPath, true);
  expect(rpc).toHaveBeenCalledWith('library_word_publish', { a, did: id, actual: 400, text_actual: 7,
    segments: [{ title: '标题', body: '标题\n' }] });
});
it('old completeUpload cannot publish Word as plain text', async () => {
  await expect(libraryService(client, a, storage).complete(id)).rejects.toThrow('LIBRARY_TYPE');
  expect(storage.inspect).not.toHaveBeenCalled();
});
it('ready retry performs no reads of Storage or mutation', async () => {
  doc.status = 'ready';
  expect(await libraryService(client, a, storage).completeWord({ documentId: id, headings: [] })).toEqual({ documentId: id, status: 'ready' });
  expect(storage.inspect).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('wrong type, missing text or malformed metadata never publish and clean up', async () => {
  for (const mode of ['type', 'missing', 'metadata']) {
    vi.mocked(storage.inspect).mockImplementation(async (p: string) => {
      if (p === path) return { size: 4, contentType: WORD_MIME, bytes: Buffer.from(mode === 'type' ? '<xml' : 'PK\x03\x04') };
      if (mode === 'missing') throw new Error('LIBRARY_STORAGE_UNAVAILABLE');
      return { size: 1, contentType: 'text/plain', bytes: Buffer.from('x') };
    });
    await expect(libraryService(client, a, storage).completeWord({ documentId: id, headings: [{ offset: 0, level: 1, text: 'wrong' }] })).rejects.toThrow();
  }
  expect(rpc.mock.calls.filter(c => c[0] === 'library_word_publish')).toHaveLength(0);
  expect(rpc.mock.calls.filter(c => c[0] === 'library_delete')).toHaveLength(3);
});
it('binds all read interfaces to actor/version and preserves timestamp cursor precision', async () => {
  const service = libraryService(client, a, storage);
  await service.list(undefined, { createdAt: '2026-10-10T12:00:00.123456+00:00', id });
  await service.directory(id, 2);
  await service.segments(id, 2, 50, 20);
  expect(rpc).toHaveBeenCalledWith('library_list_page', { a, after_id: id, after_created_at: '2026-10-10T12:00:00.123456+00:00' });
  expect(rpc).toHaveBeenCalledWith('library_directory', { a, did: id, ver: 2 });
  expect(rpc).toHaveBeenCalledWith('library_segments_range', { a, did: id, ver: 2, start_at: 50, count_limit: 20 });
});

it('issues text only after original inspection, using an independently guarded atomic grant', async () => {
  doc.textGuardUntil = null;
  const result = await libraryService(client, a, storage).beginWordText(id);
  expect(storage.inspect).toHaveBeenCalledWith(path, false);
  expect(rpc).toHaveBeenCalledWith('library_word_text_begin', { a, did: id, actual: 400 });
  expect(storage.signUpload).toHaveBeenCalledExactlyOnceWith(textPath);
  expect(result.upload?.path).toBe(textPath);
});
it('does not grant text for missing/invalid original and allows a later retry', async () => {
  doc.textGuardUntil = null;
  vi.mocked(storage.inspect).mockRejectedValueOnce(new Error('LIBRARY_STORAGE_UNAVAILABLE'));
  await expect(libraryService(client, a, storage).beginWordText(id)).rejects.toThrow('LIBRARY_STORAGE_UNAVAILABLE');
  expect(storage.signUpload).not.toHaveBeenCalled();
  expect(rpc.mock.calls.some(c => c[0] === 'library_word_text_begin' || c[0] === 'library_delete')).toBe(false);
});
it('second-stage retry never remints a text token', async () => {
  expect((await libraryService(client, a, storage).beginWordText(id)).upload).toBeNull();
  expect(storage.inspect).not.toHaveBeenCalled();
  expect(storage.signUpload).not.toHaveBeenCalled();
});
it('completion before text stage cannot publish or discard the first-stage upload', async () => {
  doc.textGuardUntil = null;
  await expect(libraryService(client, a, storage).completeWord({ documentId: id, headings: [] })).rejects.toThrow('LIBRARY_UPLOAD_INCOMPLETE');
  expect(storage.inspect).not.toHaveBeenCalled();
  expect(rpc.mock.calls.some(c => c[0] === 'library_delete')).toBe(false);
});
