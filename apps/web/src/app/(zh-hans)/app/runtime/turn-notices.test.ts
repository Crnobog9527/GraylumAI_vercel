/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { trimmedToolNotices, turnCodeNotice } from './turn-notices';

describe('turn notices', () => {
  it('gives the text back only for a code that proves nothing was stored', () => {
    expect(turnCodeNotice('TURN_INSUFFICIENT_CREDITS').kept).toBe(true);
    expect(turnCodeNotice('TURN_PROVIDER_402').kept).toBe(false);
    expect(turnCodeNotice('SOMETHING_NEW')).toMatchObject({ kept: false, text: expect.stringContaining('不要重复发送') });
  });
  it('names every trimmed tool, grouped by why (never a silent drop)', () => {
    expect(trimmedToolNotices({ available: ['read_source'], trimmed: [{ name: 'web_search', reason: 'capacity' },
      { name: 'web_fetch', reason: 'capacity' }, { name: 'social_search', reason: 'disabled' }] }))
      .toEqual(['本轮不能使用网页搜索、网页读取：本轮内容已接近输入上限。', '本轮不能使用社媒搜索：暂未开启。']);
    expect(trimmedToolNotices(undefined)).toEqual([]);
  });
});
