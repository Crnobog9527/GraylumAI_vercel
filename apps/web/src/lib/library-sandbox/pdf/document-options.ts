/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * pdf.js `getDocument` options for the sandbox (LIB_DOCS_PLAN §4.2), apart from the data factory.
 * `isEvalSupported` no longer exists in pdf.js 6 (the eval-based font compiler was removed; the
 * patched bundle is checked for it in tests) and the sandbox CSP forbids eval anyway; it is still
 * set to false so a future pdf.js that reads it again gets the safe value.
 */
export const PDF_DOCUMENT_OPTIONS = {
  isEvalSupported: false,
  useWorkerFetch: false,
  useSystemFonts: false,
  disableFontFace: true,
  useWasm: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  // With the build patch every image is recorded (position and size) instead of being decoded.
  maxImageSize: 0,
  enableXfa: false,
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
  verbosity: 0,
} as const;
