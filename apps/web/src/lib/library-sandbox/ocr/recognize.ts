/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * PP-OCRv6 text recognition pre- and post-processing (LIB-2d), pure functions. A text box is scaled to a
 * height of 48 pixels, its red channel normalised to [-1, 1] and repeated into three channels; the model's
 * per-step class scores are decoded greedily (CTC). Class 0 is the CTC blank, classes 1…N are the official
 * dictionary, class N + 1 is a space. Settings follow the evaluated configuration.
 */

export const RECOGNITION_HEIGHT = 48;
const MIN_WIDTH = 8;
/** Boxes this much taller than wide are read rotated by 90°. */
export const TALL_BOX_RATIO = 1.5;
const MIN_CONFIDENCE = 0.5;
/** Results without a letter or digit need more confidence (stray marks, rules, logos). */
const SYMBOL_EXTRA_CONFIDENCE = 0.3;
const SAME_CLASS_GAP = 2.5;
const CROSS_CLASS_GAP = 1.5;
const FULLWIDTH_OFFSET = 0xfee0;
const CJK = /[⺀-鿿가-힯豈-﫿]/;

export function recognitionWidth(width: number, height: number): number {
  return Math.max(MIN_WIDTH, Math.round((RECOGNITION_HEIGHT * width) / height));
}

/** CHW tensor (3 × 48 × width) from the RGBA pixels of the resized box. */
export function recognitionTensor(rgba: Uint8ClampedArray, width: number): Float32Array {
  const size = width * RECOGNITION_HEIGHT;
  const tensor = new Float32Array(3 * size);
  for (let i = 0, p = 0; i < size; i++, p += 4) tensor[i] = rgba[p]! / 127.5 - 1;
  tensor.copyWithin(size, 0, size);
  tensor.copyWithin(2 * size, 0, size);
  return tensor;
}

export type Decoded = { text: string; confidence: number };

const charClass = (char: string) => (/\p{L}/u.test(char) ? 0 : /\p{N}/u.test(char) ? 1 : 2);

/** Adds a space where the gap between two decoded characters is clearly wider than usual. */
function injectGapSpaces(chars: string[], positions: number[]) {
  if (chars.length < 4) return;
  const deltas = positions.slice(1).map((value, i) => value - positions[i]!);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const quantum = sorted.find((delta) => delta > 0) ?? 0;
  if (median <= 0 || quantum <= 0) return;
  for (let i = chars.length - 1; i >= 1; i--) {
    const k = charClass(chars[i]!) === charClass(chars[i - 1]!) ? SAME_CLASS_GAP : CROSS_CLASS_GAP;
    if (positions[i]! - positions[i - 1]! > median + k * quantum && chars[i] !== ' ' && chars[i - 1] !== ' '
      && chars[i] !== chars[i - 1]) {
      chars.splice(i, 0, ' ');
      positions.splice(i, 0, (positions[i - 1]! + positions[i]!) / 2);
    }
  }
}

/** Collapses double spaces; text without CJK characters gets half-width forms. */
function refine(chars: string[]) {
  for (let i = chars.length - 1; i >= 1; i--) if (chars[i] === ' ' && chars[i - 1] === ' ') chars.splice(i, 1);
  if (CJK.test(chars.join(''))) return;
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i]!.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) chars[i] = String.fromCodePoint(code - FULLWIDTH_OFFSET);
    else if (code === 0x3000) chars[i] = ' ';
  }
}

/** Greedy CTC decode of `steps × classes` scores with the official dictionary (classes = dictionary + 2). */
export function decodeCtc(scores: ArrayLike<number>, steps: number, classes: number, dictionary: readonly string[]): Decoded {
  if (classes !== dictionary.length + 2) throw new Error('OCR_DICTIONARY_MISMATCH');
  const space = classes - 1;
  const chars: string[] = [];
  const positions: number[] = [];
  let last = -1, sum = 0;
  for (let t = 0; t < steps; t++) {
    const base = t * classes;
    let best = 0, bestScore = scores[base] ?? 0;
    for (let c = 1; c < classes; c++) {
      const score = scores[base + c] ?? 0;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best !== 0 && best !== last) {
      chars.push(best === space ? ' ' : dictionary[best - 1]!);
      positions.push((t + 0.5) / steps);
      sum += bestScore;
    }
    last = best;
  }
  const confidence = chars.length ? sum / chars.length : 0;
  injectGapSpaces(chars, positions);
  refine(chars);
  return { text: chars.join(''), confidence };
}

/** Whether a decoded box is kept (low-confidence noise is dropped). */
export function keepRecognized({ text, confidence }: Decoded): boolean {
  const bar = /[\p{L}\p{N}]/u.test(text) ? MIN_CONFIDENCE : Math.min(1, MIN_CONFIDENCE + SYMBOL_EXTRA_CONFIDENCE);
  return confidence >= bar;
}
