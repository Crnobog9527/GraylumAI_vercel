/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * Sample J's price section, round three (Owner 2026-10-15). Prices and seat counts always come from the server; these
 * are the words around them.
 */

/**
 * The usual ways added up, shown under the four rows only when all four are on the page. Owner 2026-10-15: one figure,
 * "每月约 $3,637 起" — the lowest consultant fee, the scheduler, the benchmark tool and the set-up project
 * ($2,000 + $45 + $82 + $1,510); no range, no separate one-off line.
 */
export const J_PRICE_TOTAL = {
  label: '正常方案合计',
  text: '每月约 $3,637 起',
  rows: ['consultant', 'project', 'scheduler', 'benchmark'],
} as const;
