/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SandboxErrorCode } from '../errors';

/**
 * Shared state between the patched pdf.js worker code (scripts/library-sandbox-pdfjs.mjs) and our
 * extractor, both running in the same sandbox Worker. pdf.js tolerates many errors by design and may
 * swallow the exception a limit throws, so a limit also records itself here and the extractor fails
 * the whole file instead of returning partial text.
 */
export type PdfGuard = { maxStreamBytes: number; hit: SandboxErrorCode | null };

declare global {
  var __graylumPdfGuard: PdfGuard | undefined;
}

export function installPdfGuard(maxStreamBytes: number): PdfGuard {
  const guard: PdfGuard = { maxStreamBytes, hit: null };
  Object.defineProperty(globalThis, '__graylumPdfGuard', { value: guard, writable: false, configurable: false });
  return guard;
}
