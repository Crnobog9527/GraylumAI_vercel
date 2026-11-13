/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { PHOTO_MARK, photosOfTurns } from './chat-photos';

describe('chat photos on the page', () => {
  it('groups the photos by turn, in the order they were sent', () => {
    const byTurn = photosOfTurns([{ turnId: 9, index: 1, src: 'b' }, { turnId: 7, index: 0, src: 'x' }, { turnId: 9, index: 0, src: 'a' }]);
    expect(byTurn.get(9)).toEqual(['a', 'b']);
    expect(byTurn.get(7)).toEqual(['x']);
    expect(byTurn.get(8)).toBeUndefined();
  });

  it('the mark is the server\'s imageMark, so a message with images is recognised', () => {
    expect('[截图] 看看'.startsWith(PHOTO_MARK)).toBe(true);
    expect('[截图×3] 看看'.startsWith(PHOTO_MARK)).toBe(true);
    expect('截图里的数字'.startsWith(PHOTO_MARK)).toBe(false);
  });
});
