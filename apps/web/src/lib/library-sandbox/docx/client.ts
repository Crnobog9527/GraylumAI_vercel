/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { isLibraryDocxExtractionEnabled } from '../feature-flag';
import { SANDBOX_LIMITS } from '../limits';
import { runSandboxedWorker } from '../sandbox-host';
import type { DocxExtraction } from './document-text';
import { validateDocxExtraction } from './result';

/** Built by scripts/build-library-sandbox.mjs from ./worker-entry.ts; same origin, never a CDN. */
export const DOCX_WORKER_PATH = '/library-sandbox/docx-worker.js';

let workerSource: Promise<string> | null = null;

function loadWorkerSource(): Promise<string> {
  // The site proxy guards this path like any page (signed-in users only), so the session cookie is
  // sent; a redirect (e.g. to /login) or a non-script response is refused rather than run.
  workerSource ??= fetch(DOCX_WORKER_PATH, { credentials: 'same-origin', cache: 'no-cache', redirect: 'error' })
    .then((response) => {
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !/javascript/i.test(type)) throw new SandboxError('SANDBOX_UNAVAILABLE');
      return response.text();
    })
    .catch((error: unknown) => {
      workerSource = null;
      throw error instanceof SandboxError ? error : new SandboxError('SANDBOX_UNAVAILABLE');
    });
  return workerSource;
}

/** Settles with `task`, or rejects with SANDBOX_TIMEOUT at the deadline or on cancellation. */
function withinDeadline<T>(task: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new SandboxError('SANDBOX_TIMEOUT'));
    if (signal?.aborted) return stop();
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    signal?.addEventListener('abort', stop, { once: true });
    task.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    });
  });
}

export type DocxExtractOptions = {
  signal?: AbortSignal;
  /** Whole-run budget, including loading the worker bundle. Defaults to the Word limit. */
  timeoutMs?: number;
};

/**
 * Extracts text, heading structure and embedded images from a `.docx` in the user's own browser,
 * inside the network-less sandbox (LIB_DOCS_PLAN §4.1). The file never reaches a Graylum server
 * for parsing. Errors are `SandboxError` codes; see `sandboxErrorMessage` for user wording.
 */
export async function extractDocxInBrowser(file: Blob, options: DocxExtractOptions = {}): Promise<DocxExtraction> {
  if (!isLibraryDocxExtractionEnabled()) throw new SandboxError('FEATURE_DISABLED');
  if (file.size === 0) throw new SandboxError('INPUT_EMPTY');
  if (file.size > SANDBOX_LIMITS.maxInputBytes) throw new SandboxError('INPUT_TOO_LARGE');
  // The clock starts before the bundle download, so a stalled request also ends at the deadline.
  const deadline = Date.now() + (options.timeoutMs ?? SANDBOX_LIMITS.docxTimeoutMs);
  const [source, input] = await withinDeadline(Promise.all([loadWorkerSource(), file.arrayBuffer()]), deadline, options.signal);
  const value = await runSandboxedWorker({
    workerSource: source, input, timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal,
  });
  return validateDocxExtraction(value);
}
