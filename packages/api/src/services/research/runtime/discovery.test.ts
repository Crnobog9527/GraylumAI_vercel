/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { candidateShortage, ROUND_UNFINISHED_NEXT_STEP } from './discovery';

describe('benchmark discovery candidate shortage', () => {
  it('a finished round without one selectable account names both ways out, profile links first after two rounds', () => {
    expect(candidateShortage()).toEqual({
      message: '这一轮已经搜完，没有找到可选的对标账号。',
      nextStep: '告诉用户两条出路：换一组关键词再搜一轮，或直接发来想对标的账号主页链接（按链接取数核对）。'
        + '搜过两轮仍找不到时，主要建议发链接，不要只让用户再搜。',
      availableCandidates: 0,
    });
  });

  it('an unfinished round is not a round: the user continues it, nothing paid is fetched again', () => {
    expect(ROUND_UNFINISHED_NEXT_STEP).toContain('不算一轮');
    expect(ROUND_UNFINISHED_NEXT_STEP).toContain('继续');
    expect(ROUND_UNFINISHED_NEXT_STEP).not.toMatch(/\d+\s*积分/);
  });
});
