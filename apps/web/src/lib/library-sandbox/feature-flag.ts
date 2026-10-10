/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * LIB-2b is staged code, off by default: browser `.docx` extraction runs only when the build sets
 * `NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION=true`. Nothing in the app calls it yet; the library upload
 * (LIB-2a/LIB-3) wires it in and stays behind the library's own server-side switch.
 */
export function isLibraryDocxExtractionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION === 'true';
}

/**
 * LIB-2c, same staging rule: browser PDF text extraction runs only when the build sets
 * `NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION=true`. Nothing in the app calls it yet.
 */
export function isLibraryPdfExtractionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIBRARY_PDF_EXTRACTION === 'true';
}
