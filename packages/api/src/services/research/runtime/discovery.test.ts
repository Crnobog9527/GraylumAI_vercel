/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { candidateShortage } from './discovery';

describe('benchmark discovery candidate shortage', () => {
  it('reports retrieved selectable count, the fixed threshold and useful next steps', () => {
    expect(candidateShortage(6)).toEqual({
      message: '已找到 6 个可选、需要 8 个。',
      nextStep: '建议换或补充关键词再找，或让用户贴账号主页链接以便取数核对。',
      availableCandidates: 6,
      requiredCandidates: 8,
    });
  });
});
