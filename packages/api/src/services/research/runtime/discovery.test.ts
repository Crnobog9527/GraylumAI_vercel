/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { candidateShortage, ROUND_UNFINISHED_NEXT_STEP } from './discovery';

describe('benchmark discovery candidate shortage', () => {
  it('a finished round below the card minimum names both ways out, profile links first after two rounds', () => {
    expect(candidateShortage(6)).toEqual({
      message: '这一轮已经搜完：找到 6 个可选、需要 8 个才能出候选卡。',
      nextStep: '告诉用户两条出路：换一组关键词再搜一轮，或直接发来想对标的账号主页链接（按链接取数核对，'
        + '核对合格的账号同样算对标）。搜过两轮仍不够时，主要建议发链接，不要只让用户再搜。',
      availableCandidates: 6,
      requiredCandidates: 8,
    });
  });

  it('an unfinished round is not a round: the user continues it, nothing paid is fetched again', () => {
    expect(ROUND_UNFINISHED_NEXT_STEP).toContain('不算一轮');
    expect(ROUND_UNFINISHED_NEXT_STEP).toContain('继续');
    expect(ROUND_UNFINISHED_NEXT_STEP).not.toMatch(/\d+\s*积分/);
  });
});
