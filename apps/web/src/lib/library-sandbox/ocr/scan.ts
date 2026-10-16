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
  const rendered = await renderPdfPagesInBrowser(file, pages, { signal: options.signal });
  const images = rendered.flatMap((page) => (page.ok ? [page.image] : []));
  const recognised = images.length ? await recognizeImagesInBrowser(images, { signal: options.signal }) : [];
  let next = 0;
  return rendered.map((page) => {
    const result: ScannedPageResult = page.ok ? { page: page.page, ...recognised[next++]! } : { page: page.page, ok: false, code: page.code };
    options.onPage?.(result);
    return result;
  });
}
