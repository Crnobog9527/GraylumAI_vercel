/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { shownSoFar } from './shownReply';

describe('the shown part of a cut-off reply, fit to save', () => {
  it('keeps what was shown, without trailing blanks', () => {
    expect(shownSoFar('第一段。\n\n第二段写到一半  \n')).toBe('第一段。\n\n第二段写到一半');
    expect(shownSoFar('Half an answer 😀')).toBe('Half an answer 😀');
  });
  it('drops the first half of an emoji the cut left at the end (never half a character)', () => {
    expect(shownSoFar('写到这里\ud83d')).toBe('写到这里');
    expect(shownSoFar('ok \ud83d').isWellFormed()).toBe(true);
  });
  it('is empty when nothing readable was shown', () => {
    expect(shownSoFar('')).toBe('');
    expect(shownSoFar(' \n\t')).toBe('');
    expect(shownSoFar('\ud83d')).toBe('');
  });
});
