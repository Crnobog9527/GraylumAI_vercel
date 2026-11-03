/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { candidateShortage, ROUND_UNFINISHED_NEXT_STEP } from './discovery';

describe('benchmark discovery candidate shortage', () => {
  it('a finished round without one selectable account names both ways out, profile links first after two rounds', () => {
    expect(candidateShortage()).toEqual({
      message: '这一轮已经搜完，没有找到可选的对标账号。',
      nextStep: '告诉用户两条出路：换一组关键词再搜一轮，或直接发来想对标的账号主页链接（按链接取数核对，'
        + '核对合格的账号同样算对标）。搜过两轮仍找不到时，主要建议发链接，不要只让用户再搜。',
      availableCandidates: 0,
    });
  });

  it('an unfinished round is not a round: the user continues it, nothing paid is fetched again', () => {
    expect(ROUND_UNFINISHED_NEXT_STEP).toContain('不算一轮');
    expect(ROUND_UNFINISHED_NEXT_STEP).toContain('继续');
    expect(ROUND_UNFINISHED_NEXT_STEP).not.toMatch(/\d+\s*积分/);
  });
});

// Round 13 (staging): TikHub answered HTTP 402 to every Xiaohongshu call; the coach said "only one round" and suggested other keywords.
describe('a round the supplier could not serve', () => {
  it('is told apart from a round that searched to the end and found nothing', async () => {
    const { supplierDownRound, SUPPLIER_UNAVAILABLE_NEXT_STEP } = await import('./discovery');
    expect(supplierDownRound({ supplierDown: true, stopped: false, shown: false, found: 0 })).toBe(true);
    expect(supplierDownRound({ supplierDown: false, stopped: false, shown: false, found: 0 })).toBe(false); // searched, nothing found
    expect(supplierDownRound({ supplierDown: true, stopped: true, shown: false, found: 0 })).toBe(false);  // unfinished round
    expect(supplierDownRound({ supplierDown: true, stopped: false, shown: true, found: 3 })).toBe(false);  // part of it worked
    expect(SUPPLIER_UNAVAILABLE_NEXT_STEP).toContain('不是关键词的问题');
    expect(SUPPLIER_UNAVAILABLE_NEXT_STEP).toContain('不要建议换关键词');
  });
});
