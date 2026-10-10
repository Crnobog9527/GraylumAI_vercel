/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { isLibraryDocxExtractionEnabled } from '../feature-flag';
import { SANDBOX_LIMITS } from '../limits';
import { runSandboxedWorker } from '../sandbox-host';
import { loadWorkerBundle, withinDeadline } from '../worker-bundle';
import type { DocxExtraction } from './document-text';
import { validateDocxExtraction } from './result';

/** Built by scripts/build-library-sandbox.mjs from ./worker-entry.ts; same origin, never a CDN. */
export const DOCX_WORKER_PATH = '/library-sandbox/docx-worker.js';

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
  const [source, input] = await withinDeadline(Promise.all([loadWorkerBundle(DOCX_WORKER_PATH), file.arrayBuffer()]), deadline, options.signal);
  const value = await runSandboxedWorker({
    workerSource: source, input, timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal,
  });
  return validateDocxExtraction(value);
}
