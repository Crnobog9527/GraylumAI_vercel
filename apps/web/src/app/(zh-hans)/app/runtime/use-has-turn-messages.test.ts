/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import type { TurnView } from '@repo/api/src/services/turn/view';
import { probeTurnMessages } from './use-has-turn-messages';

const view = (messages: unknown[]) => ({ activeTurn: null, lastTurn: null, messages, calls: [] }) as unknown as TurnView;
const now = () => Promise.resolve();

describe('the probe for replies of the turn path', () => {
  it('a read that failed is not "no replies": it is read again until one answers', async () => {
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValue(view([{ seq: 1, role: 'assistant', turnId: 4, content: '好' }]));
    expect(await probeTurnMessages(read, now, () => true)).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('an empty answer is the only proof of no replies', async () => {
    expect(await probeTurnMessages(async () => view([]), now, () => true)).toBe(false);
  });
  it('stops reading when the page has moved on', async () => {
    let live = true;
    const read = vi.fn(async () => { live = false; return null; });
    expect(await probeTurnMessages(read, now, () => live)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
