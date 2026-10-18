/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { COACH_CPS, typedCount, typingMs, USER_CPS } from './typing';

/**
 * Sample L's step one as a clock (round seven, T2 + T8): it plays by itself, in time, like the product being used. Each
 * of the person's messages is first typed into the message box, then sent; each of the coach's is typed out in the
 * conversation, then a card it brings (the fetch record, the benchmark table) arrives, then it is read for a moment.
 * A stage ends with its confirm area; the last stage is the report being written. A message that answers the coach's
 * question card (`pick`, the option's index; round eleven, X1) is not typed: the option is picked on the card, then sent.
 */
export type TimedLine = { role: 'coach' | 'user' | 'summary'; text: string; card?: string; pick?: number };
export type LinePhase = 'compose' | 'pick' | 'send' | 'think' | 'stream' | 'card' | 'hold';
export type MomentAt = {
  /** Lines whole before the current one. */
  index: number;
  /** The current line's phase; `end` once every line is whole (the stage's confirm area). */
  phase: LinePhase | 'end';
  /** Characters of the current line written (compose: in the message box; stream: in the conversation). */
  chars: number;
  /** Milliseconds into the current phase, and how far through it (0 → 1). */
  ms: number;
  share: number;
};

export const ONE_MS = { pick: 1800, send: 350, think: 500, fetch: 2400, card: 900, holdMin: 1200, holdMax: 3000, holdPerChar: 6, end: 2400, report: 11000 };

const cardMs = (card?: string) => (card === 'fetch' ? ONE_MS.fetch : card === 'table' ? ONE_MS.card : 0);

/** The phases of one line and how long each takes. */
export function linePhases(line: TimedLine): [LinePhase, number][] {
  if (line.role === 'user' && line.pick !== undefined) return [['pick', ONE_MS.pick], ['send', ONE_MS.send]];
  if (line.role === 'user') return [['compose', typingMs(line.text.length, USER_CPS)], ['send', ONE_MS.send]];
  const hold = Math.min(ONE_MS.holdMax, Math.max(ONE_MS.holdMin, line.text.length * ONE_MS.holdPerChar));
  return [['think', ONE_MS.think], ['stream', typingMs(line.text.length, COACH_CPS)], ['card', cardMs(line.card)], ['hold', hold]];
}

export function momentMs(lines: readonly TimedLine[]) {
  return lines.reduce((sum, line) => sum + linePhases(line).reduce((total, [, ms]) => total + ms, 0), 0) + ONE_MS.end;
}

/** Where a stage of `lines` is, `ms` into it. */
export function momentAt(lines: readonly TimedLine[], ms: number): MomentAt {
  let left = Math.max(0, ms);
  for (const [index, line] of lines.entries()) {
    for (const [phase, length] of linePhases(line)) {
      if (left < length) {
        const share = length ? left / length : 1;
        const chars = phase === 'compose' ? typedCount(left, line.text.length, USER_CPS)
          : phase === 'stream' ? typedCount(left, line.text.length, COACH_CPS) : line.text.length;
        return { index, phase, chars, ms: left, share };
      }
      left -= length;
    }
  }
  return { index: lines.length, phase: 'end', chars: 0, ms: left, share: Math.min(1, left / ONE_MS.end) };
}

/** The stages' lengths (the report stage fixed), and where the clock is among them. */
export function stagesAt(durations: readonly number[], ms: number) {
  let from = 0;
  for (const [index, length] of durations.entries()) {
    if (ms < from + length || index === durations.length - 1) return { index, ms: Math.min(length, Math.max(0, ms - from)) };
    from += length;
  }
  return { index: 0, ms: 0 };
}
