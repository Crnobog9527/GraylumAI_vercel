/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { isLibraryPdfExtractionEnabled } from '../feature-flag';
import { SANDBOX_LIMITS } from '../limits';
import { runSandboxedWorker } from '../sandbox-host';
import { loadWorkerBundle, withinDeadline } from '../worker-bundle';
import { validatePdfExtraction } from './result';
import type { PdfExtraction } from './types';

/** Built by scripts/build-library-sandbox.mjs from ./worker-entry.ts; same origin, never a CDN. */
export const PDF_WORKER_PATH = '/library-sandbox/pdf-worker.js';

export type PdfExtractOptions = {
  signal?: AbortSignal;
  /** Whole-run budget, including loading the worker bundle. Defaults to the PDF limit (60 s). */
  timeoutMs?: number;
};

/**
 * Extracts the text layer of a PDF page by page in the user's own browser, inside the network-less
 * sandbox (LIB_DOCS_PLAN §4.2), and marks pages that need recognition. The file never reaches a
 * Graylum server for parsing. Errors are `SandboxError` codes; use `sandboxErrorMessage(code, 'pdf')`.
 */
export async function extractPdfInBrowser(file: Blob, options: PdfExtractOptions = {}): Promise<PdfExtraction> {
  if (!isLibraryPdfExtractionEnabled()) throw new SandboxError('FEATURE_DISABLED');
  if (file.size === 0) throw new SandboxError('INPUT_EMPTY');
  if (file.size > SANDBOX_LIMITS.maxInputBytes) throw new SandboxError('INPUT_TOO_LARGE');
  const deadline = Date.now() + (options.timeoutMs ?? SANDBOX_LIMITS.pdfTimeoutMs);
  const loading = Promise.all([loadWorkerBundle(PDF_WORKER_PATH), file.arrayBuffer()]);
  const [source, input] = await withinDeadline(loading, deadline, options.signal);
  const value = await runSandboxedWorker({
    workerSource: source, input, timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal,
  });
  return validatePdfExtraction(value);
}
