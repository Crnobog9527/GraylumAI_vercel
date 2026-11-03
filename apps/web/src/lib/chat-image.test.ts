/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { CHAT_IMAGE_MAX_EDGE, fitEdge } from './chat-image';

describe('a chat screenshot size', () => {
  it('fits 2048 px on the longer side, keeps the aspect and never enlarges', () => {
    expect(fitEdge(1170, 2532)).toEqual({ width: 946, height: CHAT_IMAGE_MAX_EDGE });
    expect(fitEdge(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(fitEdge(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitEdge(5000, 1, 2048)).toEqual({ width: 2048, height: 1 });
  });
});
