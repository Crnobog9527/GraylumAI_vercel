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

/**
 * LIB-2d, same staging rule: browser recognition of scanned pages runs only when the build sets
 * `NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION=true`. Nothing in the app calls it yet; it opens to users only after the
 * LIB_DOCS_PLAN §4.5 checks (real Word files, a mid-range computer) are reported to the Owner.
 */
export function isLibraryScanRecognitionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION === 'true';
}
