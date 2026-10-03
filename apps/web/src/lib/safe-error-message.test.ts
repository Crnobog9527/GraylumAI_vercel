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
