/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import type { PageImage } from '../pdf/render-client';

const render = vi.hoisted(() => vi.fn());
const recognize = vi.hoisted(() => vi.fn());
vi.mock('../pdf/render-client', () => ({ renderPdfPagesInBrowser: render }));
vi.mock('../ocr/client', () => ({ recognizeImagesInBrowser: recognize }));

describe('recognizePdfPagesInBrowser', () => {
  const two = { ok: true, text: 'two', confidence: 0.9, angle: 0, flipped: false, ms: 1 };
  type Options = { onBatch(batch: PageImage[]): Promise<void> };
  it('reports unrenderable pages at once and recognised pages as their batch finishes, even if a later batch fails', async () => {
    render.mockImplementationOnce(async (_file: Blob, _pages: number[], options: Options) => {
      const batch: PageImage[] = [{ ok: true, page: 2, image: new Blob(['a']) }, { ok: false, page: 3, code: 'PDF_INVALID' },
        { ok: true, page: 5, image: new Blob(['b']) }];
      await options.onBatch(batch);
      return batch;
    });
    recognize.mockImplementationOnce(async (_images: Blob[], options: { onPage(i: number, page: unknown): void }) => {
      options.onPage(0, two);
      throw new SandboxError('SANDBOX_TIMEOUT');
    });
    const { recognizePdfPagesInBrowser } = await import('../ocr/scan');
    const seen: unknown[] = [];
    await expect(recognizePdfPagesInBrowser(new Blob(['%PDF']), [2, 3, 5], { onPage: (r) => seen.push(r) })).rejects.toThrow('SANDBOX_TIMEOUT');
    expect(seen).toEqual([{ page: 3, ok: false, code: 'PDF_INVALID' }, { page: 2, ...two }]);
  });
  it('recognises an earlier render batch before a later render batch times out', async () => {
    render.mockImplementationOnce(async (_file: Blob, _pages: number[], options: Options) => {
      await options.onBatch([{ ok: true, page: 2, image: new Blob(['a']) }]);
      throw new SandboxError('SANDBOX_TIMEOUT');
    });
    recognize.mockImplementationOnce(async (_images: Blob[], options: { onPage(i: number, page: unknown): void }) => {
      options.onPage(0, two);
      return [two];
    });
    const { recognizePdfPagesInBrowser } = await import('../ocr/scan');
    const seen: unknown[] = [];
    await expect(recognizePdfPagesInBrowser(new Blob(['%PDF']), [2, 30], { onPage: (r) => seen.push(r) })).rejects.toThrow('SANDBOX_TIMEOUT');
    expect(seen).toEqual([{ page: 2, ...two }]);
  });
});
