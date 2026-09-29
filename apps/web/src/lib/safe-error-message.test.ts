import { describe, expect, it } from 'vitest';
import { ACCOUNT_UNAVAILABLE_MESSAGE, getSafeErrorMessage } from './safe-error-message';

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
