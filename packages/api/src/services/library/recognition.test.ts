/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkRateLimitAsync } from '../../middleware/securityChecks';
import { libraryRecognition, recognitionSaveInput, recognizedSegments } from './recognition';
vi.mock('../../middleware/securityChecks', () => ({ checkRateLimitAsync: vi.fn() }));

const a = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
let rpc: ReturnType<typeof vi.fn>;
let client: SupabaseClient;
beforeEach(() => {
  rpc = vi.fn(async () => ({ data: { saved: true, status: 'complete', contentVersion: 3 } }));
  client = { rpc } as unknown as SupabaseClient;
  vi.mocked(checkRateLimitAsync).mockClear();
});

describe('recognised page text', () => {
  it('splits into page-titled paragraphs no longer than 8,192 bytes', () => {
    const segments = recognizedSegments(`第一段\n\n${'字'.repeat(5000)}`, 'pdf_page', 7);
    expect(segments.every((s) => s.title === '第 7 页' && Buffer.byteLength(s.body) <= 8192)).toBe(true);
    expect(segments.map((s) => s.body).join('')).toContain('第一段');
  });
  it('refuses blank text, control characters and form feeds', () => {
    expect(() => recognizedSegments('   \n', 'pdf_page', 1)).toThrow('LIBRARY_INVALID');
    expect(recognizedSegments('图里的字', 'word_image', 3)[0]!.title).toBe('图片 3（识别）');
    for (const bad of ['a\u0000b', 'a\fb', 'a b']) expect(() => recognizedSegments(bad, 'pdf_page', 1)).toThrow('LIBRARY_TYPE');
  });
  it('accepts only a bounded page position and text length', () => {
    const ok = { documentId: id, kind: 'pdf_page' as const, position: 1, version: 1, text: 'x' };
    expect(recognitionSaveInput.safeParse(ok).success).toBe(true);
    for (const bad of [{ ...ok, position: 0 }, { ...ok, position: 501 }, { ...ok, version: 0 }, { ...ok, text: '' },
      { ...ok, text: 'x'.repeat(100_001) }, { ...ok, extra: 1 }, { ...ok, kind: 'image' }]) expect(recognitionSaveInput.safeParse(bad).success).toBe(false);
  });
});

describe('recognition service', () => {
  it('binds the actor, rate-limits saves and passes the page segments to the database', async () => {
    const result = await libraryRecognition(client, a).saveRecognized({ documentId: id, kind: 'pdf_page', position: 2, version: 3, text: '识别结果' });
    expect(result).toEqual({ saved: true, status: 'complete', contentVersion: 3 });
    expect(checkRateLimitAsync).toHaveBeenCalledWith(a, 'api');
    expect(rpc).toHaveBeenCalledWith('library_recognition_save',
      { a, did: id, kind: 'pdf_page', pos: 2, ver: 3, segments: [{ title: '第 2 页', body: '识别结果' }] });
  });
  it('refuses bad text before calling the database, with a stable code', async () => {
    await expect(libraryRecognition(client, a).saveRecognized({ documentId: id, kind: 'pdf_page', position: 2, version: 3, text: ' \n ' }))
      .rejects.toThrow('LIBRARY_INVALID');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('lists units and marks a failed page through the database only', async () => {
    await libraryRecognition(client, a).recognitionPending();
    expect(rpc).toHaveBeenLastCalledWith('library_recognition_pending', { a });
    await libraryRecognition(client, a).failRecognized({ documentId: id, kind: 'word_image', position: 4 });
    expect(rpc).toHaveBeenLastCalledWith('library_recognition_fail', { a, did: id, kind: 'word_image', pos: 4 });
  });
  it('maps database refusals to stable codes', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'LIBRARY_DISABLED' } });
    await expect(libraryRecognition(client, a).failRecognized({ documentId: id, kind: 'pdf_page', position: 1 })).rejects.toThrow('LIBRARY_DISABLED');
  });
});

describe('Word image anchors', () => {
  it('counts the segments that start before each image', async () => {
    const { wordImageAnchors } = await import('./wordContent');
    const segments = [{ title: '', body: '第一段\n' }, { title: '', body: '第二段\n' }, { title: '', body: '第三段' }];
    expect(wordImageAnchors(segments, [{ offset: 0 }, { offset: 4 }, { offset: 6 }, { offset: 11 }])).toEqual(
      [{ anchor: 0 }, { anchor: 1 }, { anchor: 2 }, { anchor: 3 }]);
    expect(() => wordImageAnchors(segments, [{ offset: 6 }, { offset: 4 }])).toThrow('LIBRARY_INVALID');
    expect(() => wordImageAnchors(segments, [{ offset: 12 }])).toThrow('LIBRARY_INVALID');
  });
});
