/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { isLibraryScanRecognitionEnabled } from '../feature-flag';
import { OCR_LIMITS } from '../limits';
import { runSandboxedWorker } from '../sandbox-host';
import { loadWorkerBundle, withinDeadline } from '../worker-bundle';
import { OCR_ASSET_BASE, OCR_ASSET_SHA256, OCR_WORKER_PATH } from './assets';
import { packOcrInput, type OcrModelParts } from './pack';
import { validateOcrBatch } from './result';
import type { OcrPage } from './types';

let models: Promise<OcrModelParts> | null = null;

const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Same-origin runtime and models (about 6 MB compressed after the first download), each checked by SHA-256. */
function loadModels(): Promise<OcrModelParts> {
  models ??= Promise.all(Object.entries(OCR_ASSET_SHA256).map(async ([part, [file, sha]]) => {
    const response = await fetch(OCR_ASSET_BASE + file, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new SandboxError('SANDBOX_UNAVAILABLE');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha) throw new SandboxError('SANDBOX_UNAVAILABLE');
    return [part, bytes] as const;
  })).then((entries) => Object.fromEntries(entries) as OcrModelParts)
    .catch((error: unknown) => {
      models = null;
      throw error instanceof SandboxError ? error : new SandboxError('SANDBOX_UNAVAILABLE');
    });
  return models;
}

export type OcrOptions = { signal?: AbortSignal; onPage?: (index: number, page: OcrPage) => void };

/**
 * Recognises scanned page images (JPEG/PNG) in the user's own browser, inside the recognition sandbox
 * (LIB_DOCS_PLAN §4.4, Owner 2026-10-17: browser PaddleOCR; the sandbox may compile WebAssembly but has no
 * network). No image or text reaches a Graylum server or a model provider here, and nothing is charged.
 * Images run in batches of OCR_LIMITS.maxImages; `onPage` reports each result as its batch finishes.
 */
export async function recognizeImagesInBrowser(images: Blob[], options: OcrOptions = {}): Promise<OcrPage[]> {
  if (!isLibraryScanRecognitionEnabled()) throw new SandboxError('FEATURE_DISABLED');
  if (images.some((image) => image.size === 0)) throw new SandboxError('INPUT_EMPTY');
  if (images.some((image) => image.size > OCR_LIMITS.maxImageBytes)) throw new SandboxError('INPUT_TOO_LARGE');
  const loading = Promise.all([loadWorkerBundle(OCR_WORKER_PATH), loadModels()]);
  const [source, parts] = await withinDeadline(loading, Date.now() + OCR_LIMITS.initTimeoutMs, options.signal);
  const run = async (bytes: Uint8Array[]) => validateOcrBatch(await runSandboxedWorker({
    workerSource: source, input: packOcrInput({ ...parts, images: bytes }), allowWasm: true, signal: options.signal,
    timeoutMs: OCR_LIMITS.initTimeoutMs + bytes.length * OCR_LIMITS.imageTimeoutMs,
  }), bytes.length).pages;
  const timedOut = (error: unknown) => error instanceof SandboxError && error.code === 'SANDBOX_TIMEOUT' && !options.signal?.aborted;
  // One image on its own deadline: running out of time is that image's result, not a failure of the whole call.
  const single = (image: Uint8Array) => run([image]).then(([page]) => page!, (error: unknown): OcrPage => {
    if (timedOut(error)) return { ok: false, code: 'SANDBOX_TIMEOUT' };
    throw error;
  });
  const results: OcrPage[] = [];
  for (let start = 0; start < images.length; start += OCR_LIMITS.maxImages) {
    const batch = images.slice(start, start + OCR_LIMITS.maxImages);
    const bytes = await Promise.all(batch.map(async (image) => new Uint8Array(await image.arrayBuffer())));
    let pages: OcrPage[];
    if (bytes.length === 1) pages = [await single(bytes[0]!)];
    else {
      try {
        pages = await run(bytes);
      } catch (error) {
        // A batch that ran out of time is retried one image at a time, each with its own deadline, so one slow or
        // stuck image cannot use up the others' time; that image alone is reported as timed out.
        if (!timedOut(error)) throw error;
        pages = [];
        for (const image of bytes) pages.push(await single(image));
      }
    }
    pages.forEach((page, i) => {
      results.push(page);
      options.onPage?.(start + i, page);
    });
  }
  return results;
}
