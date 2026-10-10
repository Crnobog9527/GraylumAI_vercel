/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { characterAccuracy, headingOrder, indelDistance, normalize } from './metrics';

describe('quality metrics', () => {
  it('folds whitespace and counts code points', () => {
    expect(normalize(' a\n\tb  c ')).toBe('a b c');
    expect(indelDistance('𠀋a', '𠀋a')).toBe(0);
    expect(indelDistance('abc', 'abd')).toBe(2);
    expect(indelDistance('', 'abc')).toBe(3);
    expect(characterAccuracy('中文 内容', '中文\n内容')).toMatchObject({ errors: 0, accuracy: 1 });
    expect(characterAccuracy('abcdefghi', 'abcdefghij').accuracy).toBeCloseTo(0.9);
  });

  it('scores heading order by longest common subsequence', () => {
    const gold = [{ level: 1, text: 'A' }, { level: 2, text: 'B' }, { level: 2, text: 'C' }];
    expect(headingOrder(gold, gold)).toEqual({ matched: 3, total: 3 });
    expect(headingOrder([gold[2], gold[0], gold[1]], gold)).toEqual({ matched: 2, total: 3 });
    expect(headingOrder([{ level: 1, text: 'B' }], gold)).toEqual({ matched: 0, total: 3 });
  });
});
