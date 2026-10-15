/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { Scene, StageKey } from './jury-scenes';

/**
 * What each of the eight steps does and why, for the step list beside the canvas, and how long the real review
 * takes. Durations are measured on staging (2026-10-15): round 1 about 70 s, round 2 about 60 s, the summary about
 * 80 s. The replay runs at reading pace, so the time left is estimated from where the replay is inside each part.
 */
export const STEP_TEXT: Record<StageKey, { what: string; why: string }> = {
  seated: { what: '三位评审拿到同一份报告', why: '每人独立看，互不影响' },
  reading: { what: '各自通读全文', why: '先读完整份，意见才不片面' },
  steelman: { what: '先替 4 个关键决定说话', why: '讲出原选择最强的理由，再决定改不改' },
  critique: { what: '逐章挑出问题', why: '每条写清哪一章、为什么、怎么改' },
  divergence: { what: '对照三人的判断', why: '意见不一的地方才值得辩论' },
  debate: { what: '有分歧的评审互相回应', why: '先复述对方最强的理由，再表态' },
  ruling: { what: '汇总逐条裁决', why: '回到原文核实，决定写不写进修订稿' },
  revision: { what: '写出修订稿', why: '只改裁决采纳的地方，由你逐章决定用不用' },
};

type Part = 'round1' | 'round2' | 'summary';
export const PART_MS: Record<Part, number> = { round1: 70_000, round2: 60_000, summary: 80_000 };

const PART_OF: Record<StageKey, Part> = {
  seated: 'round1', reading: 'round1', steelman: 'round1', critique: 'round1',
  divergence: 'round2', debate: 'round2', ruling: 'summary', revision: 'summary',
};

/** Whether the review has a second round (someone disagreed). */
export const hasDebate = (scenes: readonly Scene[]) => scenes.some(scene => scene.stage === 'debate');

/** The whole review's length, in the words of the start card. */
export function totalText(scenes: readonly Scene[]): string {
  return hasDebate(scenes) ? '约 3–4 分钟' : '约 2–3 分钟';
}

/**
 * Real time left at a replay clock: the unplayed share of the current part, plus every later part. Without a second
 * round the comparison is instant, so that part costs nothing.
 */
export function remainingMs(scenes: readonly Scene[], clock: number): number {
  const parts: Part[] = hasDebate(scenes) ? ['round1', 'round2', 'summary'] : ['round1', 'summary'];
  let left = 0;
  for (const part of parts) {
    const own = scenes.filter(scene => PART_OF[scene.stage] === part);
    if (own.length === 0) continue;
    const start = own[0].start;
    const end = own[own.length - 1].end;
    const share = end > start ? Math.min(1, Math.max(0, (clock - start) / (end - start))) : clock >= end ? 1 : 0;
    left += PART_MS[part] * (1 - share);
  }
  return left;
}

/** "还剩约 2 分 30 秒", rounded up to ten seconds; the last few seconds read as almost done. */
export function remainingText(ms: number): string {
  if (ms < 10_000) return '马上就好';
  const seconds = Math.ceil(ms / 10_000) * 10;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `还剩约 ${rest} 秒`;
  return rest === 0 ? `还剩约 ${minutes} 分钟` : `还剩约 ${minutes} 分 ${rest} 秒`;
}
