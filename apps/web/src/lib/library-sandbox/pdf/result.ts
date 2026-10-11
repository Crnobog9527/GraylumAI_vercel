/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { PDF_LIMITS, SANDBOX_LIMITS } from '../limits';
import { isRecord } from '../protocol';
import { hasTextLayer } from './page-text';
import { PAGE_SEPARATOR, type PdfExtraction, type PdfPage, type PdfPageStatus } from './types';

/**
 * The page's check of a PDF reply from the sandbox, treated as untrusted: types, ranges and the
 * page invariants (one text slot per page, `text` pages have visible text and the others none) are
 * checked, then copied into a fresh object. Anything else is a protocol error.
 */

const STATUSES = new Set<PdfPageStatus>(['text', 'scanned', 'blank']);

const reject = (): never => {
  throw new SandboxError('SANDBOX_PROTOCOL');
};

function page(value: unknown, text: string): PdfPage {
  if (!isRecord(value) || !STATUSES.has(value.status as PdfPageStatus)) return reject();
  const coverage = value.imageCoverage;
  if (typeof coverage !== 'number' || !(coverage >= 0 && coverage <= 1)) return reject();
  const status = value.status as PdfPageStatus;
  if ((status === 'text') !== hasTextLayer(text) || (status === 'text' && coverage !== 0)) return reject();
  if (status === 'scanned' && coverage < PDF_LIMITS.scannedImageCoverage) return reject();
  return { status, imageCoverage: coverage };
}

export function validatePdfExtraction(value: unknown): PdfExtraction {
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.pages)) return reject();
  const { text, pageCount, pages } = value;
  if (new TextEncoder().encode(text).byteLength > SANDBOX_LIMITS.maxTextBytes) return reject();
  if (!Number.isInteger(pageCount) || pageCount !== pages.length || pages.length < 1 || pages.length > PDF_LIMITS.maxPages) {
    return reject();
  }
  const slots = text.split(PAGE_SEPARATOR);
  if (slots.length !== pages.length) return reject();
  return { text, pageCount: pages.length, pages: pages.map((item, index) => page(item, slots[index])) };
}
