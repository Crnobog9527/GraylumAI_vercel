/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { mapBounded } from './mapBounded';

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('mapBounded', () => {
  it('keeps the order of the items, whatever order the tasks finish in', async () => {
    const result = await mapBounded([30, 5, 15, 1], 4, async (ms, index) => { await tick(ms); return `${index}:${ms}`; });
    expect(result).toEqual(['0:30', '1:5', '2:15', '3:1']);
  });

  it('never runs more than the limit at once, and runs every item', async () => {
    let running = 0, peak = 0;
    const seen: number[] = [];
    await mapBounded([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      running += 1; peak = Math.max(peak, running);
      await tick(5);
      seen.push(item); running -= 1;
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('answers an empty list without running anything, and treats a limit below one as one', async () => {
    await expect(mapBounded([], 3, async () => { throw new Error('never'); })).resolves.toEqual([]);
    let running = 0, peak = 0;
    await mapBounded([1, 2, 3], 0, async () => { running += 1; peak = Math.max(peak, running); await tick(1); running -= 1; });
    expect(peak).toBe(1);
  });

  it('rejects with the first failure and starts no further item', async () => {
    const started: number[] = [];
    await expect(mapBounded([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item);
      await tick(item === 1 ? 1 : 20);
      if (item === 1) throw new Error('first');
      return item;
    })).rejects.toThrow('first');
    await tick(60);
    // Items 1 and 2 were running; nothing after them was started.
    expect(started).toEqual([1, 2]);
  });
});
