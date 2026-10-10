/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SandboxErrorCode } from '../errors';

/**
 * Shared state between the patched pdf.js worker code (scripts/library-sandbox-pdfjs.mjs) and our
 * extractor, both running in the same sandbox Worker. pdf.js tolerates many errors by design and may
 * swallow the exception a limit throws, so a limit also records itself here and the extractor fails
 * the whole file instead of returning partial text.
 */
export type PdfGuard = {
  maxStreamBytes: number;
  /** Cross-reference entries and parsed object-stream members, counted by the patched pdf.js. */
  maxObjects: number;
  objects: number;
  hit: SandboxErrorCode | null;
};

declare global {
  var __graylumPdfGuard: PdfGuard | undefined;
}

export function installPdfGuard(maxStreamBytes: number, maxObjects: number): PdfGuard {
  const guard: PdfGuard = { maxStreamBytes, maxObjects, objects: 0, hit: null };
  Object.defineProperty(globalThis, '__graylumPdfGuard', { value: guard, writable: false, configurable: false });
  return guard;
}
