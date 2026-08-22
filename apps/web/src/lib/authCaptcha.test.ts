import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthCaptchaToken } from './authCaptcha';

describe('getAuthCaptchaToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the native hCaptcha response token', () => {
    const getResponse = vi.fn().mockReturnValue('captcha-token');
    vi.stubGlobal('window', { hcaptcha: { getResponse } });

    expect(getAuthCaptchaToken()).toBe('captcha-token');
    expect(getResponse).toHaveBeenCalledWith(undefined);
  });

  it('fails closed when hCaptcha has not produced a token', () => {
    vi.stubGlobal('window', { hcaptcha: { getResponse: vi.fn().mockReturnValue('') } });

    expect(() => getAuthCaptchaToken()).toThrow('请完成人机验证后重试。');
  });
});
