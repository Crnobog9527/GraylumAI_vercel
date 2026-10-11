/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Share of a page covered by visible images, from a pdf.js operator list. Images are never decoded
 * (see scripts/library-sandbox-pdfjs.mjs): each is a unit square placed by the current transformation
 * matrix, cut to the current clipping area (clip paths and form bounding boxes, tracked as boxes and
 * saved/restored with the graphics state). The area is measured on a fixed grid over the page box,
 * so overlapping images count once. Because the patched pdf.js records every image (masks and inline
 * images included) as a plain `paintImageXObject`, the only grouped form the operator-list optimiser
 * can produce is `paintImageXObjectRepeat`.
 */

type Matrix = [number, number, number, number, number, number];
/** Axis-aligned box in page user space: [minX, minY, maxX, maxY]. */
type Box = [number, number, number, number];

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
  clip: number;
  eoClip: number;
  constructPath: number;
};

const GRID = 64;
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const EMPTY: Box = [0, 0, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    n[0] * m[0] + n[1] * m[2], n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2], n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4], n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

function numbers(value: unknown, length: number): number[] | null {
  if (!value || typeof value !== 'object' || !('length' in value) || (value as ArrayLike<unknown>).length !== length) return null;
  const list = Array.from(value as ArrayLike<unknown>);
  return list.every((item) => typeof item === 'number' && Number.isFinite(item)) ? (list as number[]) : null;
}

const asMatrix = (value: unknown) => numbers(value, 6) as Matrix | null;

/** Bounding box of the rectangle [x0, y0, x1, y1] (in the coordinates of `m`) in page space. */
function boxOf(m: Matrix, [x0, y0, x1, y1]: number[]): Box {
  const xs = [x0 * m[0] + y0 * m[2], x1 * m[0] + y0 * m[2], x0 * m[0] + y1 * m[2], x1 * m[0] + y1 * m[2]].map((x) => x + m[4]);
  const ys = [x0 * m[1] + y0 * m[3], x1 * m[1] + y0 * m[3], x0 * m[1] + y1 * m[3], x1 * m[1] + y1 * m[3]].map((y) => y + m[5]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function intersect(a: Box, b: Box): Box {
  const box: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[0] < box[2] && box[1] < box[3] ? box : EMPTY;
}

class Grid {
  readonly cells = new Uint8Array(GRID * GRID);
  covered = 0;
  constructor(private readonly view: Box) {}

  mark([left, bottom, right, top]: Box) {
    const [x0, y0, x1, y1] = this.view;
    const cell = (value: number, low: number, high: number) => ((value - low) / (high - low)) * GRID;
    const firstColumn = Math.max(0, Math.floor(cell(left, x0, x1)));
    const lastColumn = Math.min(GRID, Math.ceil(cell(right, x0, x1)));
    const firstRow = Math.max(0, Math.floor(cell(bottom, y0, y1)));
    const lastRow = Math.min(GRID, Math.ceil(cell(top, y0, y1)));
    for (let row = firstRow; row < lastRow; row += 1) {
      for (let column = firstColumn; column < lastColumn; column += 1) {
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

type State = { ctm: Matrix; clip: Box };

export function imageCoverage(fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, view: number[], ops: CoverageOps): number {
  const [x0, y0, x1, y1] = view;
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return 0;
  const page: Box = [x0, y0, x1, y1];
  const grid = new Grid(page);
  const stack: State[] = [];
  let state: State = { ctm: IDENTITY, clip: page };
  let pendingClip = false;
  const paint = (m: Matrix) => grid.mark(intersect(boxOf(m, [0, 0, 1, 1]), state.clip));
  const images = new Set([ops.paintImageXObject, ops.paintImageMaskXObject, ops.paintInlineImageXObject]);
  for (let index = 0; index < fnArray.length && !grid.full; index += 1) {
    const fn = fnArray[index];
    const args = (argsArray[index] ?? []) as unknown[];
    if (fn === ops.save) stack.push(state);
    else if (fn === ops.restore) state = stack.pop() ?? state;
    else if (fn === ops.transform) state = { ...state, ctm: multiply(state.ctm, asMatrix(args) ?? IDENTITY) };
    else if (fn === ops.clip || fn === ops.eoClip) pendingClip = true;
    else if (fn === ops.constructPath) {
      // pdf.js applies a pending clip when the path that follows `W`/`W*` is ended; its box is args[2].
      if (pendingClip) {
        const bounds = numbers(args[2], 4);
        state = { ...state, clip: bounds ? intersect(state.clip, boxOf(state.ctm, bounds)) : EMPTY };
      }
      pendingClip = false;
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(state);
      const ctm = multiply(state.ctm, asMatrix(args[0]) ?? IDENTITY);
      const bbox = numbers(args[1], 4);
      state = { ctm, clip: bbox ? intersect(state.clip, boxOf(ctm, bbox)) : state.clip };
    } else if (fn === ops.paintFormXObjectEnd) state = stack.pop() ?? state;
    else if (images.has(fn)) paint(state.ctm);
    else if (fn === ops.paintImageXObjectRepeat) {
      const [, scaleX, scaleY, positions] = args as [unknown, number, number, ArrayLike<number>];
      for (let at = 0; positions && at + 1 < positions.length && !grid.full; at += 2) {
        paint(multiply(state.ctm, [scaleX, 0, 0, scaleY, positions[at], positions[at + 1]]));
      }
    }
  }
  return grid.covered / grid.cells.length;
}
