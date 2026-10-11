/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { normalizeCjkRadicals } from './cjk-radicals';

/**
 * One page of pdf.js text content → plain text. Lines stay in content-stream order (how the
 * producing program wrote them, which for ordinary documents is reading order, columns included);
 * pdf.js already inserts spaces between words and marks line ends. One correction: lines in the top
 * and bottom margin bands (running headers, footers, page numbers) are moved to the start and end of
 * the page, because some writers (Chrome's "Save as PDF") draw them after the body.
 * Control characters, including form feeds that would break the page separator, are removed; tabs
 * and line breaks are kept. CJK radicals that a writer put in place of ordinary characters are mapped
 * back (see cjk-radicals.ts).
 */

type TextPiece = { str?: unknown; hasEOL?: unknown; transform?: unknown };

/** The page's viewport at scale 1: maps PDF user space to top-down page coordinates. */
export type PageFrame = { transform: number[]; height: number };

/** Share of the page height at the top and at the bottom treated as header / footer bands. */
export const MARGIN_BAND = 0.075;

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F\u2028\u2029]/g;

type Line = { text: string; top: number | null };

function topOf(item: TextPiece, frame: PageFrame | undefined): number | null {
  const m = item.transform;
  const v = frame?.transform;
  if (!Array.isArray(m) || m.length !== 6 || !v || v.length !== 6) return null;
  const [x, y] = [m[4], m[5]];
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  const top = v[1] * x + v[3] * y + v[5];
  return Number.isFinite(top) ? top : null;
}

function lines(items: readonly unknown[], frame: PageFrame | undefined): Line[] {
  const result: Line[] = [];
  let current: Line = { text: '', top: null };
  for (const raw of items) {
    // Text items carry `str`; marked-content items (none are requested) would simply be skipped.
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as TextPiece;
    if (typeof item.str === 'string' && item.str) {
      current.text += item.str.replace(/\r\n?/g, '\n').replace(CONTROL, '');
      if (current.top === null && /\S/u.test(item.str)) current.top = topOf(item, frame);
    }
    if (item.hasEOL === true) {
      result.push(current);
      current = { text: '', top: null };
    }
  }
  if (current.text) result.push(current);
  return result;
}

function band(line: Line, frame: PageFrame | undefined): 'top' | 'body' | 'bottom' {
  if (!frame || line.top === null || !(frame.height > 0)) return 'body';
  if (line.top < frame.height * MARGIN_BAND) return 'top';
  if (line.top > frame.height * (1 - MARGIN_BAND)) return 'bottom';
  return 'body';
}

export function pageText(items: readonly unknown[], frame?: PageFrame): string {
  const all = lines(items, frame);
  const ordered = (['top', 'body', 'bottom'] as const).flatMap((name) => all.filter((line) => band(line, frame) === name));
  return normalizeCjkRadicals(ordered.map((line) => line.text).join('\n'))
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the page has at least one visible (non-whitespace) character. */
export function hasTextLayer(text: string): boolean {
  return /\S/u.test(text);
}
