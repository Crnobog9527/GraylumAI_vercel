/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { PDF_LIMITS } from '../limits';
import { installPdfGuard } from './guard';

/**
 * PDF Worker hardening on top of worker/harden (imported first by worker-entry). pdf.js inflates
 * some streams through the browser's DecompressionStream, which has no output cap; without it pdf.js
 * falls back to its own decoders, which the patched stream cap covers.
 */
try {
  Object.defineProperty(globalThis, 'DecompressionStream', { value: undefined, writable: false, configurable: false });
} catch {
  // Non-configurable in some engine: the fallback is then unused and only the time limit applies.
}

export const pdfGuard = installPdfGuard(PDF_LIMITS.maxStreamBytes);
