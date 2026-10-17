/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Box } from './detect';

/**
 * Reading order for recognised boxes (LIB-2d): a recursive XY cut. A region is split at its widest
 * vertical gap (columns, left before right) when both sides look like text columns, otherwise at its
 * widest horizontal gap (top before bottom). Table cells are too narrow to count as columns, so tables
 * are read row by row. A region with no gap is read in rows, each row left to right.
 */

export type Item = { text: string; box: Box };

/** A column side must hold lines at least this share of the region width (table cells are narrower). */
const MIN_COLUMN_LINE_SHARE = 0.3;
const MIN_COLUMN_ITEMS = 2;

type Gap = { at: number; size: number };

/** Widest gap along x (vertical gutter) or y (horizontal space) that no box covers. */
function widestGap(items: Item[], axis: 'x' | 'y'): Gap | null {
  const spans = items.map(({ box }) => axis === 'x' ? [box.x, box.x + box.width] : [box.y, box.y + box.height])
    .sort((a, b) => a[0]! - b[0]!);
  let reach = spans[0]![1]!;
  let best: Gap | null = null;
  for (const [start, end] of spans.slice(1)) {
    if (start! > reach && (!best || start! - reach > best.size)) best = { at: (start! + reach) / 2, size: start! - reach };
    reach = Math.max(reach, end!);
  }
  return best;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

function looksLikeColumns(left: Item[], right: Item[], regionWidth: number): boolean {
  if (left.length < MIN_COLUMN_ITEMS || right.length < MIN_COLUMN_ITEMS) return false;
  const min = MIN_COLUMN_LINE_SHARE * regionWidth;
  return median(left.map((i) => i.box.width)) >= min && median(right.map((i) => i.box.width)) >= min;
}

/** Rows by vertical overlap (at least half the shorter box), rows top to bottom, boxes left to right. */
function rows(items: Item[]): string[] {
  const groups: Array<{ center: number; height: number; items: Item[] }> = [];
  for (const item of [...items].sort((a, b) => a.box.y - b.box.y)) {
    const center = item.box.y + item.box.height / 2;
    const row = groups.find((g) => Math.abs(g.center - center) < Math.min(g.height, item.box.height) * 0.5);
    if (row) row.items.push(item);
    else groups.push({ center, height: item.box.height, items: [item] });
  }
  return groups.sort((a, b) => a.center - b.center)
    .map((g) => g.items.sort((a, b) => a.box.x - b.box.x).map((i) => i.text).join(' '));
}

function cut(items: Item[]): string[] {
  if (items.length <= 1) return items.map((i) => i.text);
  const x0 = Math.min(...items.map((i) => i.box.x)), x1 = Math.max(...items.map((i) => i.box.x + i.box.width));
  const vertical = widestGap(items, 'x');
  if (vertical) {
    const left = items.filter((i) => i.box.x + i.box.width <= vertical.at);
    const right = items.filter((i) => i.box.x >= vertical.at);
    if (looksLikeColumns(left, right, x1 - x0)) return [...cut(left), ...cut(right)];
  }
  const horizontal = widestGap(items, 'y');
  if (!horizontal) return rows(items);
  return [...cut(items.filter((i) => i.box.y + i.box.height <= horizontal.at)),
    ...cut(items.filter((i) => i.box.y >= horizontal.at))];
}

/** Page text in reading order, one line per row. */
export function readingOrder(items: Item[]): string {
  return cut(items.filter((i) => i.text.trim() !== '')).join('\n');
}
