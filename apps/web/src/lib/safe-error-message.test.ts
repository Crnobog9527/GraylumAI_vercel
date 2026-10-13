import { describe, expect, it } from 'vitest';
import { ACCOUNT_UNAVAILABLE_MESSAGE, getSafeErrorMessage, readValidationIssueMessages } from './safe-error-message';

describe('getSafeErrorMessage', () => {
  it('shows one Chinese message for a banned account, by message or by code', () => {
    expect(getSafeErrorMessage({ message: 'User is banned' }, '登录失败')).toBe(ACCOUNT_UNAVAILABLE_MESSAGE);
    expect(getSafeErrorMessage({ message: 'x', code: 'user_banned' }, '登录失败')).toBe(ACCOUNT_UNAVAILABLE_MESSAGE);
    expect(ACCOUNT_UNAVAILABLE_MESSAGE).toBe('该账号已注销或已被停用，无法登录');
  });

  it('keeps existing behaviour for other errors', () => {
    expect(getSafeErrorMessage({ message: '邀请码无效' }, 'fallback')).toBe('邀请码无效');
    expect(getSafeErrorMessage({ message: 'permission denied for table x' }, 'fallback')).toBe('fallback');
    expect(getSafeErrorMessage(null, 'fallback')).toBe('fallback');
  });
});

describe('validation issue arrays', () => {
  const zodArray = JSON.stringify([{
    code: 'custom', path: ['value'], message: '全站默认加价倍数须在 1 到 20 之间，最多两位小数',
  }]);

  it('shows the server issue text instead of the raw array', () => {
    expect(getSafeErrorMessage({ message: zodArray }, 'fallback')).toBe('全站默认加价倍数须在 1 到 20 之间，最多两位小数');
  });

  it('joins distinct issues and drops duplicates', () => {
    const two = JSON.stringify([{ message: '甲' }, { message: '乙' }, { message: '甲' }]);
    expect(readValidationIssueMessages(two)).toBe('甲；乙');
  });

  it('ignores arrays that are not issue lists', () => {
    expect(readValidationIssueMessages('[1,2]')).toBeNull();
    expect(readValidationIssueMessages('[]')).toBeNull();
    expect(readValidationIssueMessages('[not json')).toBeNull();
    expect(readValidationIssueMessages('普通错误')).toBeNull();
  });

  it('still hides unsafe issue text', () => {
    const unsafe = JSON.stringify([{ message: 'relation "x" does not exist' }]);
    expect(getSafeErrorMessage({ message: unsafe }, 'fallback')).toBe('fallback');
  });
});

describe('model identity (MODEL-IDENTITY-GUARD)', () => {
  it.each([
    '模型价格未配置: anthropic/claude-sonnet-5.5',
    'Gemini 3.8 Flash is overloaded',
    'provider deepinfra/fp8 rejected the request',
    'GPT-6 context length exceeded',
    'OpenRouter returned an error',
  ])('hides %s', message => {
    expect(getSafeErrorMessage({ message }, 'fallback')).toBe('fallback');
  });

  it.each(['余额不足，请充值后继续', '这条消息太长，请分几次发送', '请先选择平台：YouTube 或 TikTok'])('keeps ordinary text %s', message => {
    expect(getSafeErrorMessage({ message }, 'fallback')).toBe(message);
  });
});
