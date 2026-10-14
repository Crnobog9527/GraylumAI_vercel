/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SceneLine } from '@/components/landing/preview-g/scenes';

/**
 * When each message of a scene plays, in milliseconds from the moment the scene starts. Your messages pop in after
 * a short pause; the coach shows "typing" dots first, then types its reply character by character (faster for
 * long replies, so no reply takes much more than a second and a half), and a card in the reply rises in after the
 * text. Pure numbers: the component turns them into CSS animation delays, so nothing re-renders while it plays.
 */
export type LineTiming = { appear: number; typeStart: number; perChar: number; cardAt: number | null };

const USER_PAUSE = 380;
const USER_HOLD = 520;
const COACH_PAUSE = 260;
const DOTS = 640;
const TYPE_BUDGET = 1500;
const CARD_DELAY = 120;
const CARD_HOLD = 760;
const COACH_HOLD = 280;

export function charDelay(length: number) {
  if (length <= 0) return 0;
  return Math.round(Math.min(26, Math.max(8, TYPE_BUDGET / length)));
}

export function sceneTimeline(lines: readonly SceneLine[]) {
  let cursor = 0;
  const timings: LineTiming[] = lines.map(line => {
    if (line.role === 'user') {
      const appear = cursor + USER_PAUSE;
      cursor = appear + USER_HOLD;
      return { appear, typeStart: appear, perChar: 0, cardAt: null };
    }
    const appear = cursor + COACH_PAUSE;
    const typeStart = appear + DOTS;
    const length = Array.from(line.text).length;
    const perChar = charDelay(length);
    const typeEnd = typeStart + length * perChar;
    const cardAt = line.card ? typeEnd + CARD_DELAY : null;
    cursor = cardAt !== null ? cardAt + CARD_HOLD : typeEnd + COACH_HOLD;
    return { appear, typeStart, perChar, cardAt };
  });
  return { timings, total: cursor };
}
