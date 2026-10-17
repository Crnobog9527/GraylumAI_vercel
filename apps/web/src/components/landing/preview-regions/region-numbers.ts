/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Region numbers for the style samples (Owner 2026-10-16): every module on a /landing/preview page carries a label,
 * "区域 3 · 对比区", so the Owner can point at one by number; obvious sub-blocks inside a module (a row of cards)
 * carry "3-1", "3-2". Two levels only. The numbers come from the order the modules render in, never from the
 * components: a module marks itself with data-region="简称" and nothing else.
 */
export type RegionItem = { name: string; level: 1 | 2 };
export type NumberedRegion = { number: string; label: string; level: 1 | 2 };

/** Numbers regions given in document order; a sub-block before any module has nothing to belong to (null). */
export function numberRegions(items: readonly RegionItem[]): (NumberedRegion | null)[] {
  let top = 0;
  let sub = 0;
  return items.map(item => {
    if (item.level === 1) {
      top += 1;
      sub = 0;
      return { number: String(top), label: `区域 ${top} · ${item.name}`, level: 1 };
    }
    if (top === 0) return null;
    sub += 1;
    const number = `${top}-${sub}`;
    return { number, label: `${number} · ${item.name}`, level: 2 };
  });
}

/** A module without a data-region name (the older samples) is named after its heading, cut short. */
export function shortName(text: string, max = 10): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '模块';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export type Box = { left: number; top: number; width: number; height: number };
type Offset = { dx: number; dy: number };

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

/**
 * Where a label goes on its region (offsets from the region's top-left corner): the first spot that covers no text
 * and no other label. A module tries inside its corner, its top edge, just above it, the margin to its left and its
 * top-right corner; a sub-block tries its top edge, just above it, the margin to its left, then inside its corners.
 * With no clear spot it takes the first one.
 */
export function pickSpot(region: Box, label: { width: number; height: number }, level: 1 | 2, taken: readonly Box[]): Offset {
  const { width: w, height: h } = label;
  const corner = { dx: 8, dy: 8 };
  const edge = { dx: 8, dy: -h / 2 };
  const above = { dx: 8, dy: -h - 4 };
  const margin = { dx: -w - 6, dy: 0 };
  const right = { dx: region.width - w - 8, dy: 8 };
  const spots = level === 1 ? [corner, edge, above, margin, right] : [edge, above, margin, corner, right];
  const clear = spots.find(({ dx, dy }) => {
    const box = { left: region.left + dx, top: region.top + dy, width: w, height: h };
    return box.left >= 0 && !taken.some(other => overlaps(box, other));
  });
  return clear ?? spots[0];
}
