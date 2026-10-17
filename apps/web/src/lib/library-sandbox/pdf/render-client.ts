/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isSandboxErrorCode, SandboxError, type SandboxErrorCode } from '../errors';
import { isLibraryScanRecognitionEnabled } from '../feature-flag';
import { PDF_RENDER_LIMITS, SANDBOX_LIMITS } from '../limits';
import { isRecord } from '../protocol';
import { runSandboxedWorker } from '../sandbox-host';
import { loadWorkerBundle, withinDeadline } from '../worker-bundle';
import { packRenderInput } from './render-pack';

export const PDF_RENDER_WORKER_PATH = '/library-sandbox/pdf-render-worker.js';
const LOAD_TIMEOUT_MS = 30_000;

export type PageImage = { ok: true; page: number; image: Blob } | { ok: false; page: number; code: SandboxErrorCode };

function validate(value: unknown, pages: number[]): PageImage[] {
  const reject = (): never => { throw new SandboxError('SANDBOX_PROTOCOL'); };
  if (!isRecord(value) || !Array.isArray(value.pages) || value.pages.length > pages.length) return reject();
  return value.pages.map((entry, i): PageImage => {
    if (!isRecord(entry) || entry.page !== pages[i]) return reject();
    if (entry.ok === false) return isSandboxErrorCode(entry.code) ? { ok: false, page: pages[i]!, code: entry.code } : reject();
    const jpeg = entry.jpeg;
    if (entry.ok !== true || !(jpeg instanceof ArrayBuffer) || jpeg.byteLength < 4 || jpeg.byteLength > PDF_RENDER_LIMITS.maxJpegBytes) return reject();
    const head = new Uint8Array(jpeg, 0, 2);
    if (head[0] !== 0xff || head[1] !== 0xd8) return reject();
    return { ok: true, page: pages[i]!, image: new Blob([jpeg], { type: 'image/jpeg' }) };
  });
}

/**
 * Renders scanned PDF pages to JPEG images in the user's browser (LIB-2d), inside a sandbox without network
 * or WebAssembly, batch by batch. A page that cannot be rendered fails alone; a limit hit inside pdf.js stops
 * the batch early, and the missing pages are reported as failed. `onBatch` is awaited after each batch, before the
 * next one renders, so a later batch failing never loses the pages already rendered.
 */
export async function renderPdfPagesInBrowser(file: Blob, pages: number[],
  options: { signal?: AbortSignal; onBatch?: (batch: PageImage[]) => Promise<void> } = {}): Promise<PageImage[]> {
  if (!isLibraryScanRecognitionEnabled()) throw new SandboxError('FEATURE_DISABLED');
  if (file.size === 0) throw new SandboxError('INPUT_EMPTY');
  if (file.size > SANDBOX_LIMITS.maxInputBytes) throw new SandboxError('INPUT_TOO_LARGE');
  const [source, pdf] = await withinDeadline(Promise.all([loadWorkerBundle(PDF_RENDER_WORKER_PATH), file.arrayBuffer()]),
    Date.now() + LOAD_TIMEOUT_MS, options.signal);
  const results: PageImage[] = [];
  for (let start = 0; start < pages.length; start += PDF_RENDER_LIMITS.maxPages) {
    const batch = pages.slice(start, start + PDF_RENDER_LIMITS.maxPages);
    const value = await runSandboxedWorker({ workerSource: source, input: packRenderInput(new Uint8Array(pdf), batch),
      timeoutMs: LOAD_TIMEOUT_MS + batch.length * PDF_RENDER_LIMITS.pageTimeoutMs, signal: options.signal });
    const rendered = validate(value, batch);
    const done = [...rendered, ...batch.slice(rendered.length).map((page): PageImage => ({ ok: false, page, code: 'PDF_INVALID' }))];
    results.push(...done);
    await options.onBatch?.(done);
  }
  return results;
}
