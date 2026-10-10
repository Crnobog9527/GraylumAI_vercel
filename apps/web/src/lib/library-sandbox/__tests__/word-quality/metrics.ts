/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Scoring for the LIB_DOCS_PLAN §4.5 Word quality test.

/** Unicode NFC, every whitespace run (line breaks, tabs, NBSP) folded to one space. */
export function normalize(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * Insert/delete edit distance over code points (Myers O(ND)). A substitution counts as two edits,
 * so the character accuracy derived from it is conservative (never better than Levenshtein's).
 */
export function indelDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = x.length;
  const m = y.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i += 1;
        j += 1;
      }
      v[offset + k] = i;
      if (i >= n && j >= m) return d;
    }
  }
  return max;
}

export function characterAccuracy(extracted: string, gold: string): { errors: number; length: number; accuracy: number } {
  const reference = normalize(gold);
  const errors = indelDistance(normalize(extracted), reference);
  const length = Array.from(reference).length;
  return { errors, length, accuracy: length ? Math.max(0, 1 - errors / length) : 1 };
}

type Heading = { level: number; text: string };

/** Share of reference headings found with the same level, in the same relative order (LCS). */
export function headingOrder(extracted: Heading[], gold: Heading[]): { matched: number; total: number } {
  const key = (heading: Heading) => `${heading.level}|${normalize(heading.text)}`;
  const a = extracted.map(key);
  const b = gold.map(key);
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return { matched: previous[b.length], total: b.length };
}
