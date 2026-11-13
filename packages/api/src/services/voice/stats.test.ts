/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { computeVoiceStats } from './stats';

describe('computeVoiceStats (VOICE-2 PR-1, by code, no model call)', () => {
  it('measures sentences, openings, punctuation and paragraphs', () => {
    const stats = computeVoiceStats([
      '你下班到家几点了？我七点。一口锅搞定！\n\n1. 先切菜\n2. 再下锅',
      '我觉得这道菜真的很适合每天都很忙但是又想自己做饭吃的上班族朋友们……😀',
    ]);
    expect(stats.documents).toBe(2);
    expect(stats.sentences).toBe(6);
    expect(stats.shortSentenceShare).toBe(83);
    expect(stats.longSentenceShare).toBe(17);
    expect(stats.openings).toEqual({ question: 25, number: 50, firstPerson: 25 });
    expect(stats.listShare).toBe(50);
    expect(stats.avgParagraphsPerDocument).toBe(2);
    expect(stats.perThousandChars.emoji).toBeGreaterThan(0);
    expect(stats.perThousandChars.ellipsis).toBeGreaterThan(0);
  });
  it('is all zeros for no text (never NaN)', () => {
    const stats = computeVoiceStats(['', '  ']);
    expect(stats).toMatchObject({ documents: 0, sentences: 0, avgSentenceChars: 0, avgParagraphChars: 0, listShare: 0 });
    expect(JSON.stringify(stats)).not.toContain('null');
  });
});
