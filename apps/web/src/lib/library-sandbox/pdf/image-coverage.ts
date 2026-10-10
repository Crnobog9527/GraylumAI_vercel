/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Share of a page covered by images, from a pdf.js operator list. Images are never decoded (see
 * scripts/library-sandbox-pdfjs.mjs): each is a unit square placed by the current transformation
 * matrix. The area is measured on a fixed grid over the page box, so overlapping images count once.
 * Because the patched pdf.js records every image (masks and inline images included) as a plain
 * `paintImageXObject`, the only grouped form the operator-list optimiser can produce is
 * `paintImageXObjectRepeat`.
 */

type Matrix = [number, number, number, number, number, number];

export type CoverageOps = {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintImageMaskXObject: number;
  paintInlineImageXObject: number;
  paintImageXObjectRepeat: number;
};

const GRID = 64;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    n[0] * m[0] + n[1] * m[2], n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2], n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4], n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

function asMatrix(value: unknown): Matrix | null {
  if (!value || typeof value !== 'object' || !('length' in value) || (value as ArrayLike<unknown>).length !== 6) return null;
  const list = Array.from(value as ArrayLike<unknown>);
  return list.every((item) => typeof item === 'number' && Number.isFinite(item)) ? (list as Matrix) : null;
}

class Grid {
  readonly cells = new Uint8Array(GRID * GRID);
  covered = 0;
  constructor(private readonly view: [number, number, number, number]) {}

  /** Marks the axis-aligned box of the unit square under `m`, clipped to the page box. */
  mark(m: Matrix) {
    const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
    const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
    const [x0, y0, x1, y1] = this.view;
    const cell = (value: number, low: number, high: number) => ((value - low) / (high - low)) * GRID;
    const left = Math.max(0, Math.floor(cell(Math.min(...xs), x0, x1)));
    const right = Math.min(GRID, Math.ceil(cell(Math.max(...xs), x0, x1)));
    const bottom = Math.max(0, Math.floor(cell(Math.min(...ys), y0, y1)));
    const top = Math.min(GRID, Math.ceil(cell(Math.max(...ys), y0, y1)));
    for (let row = bottom; row < top; row += 1) {
      for (let column = left; column < right; column += 1) {
        const index = row * GRID + column;
        if (!this.cells[index]) {
          this.cells[index] = 1;
          this.covered += 1;
        }
      }
    }
  }

  get full() {
    return this.covered === this.cells.length;
  }
}

export function imageCoverage(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, view: number[], ops: CoverageOps): number {
  const [x0, y0, x1, y1] = view;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return 0;
  const grid = new Grid([x0, y0, x1, y1]);
  const stack: Matrix[] = [];
  let ctm = IDENTITY;
  const images = new Set([ops.paintImageXObject, ops.paintImageMaskXObject, ops.paintInlineImageXObject]);
  for (let index = 0; index < fnArray.length && !grid.full; index += 1) {
    const fn = fnArray[index];
    const args = (argsArray[index] ?? []) as unknown[];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm;
    else if (fn === ops.transform) ctm = multiply(ctm, asMatrix(args) ?? IDENTITY);
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      ctm = multiply(ctm, asMatrix(args[0]) ?? IDENTITY);
    } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (images.has(fn)) grid.mark(ctm);
    else if (fn === ops.paintImageXObjectRepeat) {
      const [, scaleX, scaleY, positions] = args as [unknown, number, number, ArrayLike<number>];
      for (let at = 0; positions && at + 1 < positions.length && !grid.full; at += 2) {
        grid.mark(multiply(ctm, [scaleX, 0, 0, scaleY, positions[at], positions[at + 1]]));
      }
    }
  }
  return grid.covered / grid.cells.length;
}
