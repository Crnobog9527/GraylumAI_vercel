/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { AnnotationMode, getDocument, PasswordException, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { SandboxError, type SandboxErrorCode } from '../errors';
import { PDF_LIMITS, PDF_RENDER_LIMITS, SANDBOX_LIMITS } from '../limits';
import { PDF_DOCUMENT_OPTIONS } from './document-options';
import { EmbeddedDataFactory } from './embedded-data';
import type { PdfGuard } from './guard';
import { precheckPdf } from './precheck';

/**
 * Scanned PDF pages → JPEG images for browser recognition (LIB-2d, LIB_DOCS_PLAN §4.4: long edge 1,600 px,
 * at most 600,000 bytes). Same hardened pdf.js build and stream caps as text extraction, in a sandbox
 * without WebAssembly; unlike extraction, images are decoded (pdf.js's own decoders, up to a pixel cap) and
 * drawn on an OffscreenCanvas. Annotations, forms and scripts are never drawn or run.
 */

export type RenderedPage = { ok: true; page: number; width: number; height: number; jpeg: ArrayBuffer }
  | { ok: false; page: number; code: SandboxErrorCode };

/** pdf.js canvas factory for a Worker (no DOM): OffscreenCanvas, read back on the CPU. */
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    if (!(width > 0 && height > 0) || width * height > PDF_RENDER_LIMITS.maxCanvasPixels) throw new SandboxError('INPUT_TOO_LARGE');
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  reset(entry: { canvas: OffscreenCanvas }, width: number, height: number) {
    if (!(width > 0 && height > 0) || width * height > PDF_RENDER_LIMITS.maxCanvasPixels) throw new SandboxError('INPUT_TOO_LARGE');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  destroy(entry: { canvas: OffscreenCanvas | null; context: unknown }) {
    if (entry.canvas) entry.canvas.width = entry.canvas.height = 0;
    entry.canvas = null;
    entry.context = null;
  }
}

/** No SVG filters in a Worker: transfer maps and HCM filters are skipped ("none"), as pdf.js does without a DOM. */
class NoFilterFactory {
  addFilter() { return 'none'; }
  addHCMFilter() { return 'none'; }
  addAlphaFilter() { return 'none'; }
  addLuminosityFilter() { return 'none'; }
  addKnockoutFilter() { return 'none'; }
  addHighlightHCMFilter() { return 'none'; }
  addSelectionHCMFilter() { return 'none'; }
  addSelectionFilter() { return 'none'; }
  createSelectionStyle() { return null; }
  destroy() {}
}

const DOCUMENT_OPTIONS = { ...PDF_DOCUMENT_OPTIONS, BinaryDataFactory: EmbeddedDataFactory,
  CanvasFactory: OffscreenCanvasFactory, FilterFactory: NoFilterFactory, maxImageSize: PDF_RENDER_LIMITS.maxImagePixels };

function failure(guard: PdfGuard, error: unknown): SandboxError {
  if (guard.hit) return new SandboxError(guard.hit);
  if (error instanceof SandboxError) return error;
  if (error instanceof PasswordException) return new SandboxError('PDF_ENCRYPTED');
  return new SandboxError('PDF_INVALID');
}

async function jpeg(canvas: OffscreenCanvas): Promise<ArrayBuffer> {
  for (const quality of PDF_RENDER_LIMITS.jpegQualities) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (blob.size <= PDF_RENDER_LIMITS.maxJpegBytes) return blob.arrayBuffer();
  }
  throw new SandboxError('INPUT_TOO_LARGE');
}

async function renderPage(document: PDFDocumentProxy, number: number, guard: PdfGuard): Promise<RenderedPage> {
  const page = await document.getPage(number);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = PDF_RENDER_LIMITS.longEdgePixels / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const width = Math.round(viewport.width), height = Math.round(viewport.height);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new SandboxError('WORKER_FAILED');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    const task = page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport, annotationMode: AnnotationMode.DISABLE, background: '#ffffff' });
    await task.promise;
    if (guard.hit) throw new SandboxError(guard.hit);
    return { ok: true, page: number, width, height, jpeg: await jpeg(canvas) };
  } finally {
    page.cleanup();
  }
}

/** Renders the requested pages (1-based, at most PDF_RENDER_LIMITS.maxPages per run); each page succeeds or fails alone. */
export async function renderPdfPages(input: Uint8Array, pages: number[], guard: PdfGuard): Promise<RenderedPage[]> {
  if (input.byteLength === 0) throw new SandboxError('INPUT_EMPTY');
  if (input.byteLength > SANDBOX_LIMITS.maxInputBytes) throw new SandboxError('INPUT_TOO_LARGE');
  if (pages.length < 1 || pages.length > PDF_RENDER_LIMITS.maxPages || new Set(pages).size !== pages.length) {
    throw new SandboxError('SANDBOX_PROTOCOL');
  }
  precheckPdf(input);
  guard.hit = null;
  guard.objects = 0;
  const task = getDocument({ ...DOCUMENT_OPTIONS, data: input.slice() });
  try {
    let document: PDFDocumentProxy;
    try {
      document = await task.promise;
    } catch (error) {
      throw failure(guard, error);
    }
    if (guard.hit) throw new SandboxError(guard.hit);
    if ((await document.getPermissions()) !== null) throw new SandboxError('PDF_ENCRYPTED');
    if (!Number.isInteger(document.numPages) || document.numPages > PDF_LIMITS.maxPages) throw new SandboxError('PDF_PAGE_COUNT');
    const results: RenderedPage[] = [];
    for (const number of pages) {
      if (!Number.isInteger(number) || number < 1 || number > document.numPages) throw new SandboxError('SANDBOX_PROTOCOL');
      results.push(await renderPage(document, number, guard).catch((error: unknown): RenderedPage =>
        ({ ok: false, page: number, code: failure(guard, error).code })));
      // A limit hit inside pdf.js taints the rest of the document: stop here.
      if (guard.hit) break;
    }
    return results;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
