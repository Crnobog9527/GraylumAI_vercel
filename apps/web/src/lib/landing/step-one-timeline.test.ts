/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { linePhases, momentAt, momentMs, ONE_MS, stagesAt } from './step-one-timeline';
import { COACH_CPS, typedCount, typingMs, USER_CPS } from './typing';

describe('live typing', () => {
  it('writes about 35 characters a second, never going back, and is whole by typingMs', () => {
    let last = 0;
    for (let ms = 0; ms <= 4000; ms += 16) {
      const count = typedCount(ms, 1000);
      expect(count).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(typedCount(10_000, 10_000)).toBeGreaterThan(COACH_CPS * 10 * 0.9);
    expect(typedCount(10_000, 10_000)).toBeLessThan(COACH_CPS * 10 * 1.1);
    for (const length of [1, 48, 291, 900]) expect(typedCount(typingMs(length), length)).toBe(length);
    expect(typedCount(typingMs(120, USER_CPS), 120, USER_CPS)).toBe(120);
  });
});

describe('step one timeline', () => {
  const lines = [
    { role: 'coach' as const, text: '你好'.repeat(20), card: 'goal' },
    { role: 'user' as const, text: '副业收入吧' },
    { role: 'coach' as const, text: '好', card: 'fetch' },
  ];
  it('types the person\'s message in the box, then sends it; the coach thinks, writes, brings its card, then holds', () => {
    expect(linePhases(lines[1]).map(([phase]) => phase)).toEqual(['compose', 'send']);
    expect(linePhases(lines[2]).map(([phase]) => phase)).toEqual(['think', 'stream', 'card', 'hold']);
    expect(linePhases(lines[2])[2][1]).toBe(ONE_MS.fetch);
    expect(momentAt(lines, 0)).toMatchObject({ index: 0, phase: 'think' });
    const [[, think], [, stream]] = linePhases(lines[0]);
    const mid = momentAt(lines, think + stream / 2);
    expect(mid.phase).toBe('stream');
    expect(mid.chars).toBeGreaterThan(0);
    expect(mid.chars).toBeLessThan(lines[0].text.length);
    expect(momentAt(lines, momentMs(lines) - 1).phase).toBe('end');
    expect(momentAt(lines, momentMs(lines) + 999)).toMatchObject({ index: 3, phase: 'end', share: 1 });
  });
  it('finds the stage at a point of the whole clock', () => {
    expect(stagesAt([1000, 2000, 500], 0)).toEqual({ index: 0, ms: 0 });
    expect(stagesAt([1000, 2000, 500], 1500)).toEqual({ index: 1, ms: 500 });
    expect(stagesAt([1000, 2000, 500], 99_999)).toEqual({ index: 2, ms: 500 });
  });
});
