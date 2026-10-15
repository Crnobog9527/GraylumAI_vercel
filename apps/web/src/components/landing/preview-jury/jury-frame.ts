/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** A vertical span on the board, in board pixels. */
export type Span = { top: number; bottom: number };

/**
 * Where the canvas should scroll to: `want` (the first position that shows the current card), moved so no report
 * sheet stops cut across the top edge. A cut sheet is shown whole with its title if the current card still fits below
 * it, else scrolled fully out of view; if neither works, `want` stands.
 */
export function frameTop({ want, height, max, target, sheets }: {
  want: number; height: number; max: number; target: Span; sheets: readonly Span[];
}): number {
  for (const sheet of sheets) {
    if (want <= sheet.top + 4 || want >= sheet.bottom - 4) continue;
    const up = Math.max(0, sheet.top - 12);
    if (target.bottom <= up + height - 8) return up;
    const down = sheet.bottom + 12;
    if (down <= max && target.top >= down + 8 && target.bottom <= down + height) return down;
  }
  return want;
}
