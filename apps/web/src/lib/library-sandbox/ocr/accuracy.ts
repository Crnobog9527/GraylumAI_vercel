/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Character accuracy as in scripts/lib-2d-ocr-eval: 1 − edit distance ÷ reference length, after NFKC and removing spaces. */
export function characterAccuracy(reference: string, text: string): number {
  const norm = (s: string) => [...s.normalize('NFKC').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, '')];
  const a = norm(reference), b = norm(text);
  if (!a.length) return b.length ? 0 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1), previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }
  return Math.max(0, 1 - previous[b.length]! / a.length);
}
