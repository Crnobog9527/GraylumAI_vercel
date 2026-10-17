/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SandboxErrorCode } from '../errors';
import { renderPdfPagesInBrowser } from '../pdf/render-client';
import { recognizeImagesInBrowser } from './client';
import type { OcrPage } from './types';

export type ScannedPageResult = { page: number } & (OcrPage | { ok: false; code: SandboxErrorCode });

/**
 * Scanned PDF pages → text, all in the browser (LIB-2d): each page is rendered in the PDF sandbox (no
 * WebAssembly), then recognised in the recognition sandbox (WebAssembly, no network). `onPage` fires per page.
 */
export async function recognizePdfPagesInBrowser(file: Blob, pages: number[],
  options: { signal?: AbortSignal; onPage?: (result: ScannedPageResult) => void } = {}): Promise<ScannedPageResult[]> {
  const results = new Map<number, ScannedPageResult>();
  const report = (result: ScannedPageResult) => {
    results.set(result.page, result);
    options.onPage?.(result);
  };
  // Each render batch is recognised as soon as it is rendered: unrenderable pages are reported at once and
  // recognised pages as each recognition batch finishes, so a later batch failing or being cancelled never loses
  // the earlier ones.
  const rendered = await renderPdfPagesInBrowser(file, pages, {
    signal: options.signal,
    onBatch: async (batch) => {
      for (const page of batch) if (!page.ok) report({ page: page.page, ok: false, code: page.code });
      const images = batch.flatMap((page) => (page.ok ? [page] : []));
      if (!images.length) return;
      await recognizeImagesInBrowser(images.map((page) => page.image), {
        signal: options.signal, onPage: (index, result) => report({ page: images[index]!.page, ...result }),
      });
    },
  });
  return rendered.map((page) => results.get(page.page)!);
}
