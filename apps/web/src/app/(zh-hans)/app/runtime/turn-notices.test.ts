/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { trimmedToolNotices, turnCodeNotice } from './turn-notices';

describe('turn notices', () => {
  it('gives the text back only for a code that proves nothing was stored', () => {
    expect(turnCodeNotice('TURN_INSUFFICIENT_CREDITS').kept).toBe(true);
    // A refused credit freeze (an account whose credit sources cannot be told apart) says so and keeps the text: nothing was charged.
    expect(turnCodeNotice('TURN_CREDIT_ACCOUNT_REVIEW')).toMatchObject({ kept: true, text: expect.stringContaining('没有扣费') });
    expect(turnCodeNotice('TURN_PROVIDER_402').kept).toBe(false);
    expect(turnCodeNotice('SOMETHING_NEW')).toMatchObject({ kept: false, text: expect.stringContaining('不要重复发送') });
    // The platform's daily stop-loss refuses before a turn opens: said plainly, nothing charged, the words kept.
    expect(turnCodeNotice('STOP_LOSS_REACHED')).toMatchObject({ kept: true, text: expect.stringContaining('没有扣费') });
    // The code is shown, so the next report of a failure says which one it was.
    expect(turnCodeNotice('SOMETHING_NEW').text).toContain('代码 SOMETHING_NEW');
  });
  it('names every trimmed tool, grouped by why (never a silent drop)', () => {
    expect(trimmedToolNotices({ available: ['read_source'], trimmed: [{ name: 'web_search', reason: 'capacity' },
      { name: 'web_fetch', reason: 'capacity' }, { name: 'social_search', reason: 'disabled' }] }))
      .toEqual(['本轮不能使用网页搜索、网页读取：本轮内容已接近输入上限。', '本轮不能使用社媒搜索：暂未开启。']);
    expect(trimmedToolNotices(undefined)).toEqual([]);
  });
});
