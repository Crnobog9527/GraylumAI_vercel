/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { trimmedToolNotices, turnCodeNotice } from './turn-notices';

describe('turn notices', () => {
  it('gives the text back only for a code that proves nothing was stored', () => {
    expect(turnCodeNotice('TURN_INSUFFICIENT_CREDITS').kept).toBe(true);
    // A refused credit freeze (an account whose credit sources cannot be told apart) says so and keeps the text: nothing was charged.
    expect(turnCodeNotice('STOP_LOSS_REACHED')).toMatchObject({ kept: true, text: expect.stringContaining('没有扣费') });
    expect(turnCodeNotice('TURN_CREDIT_ACCOUNT_REVIEW')).toMatchObject({ kept: true, text: expect.stringContaining('没有扣费') });
    expect(turnCodeNotice('TURN_PROVIDER_402').kept).toBe(false);
    expect(turnCodeNotice('SOMETHING_NEW')).toMatchObject({ kept: false, text: expect.stringContaining('不要重复发送') });
    // The platform's daily stop-loss refuses before a turn opens: said plainly, nothing charged, the words kept.
    expect(turnCodeNotice('STOP_LOSS_REACHED')).toMatchObject({ kept: true, text: expect.stringContaining('没有扣费') });
    // The code is shown, so the next report of a failure says which one it was.
    expect(turnCodeNotice('SOMETHING_NEW').text).toContain('代码 SOMETHING_NEW');
  });
  // The old admission refusals -> the same refusals on the turn path (the codes the server sends before anything is stored).
  it.each([
    ['TURN_RATE_LIMITED', '发送太频繁'], ['TURN_NEW_CALLS_PAUSED', '暂停了新请求'], ['TURN_LIMIT_UNAVAILABLE', '暂时无法确认用量'],
    ['TURN_INPUT_TOO_LARGE', '太长'], ['TURN_REFERENCES_UNAVAILABLE', '引用的资料'], ['POSITIONING_REQUIRED', '账号定位'],
  ])('keeps the text of the refusal %s and says why', (code, words) => {
    expect(turnCodeNotice(code)).toMatchObject({ kept: true, text: expect.stringContaining(words) });
  });
  it('says a provider failure refunded the round and does not hand the text back', () => {
    for (const code of ['TURN_PROVIDER_402', 'TURN_PROVIDER_BUSY'])
      expect(turnCodeNotice(code)).toMatchObject({ kept: false, text: expect.stringContaining('全额退回') });
  });
  it('says a model held for a price check ended the round with the credits back, in words, not as a bare code', () => {
    const notice = turnCodeNotice('TURN_MODEL_METERING_BLOCKED');
    expect(notice).toMatchObject({ kept: false, text: expect.stringContaining('这个模型暂时停用') });
    expect(notice.text).toContain('积分已退回');
    expect(notice.text).not.toContain('TURN_MODEL_METERING_BLOCKED');
  });
  it('says a round paused for credits can be continued and is refunded after 24 hours', () => {
    expect(turnCodeNotice('TURN_PAUSED_FOR_CREDITS')).toMatchObject({ kept: false, text: expect.stringContaining('点继续') });
    expect(turnCodeNotice('TURN_PAUSED_FOR_CREDITS').text).toContain('24 小时');
  });
  // Owner 2026-11-11: a turn that was cut off saved no answer and charges nothing.
  it('says an interrupted reply is not charged and its frozen credits come back', () => {
    const notice = turnCodeNotice('TURN_CALL_UNKNOWN');
    expect(notice).toMatchObject({ kept: false, text: expect.stringContaining('不扣积分') });
    expect(notice.text).toContain('退回');
    expect(notice.text).not.toContain('以记录为准');
  });
  it('says a reply cut off after part was shown is saved and charged by its usage', () => {
    const notice = turnCodeNotice('TURN_REPLY_CUT');
    expect(notice).toMatchObject({ kept: false, text: expect.stringContaining('已显示的内容已经保存') });
    expect(notice.text).toContain('按实际用量扣积分');
    expect(notice.text).not.toContain('不扣积分');
  });
  it('names every trimmed tool, grouped by why (never a silent drop)', () => {
    expect(trimmedToolNotices({ available: ['read_source'], trimmed: [{ name: 'web_search', reason: 'capacity' },
      { name: 'web_fetch', reason: 'capacity' }, { name: 'social_search', reason: 'disabled' }] }))
      .toEqual(['本轮不能使用网页搜索、网页读取：本轮内容已接近输入上限。', '本轮不能使用社媒搜索：暂未开启。']);
    expect(trimmedToolNotices(undefined)).toEqual([]);
  });
});
