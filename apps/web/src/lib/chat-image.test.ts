/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { chatImageLayout } from './chat-image';

describe('a chat screenshot layout', () => {
  it('fits 2048 px on the longer side, keeps the aspect and never enlarges the picture', () => {
    expect(chatImageLayout(4000, 3000)).toMatchObject({ canvasWidth: 2048, canvasHeight: 1536, drawWidth: 2048, drawHeight: 1536, x: 0, y: 0 });
    expect(chatImageLayout(800, 600)).toMatchObject({ canvasWidth: 800, canvasHeight: 600, drawWidth: 800, drawHeight: 600 });
    expect(chatImageLayout(1170, 2532)).toMatchObject({ canvasWidth: 946, canvasHeight: 2048 });
  });

  it('pads a long screenshot with white to 4:1 and a tiny one to 64 px, the picture centred', () => {
    // A phone full-page screenshot 1170 x 6000: scaled to 399 x 2048, widened to 512 (2048 / 4).
    expect(chatImageLayout(1170, 6000)).toEqual({ canvasWidth: 512, canvasHeight: 2048, drawWidth: 399, drawHeight: 2048, x: 56, y: 0 });
    expect(chatImageLayout(3000, 100)).toMatchObject({ canvasWidth: 2048, canvasHeight: 512, drawHeight: 68 });
    expect(chatImageLayout(1, 1)).toEqual({ canvasWidth: 64, canvasHeight: 64, drawWidth: 1, drawHeight: 1, x: 31, y: 31 });
  });

  it('always meets the server rules: 64 px short side, 2048 px long side, at most 4:1', () => {
    for (const [w, h] of [[1, 9000], [9000, 1], [50, 50], [2048, 2048], [700, 2800], [10_000, 2_600]] as const) {
      const { canvasWidth: cw, canvasHeight: ch } = chatImageLayout(w, h);
      expect(Math.min(cw, ch)).toBeGreaterThanOrEqual(64);
      expect(Math.max(cw, ch)).toBeLessThanOrEqual(2048);
      expect(Math.max(cw, ch)).toBeLessThanOrEqual(4 * Math.min(cw, ch));
    }
  });
});
