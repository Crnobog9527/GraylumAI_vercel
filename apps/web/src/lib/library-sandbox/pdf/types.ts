/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * `text`: the PDF has a selectable text layer on this page.
 * `scanned`: no text layer and images cover most of the page → 待识别 (recognised later, LIB-2d).
 * `blank`: no text layer and not mostly images (empty pages, drawings); never recognised automatically.
 */
export type PdfPageStatus = 'text' | 'scanned' | 'blank';

export type PdfPage = {
  status: PdfPageStatus;
  /** Share of the page area covered by images, 0–1, rounded to two decimals; 0 on text pages. */
  imageCoverage: number;
};

export type PdfExtraction = {
  /** One entry per page, joined with form feeds (`\f`); scanned and blank pages keep an empty slot. */
  text: string;
  pageCount: number;
  pages: PdfPage[];
};

export const PAGE_SEPARATOR = '\f';
