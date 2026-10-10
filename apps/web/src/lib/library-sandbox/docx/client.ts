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
  workerSource ??= fetch(DOCX_WORKER_PATH, { credentials: 'omit', cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new SandboxError('SANDBOX_UNAVAILABLE');
      return response.text();
    })
    .catch((error: unknown) => {
      workerSource = null;
      throw error instanceof SandboxError ? error : new SandboxError('SANDBOX_UNAVAILABLE');
    });
  return workerSource;
}

/**
 * Extracts text, heading structure and embedded images from a `.docx` in the user's own browser,
 * inside the network-less sandbox (LIB_DOCS_PLAN §4.1). The file never reaches a Graylum server
 * for parsing. Errors are `SandboxError` codes; see `sandboxErrorMessage` for user wording.
 */
export async function extractDocxInBrowser(file: Blob, options: { signal?: AbortSignal } = {}): Promise<DocxExtraction> {
  if (!isLibraryDocxExtractionEnabled()) throw new SandboxError('FEATURE_DISABLED');
  if (file.size === 0) throw new SandboxError('INPUT_EMPTY');
  if (file.size > SANDBOX_LIMITS.maxInputBytes) throw new SandboxError('INPUT_TOO_LARGE');
  const [source, input] = await Promise.all([loadWorkerSource(), file.arrayBuffer()]);
  const value = await runSandboxedWorker({
    workerSource: source, input, timeoutMs: SANDBOX_LIMITS.docxTimeoutMs, signal: options.signal,
  });
  return validateDocxExtraction(value);
}
