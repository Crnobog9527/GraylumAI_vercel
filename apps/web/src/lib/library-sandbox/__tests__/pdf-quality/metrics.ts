/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Scoring for the LIB_DOCS_PLAN §4.5 text-PDF quality test.
import { indelDistance } from '../word-quality/metrics';

const CJK = '\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF';
const SPACE_NEXT_TO_CJK = new RegExp(`(?<=[${CJK}]) | (?=[${CJK}])`, 'gu');

/**
 * Unicode NFC, whitespace runs folded to one space, and spaces next to a Chinese character or
 * full-width punctuation removed: a PDF has no paragraph markup, so a wrapped Chinese line comes out
 * with a line break where the reader sees none. Applied to both sides, so it never hides lost text.
 */
export function normalizePdfText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().replace(SPACE_NEXT_TO_CJK, '');
}

export function pdfCharacterAccuracy(extracted: string, gold: string): { errors: number; length: number; accuracy: number } {
  const reference = normalizePdfText(gold);
  const errors = indelDistance(normalizePdfText(extracted), reference);
  const length = Array.from(reference).length;
  return { errors, length, accuracy: length ? Math.max(0, 1 - errors / length) : 1 };
}

const squeeze = (text: string) => text.normalize('NFC').replace(/\s+/gu, '');

/**
 * A page is in reading order when every reference line (header, heading, paragraph, table row,
 * footer) is found in the page's extracted text, whitespace ignored, each after the previous one.
 * A missing or misplaced line fails the page.
 */
export function pageInReadingOrder(extracted: string, goldLines: string[]): boolean {
  const text = squeeze(extracted);
  let cursor = 0;
  for (const line of goldLines.map(squeeze).filter(Boolean)) {
    const at = text.indexOf(line, cursor);
    if (at < 0) return false;
    cursor = at + line.length;
  }
  return true;
}
