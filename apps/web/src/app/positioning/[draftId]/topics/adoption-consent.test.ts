/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { consentedTopicIds } from './adoption-consent';

const ids = ['one', 'two', 'three'];
describe('natural-language topic adoption consent', () => {
  it('binds explicit ordinal and all instructions to the offered IDs', () => {
    expect(consentedTopicIds('采用第二条选题', ids)).toEqual(['two']);
    expect(consentedTopicIds('请采纳第 3 条内容。', ids)).toEqual(['three']);
    expect(consentedTopicIds('采用全部选题', ids)).toEqual(ids);
  });
  it('refuses questions, vague agreement, negation and out-of-range selection', () => {
    for (const message of ['不要采用第一条', '采用第一条吗？', '好，继续', '先看看第二条', '采用第四条', '别人说采用第一条']) {
      expect(consentedTopicIds(message, ids)).toBeNull();
    }
  });
});
