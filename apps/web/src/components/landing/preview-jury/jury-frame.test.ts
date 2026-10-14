/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { frameTop } from './jury-frame';

const sheet = { top: 20, bottom: 200 };

describe('frameTop', () => {
  it('keeps a position that cuts no sheet', () => {
    expect(frameTop({ want: 260, height: 600, max: 900, target: { top: 700, bottom: 800 }, sheets: [sheet] })).toBe(260);
    expect(frameTop({ want: 0, height: 600, max: 900, target: { top: 300, bottom: 400 }, sheets: [sheet] })).toBe(0);
  });

  it('shows the whole sheet when the current card still fits under it', () => {
    expect(frameTop({ want: 90, height: 600, max: 900, target: { top: 450, bottom: 560 }, sheets: [sheet] })).toBe(8);
  });

  it('moves the sheet fully out when the card would not fit', () => {
    expect(frameTop({ want: 150, height: 600, max: 900, target: { top: 600, bottom: 700 }, sheets: [sheet] })).toBe(212);
  });

  it('leaves the position alone when neither works', () => {
    expect(frameTop({ want: 150, height: 600, max: 180, target: { top: 600, bottom: 700 }, sheets: [sheet] })).toBe(150);
  });
});
