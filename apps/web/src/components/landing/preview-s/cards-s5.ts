/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * A card on S5's board. x is from the page's centre (px; kept on screen at narrower widths), y is from the top of the
 * screen (% of its height), r the tilt, depth 0 (far) to 2 (near). Photos are the Owner's AI-generated stills (local
 * preview only, marked 示意); notes are in the creator's hand.
 */
export type CardS5 = {
  kind: 'photo' | 'note' | 'scrap'; x: number; y: number; r: number; w: number; h: number; depth: 0 | 1 | 2;
  colour?: string; photo?: string; text?: string; big?: boolean;
  /** In the narrow margin beside a product window: shown only where that margin is wide enough to read it. */
  edge?: boolean;
};

/**
 * A batch belongs to one part of the page, in the reader's place `--s-t` (0 first screen, 1 step one — held through its
 * whole scroll track —, 2 the jury, 3 the footer): it floats in from below between `from` and `settle`, stays put, and
 * is carried up and away between `settle` and `to`.
 */
export type BatchS5 = { name: string; from: number; settle: number; to: number; cards: CardS5[] };

const PAPER = { tomato: '#ff6b4a', butter: '#ffd84d', sky: '#8ec5ff', mint: '#8fddb5' } as const;

export const BATCHES_S5: BatchS5[] = [
  {
    name: '过渡', from: 0.08, settle: 0.4, to: 0.7,
    cards: [
      { kind: 'photo', photo: '/landing-s/s-5.webp', text: '下班路上 · 示意', x: 430, y: 30, r: 6, w: 190, h: 224, depth: 2 },
      { kind: 'note', colour: PAPER.butter, text: '每晚 1 小时', x: 560, y: 66, r: -5, w: 160, h: 140, depth: 1 },
      { kind: 'scrap', colour: PAPER.sky, x: -700, y: 72, r: 7, w: 150, h: 56, depth: 0, edge: true },
      { kind: 'scrap', colour: PAPER.tomato, x: -720, y: 38, r: -8, w: 130, h: 50, depth: 0, edge: true },
    ],
  },
  {
    // Step one's window fills the screen while it plays: the notes sit in the empty right half of its title row, the
    // photos at the two edges, tucked at most 16px behind the window so their captions stay readable (wide screens).
    name: '第一步', from: 0.72, settle: 1, to: 1.5,
    cards: [
      { kind: 'note', colour: PAPER.butter, text: '这条开头先给成品！', x: 90, y: 12, r: -4, w: 226, h: 92, depth: 2 },
      { kind: 'scrap', colour: PAPER.mint, text: '收藏率 5.7%', x: 340, y: 13, r: 5, w: 176, h: 70, depth: 1 },
      { kind: 'photo', photo: '/landing-s/s-7.webp', text: '录一盘家常菜 · 示意', x: 572, y: 42, r: 5, w: 132, h: 160, depth: 1, edge: true },
      { kind: 'photo', photo: '/landing-s/s-6.webp', text: '选题便签 · 示意', x: -704, y: 58, r: -4, w: 132, h: 160, depth: 0, edge: true },
    ],
  },
  {
    // The jury's panel fills the screen too: short words at the edges, readable in the ~130px beside it.
    name: '评审团', from: 1.5, settle: 2, to: 2.75,
    cards: [
      { kind: 'note', colour: PAPER.butter, text: '改前', x: -710, y: 16, r: -6, w: 138, h: 116, depth: 2, big: true, edge: true },
      { kind: 'note', colour: PAPER.mint, text: '改后', x: 572, y: 22, r: 5, w: 138, h: 116, depth: 1, big: true, edge: true },
      { kind: 'photo', photo: '/landing-s/s-3.webp', text: '出租屋一角 · 示意', x: -704, y: 56, r: 4, w: 132, h: 160, depth: 0, edge: true },
      { kind: 'scrap', colour: PAPER.tomato, x: 572, y: 66, r: -7, w: 130, h: 50, depth: 1, edge: true },
    ],
  },
];

/** How far each depth travels as a batch comes and goes (near cards move more), and how large it reads. */
export const DEPTH_S5 = [
  { travel: 0.75, scale: 0.92, shadow: 0.7 },
  { travel: 1, scale: 1, shadow: 1 },
  { travel: 1.3, scale: 1.06, shadow: 1.35 },
] as const;

/**
 * Where a batch's cards are at the reader's place t: `lift` is the share of the screen's height they sit below (+)
 * or above (−) their resting place, `fade` their opacity, `turn` extra tilt in degrees. Coming in decelerates (they
 * settle like paper landing on a table); leaving accelerates. Reversible: it depends on t alone.
 */
export function batchPose(batch: BatchS5, t: number, depth = 1): { lift: number; fade: number; turn: number } {
  // Layers do not move as one sheet: far cards set off first and land first, near ones land last.
  const from = batch.from + 0.04 * depth;
  const settle = batch.settle - 0.06 * (2 - depth);
  if (t <= from || t >= batch.to) return { lift: t <= from ? 0.8 : -1.1, fade: 0, turn: 0 };
  if (t <= settle) {
    const share = (t - from) / (settle - from);
    const eased = 1 - (1 - share) ** 3;
    return { lift: (1 - eased) * 0.8, fade: Math.min(1, share * 2.5), turn: (1 - eased) * 4 };
  }
  const share = (t - settle) / (batch.to - settle);
  return { lift: -(share ** 2) * 1.1, fade: share < 0.6 ? 1 : Math.max(0, 1 - (share - 0.6) / 0.4), turn: -(share ** 2) * 3 };
}
