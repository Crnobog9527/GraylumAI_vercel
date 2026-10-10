/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { AnnotationMode, getDocument, OPS, PasswordException, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { SandboxError, type SandboxErrorCode } from '../errors';
import { PDF_LIMITS, SANDBOX_LIMITS } from '../limits';
import { EmbeddedDataFactory } from './embedded-data';
import type { PdfGuard } from './guard';
import { imageCoverage } from './image-coverage';
import { hasTextLayer, pageText } from './page-text';
import { mentionsEncryption, precheckPdf } from './precheck';
import { PAGE_SEPARATOR, type PdfExtraction, type PdfPage } from './types';

/**
 * PDF → page-by-page plain text inside the sandbox Worker (LIB_DOCS_PLAN §4.2). pdf.js runs in this
 * same Worker (its "fake worker" mode, no second Worker), with no scripting, no font loading, no
 * image decoding, no WebAssembly and no network; only the text layer is read. Pages without a text
 * layer are classified as scanned (mostly images) or blank for later recognition (LIB-2d).
 */

const DOCUMENT_OPTIONS = {
  BinaryDataFactory: EmbeddedDataFactory,
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

function failure(guard: PdfGuard, error: unknown, fallback: SandboxErrorCode): SandboxError {
  if (guard.hit) return new SandboxError(guard.hit);
  if (error instanceof SandboxError) return error;
  if (error instanceof PasswordException) return new SandboxError('PDF_ENCRYPTED');
  return new SandboxError(fallback);
}

function checkGuard(guard: PdfGuard) {
  if (guard.hit) throw new SandboxError(guard.hit);
}

/** Encrypted with or without an open password: pdf.js parsed an encryption dictionary from the trailer. */
async function isEncrypted(document: PDFDocumentProxy): Promise<boolean> {
  if ((await document.getPermissions()) !== null) return true;
  const { info } = await document.getMetadata();
  return Boolean((info as { EncryptFilterName?: unknown } | null)?.EncryptFilterName);
}

async function readPage(document: PDFDocumentProxy, number: number, guard: PdfGuard): Promise<{ text: string; page: PdfPage }> {
  const page = await document.getPage(number);
  try {
    const content = await page.getTextContent();
    checkGuard(guard);
    const { transform, height } = page.getViewport({ scale: 1 });
    const text = pageText(content.items, { transform, height });
    if (hasTextLayer(text)) return { text, page: { status: 'text', imageCoverage: 0 } };
    const list = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
    checkGuard(guard);
    const coverage = imageCoverage(list.fnArray, list.argsArray, page.view, OPS);
    const status = coverage >= PDF_LIMITS.scannedImageCoverage ? 'scanned' : 'blank';
    return { text: '', page: { status, imageCoverage: Math.round(coverage * 100) / 100 } };
  } finally {
    page.cleanup();
  }
}

export async function extractPdf(input: Uint8Array, guard: PdfGuard): Promise<PdfExtraction> {
  if (input.byteLength === 0) throw new SandboxError('INPUT_EMPTY');
  if (input.byteLength > SANDBOX_LIMITS.maxInputBytes) throw new SandboxError('INPUT_TOO_LARGE');
  precheckPdf(input);
  guard.hit = null;
  guard.objects = 0;
  const task = getDocument({ ...DOCUMENT_OPTIONS, data: input.slice() });
  try {
    let document: PDFDocumentProxy;
    try {
      document = await task.promise;
    } catch (error) {
      const code = failure(guard, error, 'PDF_INVALID');
      throw code.code === 'PDF_INVALID' && mentionsEncryption(input) ? new SandboxError('PDF_ENCRYPTED') : code;
    }
    // pdf.js may have recovered from a limit (e.g. by rebuilding the cross-reference table): still refuse.
    checkGuard(guard);
    if (await isEncrypted(document)) throw new SandboxError('PDF_ENCRYPTED');
    const pageCount = document.numPages;
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new SandboxError('PDF_INVALID');
    if (pageCount > PDF_LIMITS.maxPages) throw new SandboxError('PDF_PAGE_COUNT');
    const encoder = new TextEncoder();
    const texts: string[] = [];
    const pages: PdfPage[] = [];
    let bytes = 0;
    for (let number = 1; number <= pageCount; number += 1) {
      const result = await readPage(document, number, guard).catch((error: unknown) => {
        throw failure(guard, error, 'PDF_INVALID');
      });
      bytes += encoder.encode(result.text).byteLength + 1;
      if (bytes > SANDBOX_LIMITS.maxTextBytes) throw new SandboxError('TEXT_TOO_LARGE');
      texts.push(result.text);
      pages.push(result.page);
    }
    checkGuard(guard);
    return { text: texts.join(PAGE_SEPARATOR), pageCount, pages };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
