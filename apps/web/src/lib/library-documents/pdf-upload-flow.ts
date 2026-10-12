/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { PdfExtraction, PdfPage } from '@/lib/library-sandbox/pdf/types';
import { LIBRARY_MAX_BYTES, PDF_MIME, type LibraryPurpose } from './format';
import { runExtractedUpload, type ExtractedUploadApi } from './extracted-upload-flow';
import type { UploadAttempt, UploadStage } from './upload-flow';

/** completePdfUpload (#800) takes the LIB-2c page list as is; page numbers come from its order. */
export type PdfMeta = { pageCount: number; pages: PdfPage[] };
/** What the browser extracted (LIB-2c), ready to upload. Kept on the item so a retry does not re-extract. */
export type PreparedPdf = { text: Blob } & PdfMeta;
export type PdfUploadApi = ExtractedUploadApi<PdfMeta>;

/** Scanned pages the server queues for recognition per file, in page order (LIB_DOCS_PLAN §4.4 initial value). */
export const PDF_RECOGNITION_LIMIT = 50;

type Input = {
  file: Blob; filename: string; purpose: LibraryPurpose; prepared: PreparedPdf;
  attempt: UploadAttempt; newId: () => string; onStage: (stage: UploadStage, progress?: number) => void;
};

/**
 * Converts the LIB-2c result into the upload payload. The text is sent exactly as extracted (form
 * feeds between pages, empty slots for scanned and blank pages); a fully scanned PDF has empty text.
 */
export function preparePdf(extraction: PdfExtraction): { ok: true; prepared: PreparedPdf } | { ok: false; message: string } {
  const { pages } = extraction;
  if (!pages.some((page) => page.status !== 'blank')) {
    return { ok: false, message: '这个 PDF 里没有可以读取的文字，也没有需要识别的扫描页。' };
  }
  const bytes = new TextEncoder().encode(extraction.text);
  if (bytes.length > LIBRARY_MAX_BYTES) return { ok: false, message: '文字内容太多，超出了可以处理的上限，请拆分后再上传。' };
  const copy = pages.map(({ status, imageCoverage }) => ({ status, imageCoverage }));
  return { ok: true, prepared: { text: new Blob([bytes], { type: 'text/plain' }), pageCount: copy.length, pages: copy } };
}

/**
 * What the server recorded for the scanned pages, by the same rule it applies on publish (#800): the
 * first 50 scanned pages wait for recognition, later ones are over the per-file limit. Recognition
 * itself is LIB-2d; nothing here starts it. Undefined when the PDF has no scanned page.
 */
export function pdfScanSummary(pages: readonly PdfPage[]): string | undefined {
  const scanned = pages.filter((page) => page.status === 'scanned').length;
  if (!scanned) return undefined;
  const waiting = Math.min(scanned, PDF_RECOGNITION_LIMIT);
  const over = scanned - waiting;
  const head = `共 ${pages.length} 页，其中 ${scanned} 页是扫描页`;
  if (!over) return `${head}，待识别`;
  return `${head}：前 ${waiting} 页待识别，其余 ${over} 页超出单个文件的识别上限（${PDF_RECOGNITION_LIMIT} 页）`;
}

export function runPdfUpload(api: PdfUploadApi, { prepared, ...input }: Input): Promise<{ documentId: string }> {
  const { text, pageCount, pages } = prepared;
  return runExtractedUpload(api, { ...input, contentType: PDF_MIME, text, meta: { pageCount, pages } });
}
