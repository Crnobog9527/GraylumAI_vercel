/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { typedCount, typingMs } from './typing';

/**
 * The clock of one landing-page module (Owner 2026-11-11: "把每一块步骤……拆开……每个模块做成自动循环播放的动画。中间的
 * 过程可以加速甚至简略一点"): a short list of named cues played one after another, then held, then played again. A
 * picture is a pure function of where the clock is, so it can be paused, looped and shown finished (`ms` null: server
 * HTML, reduced motion).
 */
export type Cue = {
  /** The clock has reached this cue. */
  on: boolean;
  /** The clock is past it. */
  done: boolean;
  /** Milliseconds into it, never more than its length. */
  ms: number;
  /** How far through it, 0 → 1. */
  share: number;
};

/** How long the finished picture stays before the loop starts again (milliseconds). */
export const LOOP_HOLD_MS = 2600;
/** Typing in a module: several times the live demo's pace, so a whole exchange fits in a few seconds. */
export const LOOP_COACH_CPS = 110;
export const LOOP_USER_CPS = 45;

export type CueList<K extends string> = readonly (readonly [K, number])[];

/** How long typing `text` takes in a module (milliseconds). */
export const typeMs = (text: string, cps = LOOP_COACH_CPS) => typingMs(text.length, cps);

/** The whole loop: every cue, then the hold. */
export function loopMs(cues: CueList<string>) {
  return cues.reduce((sum, [, length]) => sum + length, 0) + LOOP_HOLD_MS;
}

/** Where every cue is, `ms` into the loop; `null` is the finished picture. */
export function cuesAt<K extends string>(cues: CueList<K>, ms: number | null): Record<K, Cue> {
  let from = 0;
  const at = {} as Record<K, Cue>;
  for (const [name, length] of cues) {
    const into = ms === null ? length : Math.min(length, Math.max(0, ms - from));
    const done = ms === null || ms >= from + length;
    at[name] = { on: ms === null || ms >= from, done, ms: into, share: done || !length ? 1 : into / length };
    from += length;
  }
  return at;
}

/** `text` as far as a typing cue has written it. */
export function typedAt(text: string, cue: Cue, cps = LOOP_COACH_CPS) {
  if (cue.done) return text;
  return cue.on ? text.slice(0, typedCount(cue.ms, text.length, cps)) : '';
}

/** How many of `count` things, arriving evenly through a cue, are there. */
export function arrivedAt(count: number, cue: Cue) {
  if (cue.done) return count;
  return cue.on ? Math.min(count, Math.floor(cue.share * count) + 1) : 0;
}

export type LoopState = 'playing' | 'paused' | 'still';

/**
 * Whether a module's clock runs: only while the module is on screen and the tab is showing ("playing"), otherwise it
 * waits where it is ("paused"); under reduced motion it never runs and the finished picture shows ("still").
 */
export function loopState({ seen, tabShowing, reducedMotion }: { seen: boolean; tabShowing: boolean; reducedMotion: boolean }): LoopState {
  if (reducedMotion) return 'still';
  return seen && tabShowing ? 'playing' : 'paused';
}
