/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFeature } from './landing-flags';
import { J_WORK_CARE } from './landing-copy-j-work-care';
import { J_WORK_MAKE } from './landing-copy-j-work-make';

/**
 * Sample J's merged module (Owner 2026-10-15, round two: "展示的深度你要做够"): "这些事，不用你再操心" (five) and
 * "定位之后，AI 教练接着陪你做内容" (library, voice, publishing). Each demo is three to five steps; each step is one screen
 * of the real product with the coach's judgment in it (the basis, the trade-off, the risk) and how it moves you on,
 * and its own line on the right saying what this step is worth. The page's one example person (J_PERSONA). No figures
 * beyond that person's own situation, no promise of income. NEW WORDING for the Owner to approve, except where marked.
 */

/** One piece of a step's screen. Every kind is drawn from the product's own parts (WorkScreensJ). */
export type WorkBlock =
  | { kind: 'user'; text: string }
  | { kind: 'coach'; text: string }
  | { kind: 'checks'; title?: string; items: readonly string[] }
  | { kind: 'options'; items: readonly { title: string; note: string; tag: '留下' | '淘汰' | '推荐' | '' }[] }
  | { kind: 'table'; title?: string; columns: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: 'rows'; title?: string; rows: readonly (readonly [string, string])[] }
  | { kind: 'trend'; label: string }
  | { kind: 'compare'; left: { label: string; lines: readonly string[] }; right: { label: string; lines: readonly string[] } }
  | { kind: 'note'; text: string }
  | { kind: 'library'; fresh: boolean }
  | { kind: 'upload'; done: boolean }
  | { kind: 'publish'; sent: boolean };

export type WorkStep = { label: string; explain: string; blocks: readonly WorkBlock[] };
export type WorkId = 'topics' | 'method' | 'data' | 'money' | 'models' | 'library' | 'voice' | 'publish';
export type WorkScene = {
  id: WorkId; group: 0 | 1; title: string; result: string; needs: readonly LandingFeature[]; steps: readonly WorkStep[];
};

export const J_WORK = {
  /** OWNER (the 3c title, moved here) and FINAL (the scenes' title, with "它" named, Owner 2026-10-15). */
  groups: ['这些事，不用你再操心', '定位之后，AI 教练接着陪你做内容'],
  /** From the final copy (HOW_IT_WORKS.promise's last line), with "它" named (Owner 2026-10-15). */
  close: '拍摄、出镜、录音这些要你本人来，其余交给我们的 AI 教练。',
  lede: '下面是示例：人物和内容为虚构，界面是真实产品的界面。',
  rightLabel: '这一步在做什么',
  resultLabel: '用了之后',
  next: '下一个',
} as const;

export const J_WORK_SCENES: readonly WorkScene[] = [...J_WORK_CARE, ...J_WORK_MAKE];
