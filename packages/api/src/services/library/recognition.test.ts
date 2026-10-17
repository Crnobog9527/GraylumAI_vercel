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
  it('joins many short paragraphs so a page stays under 200 segments, without changing the text', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `第 ${i} 段`).join('\n\n');
    const segments = recognizedSegments(text, 'pdf_page', 3);
    expect(segments.length).toBeLessThanOrEqual(200);
    expect(segments.every((s) => Buffer.byteLength(s.body) <= 8192)).toBe(true);
    expect(segments.map((s) => s.body).join('')).toBe(text);
    const worst = recognizedSegments(Array.from({ length: 25_000 }, () => '字').join('\n\n').slice(0, 100_000), 'pdf_page', 1);
    expect(worst.length).toBeLessThanOrEqual(200);
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
  it('ends a segment at each image so its text lands exactly at the image', async () => {
    const { wordSegmentsWithImages } = await import('./wordContent');
    const text = '第一段\n第二段\n第三段';
    const { segments, anchors } = wordSegmentsWithImages(Buffer.from(text), [], [{ offset: 0 }, { offset: 4 }, { offset: 6 }, { offset: 11 }]);
    // Without blank lines the paragraphs would share one segment; image offsets split them.
    expect(segments.map((s) => s.body)).toEqual(['第一段\n', '第二', '段\n第三段']);
    expect(segments.map((s) => s.body).join('')).toBe(text);
    expect(anchors).toEqual([{ anchor: 0 }, { anchor: 1 }, { anchor: 2 }, { anchor: 3 }]);
  });
  it('accepts a Word file that is only images, with every image at the start', async () => {
    const { wordSegmentsWithImages } = await import('./wordContent');
    expect(wordSegmentsWithImages(Buffer.alloc(0), [], [{ offset: 0 }, { offset: 0 }])).toEqual({ segments: [], anchors: [{ anchor: 0 }, { anchor: 0 }] });
    expect(() => wordSegmentsWithImages(Buffer.alloc(0), [], [])).toThrow('LIBRARY_INVALID');
    expect(() => wordSegmentsWithImages(Buffer.alloc(0), [], [{ offset: 1 }])).toThrow('LIBRARY_INVALID');
  });
  it('keeps headings as titles and refuses offsets out of order or past the text', async () => {
    const { wordSegmentsWithImages } = await import('./wordContent');
    const text = '标题\n正文一\n正文二';
    const { segments, anchors } = wordSegmentsWithImages(Buffer.from(text), [{ offset: 3, level: 1, text: '正文一' }], [{ offset: 7 }]);
    expect(segments).toEqual([{ title: '', body: '标题\n' }, { title: '正文一', body: '正文一\n' }, { title: '正文一', body: '正文二' }]);
    expect(anchors).toEqual([{ anchor: 2 }]);
    expect(() => wordSegmentsWithImages(Buffer.from(text), [], [{ offset: 6 }, { offset: 4 }])).toThrow('LIBRARY_INVALID');
    expect(() => wordSegmentsWithImages(Buffer.from(text), [], [{ offset: 99 }])).toThrow('LIBRARY_INVALID');
  });
});
