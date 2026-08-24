import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAuthCaptchaOptions,
  getAuthCaptchaToken,
  runAuthCaptchaAttempt,
} from './authCaptcha';

describe('getAuthCaptchaToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does not require or attach CAPTCHA when the public site key is absent', () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', '');

    expect(getAuthCaptchaOptions()).toEqual({});
  });

  it('fails closed when CAPTCHA is configured without a token', () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', 'site-key');
    vi.stubGlobal('window', { hcaptcha: { getResponse: vi.fn().mockReturnValue('') } });

    expect(() => getAuthCaptchaOptions()).toThrow('请完成人机验证后重试。');
  });

  it('returns the configured native hCaptcha response token as auth options', () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', 'site-key');
    const getResponse = vi.fn().mockReturnValue('captcha-token');
    vi.stubGlobal('window', { hcaptcha: { getResponse } });

    expect(getAuthCaptchaToken()).toBe('captcha-token');
    expect(getAuthCaptchaOptions()).toEqual({ captchaToken: 'captcha-token' });
    expect(getResponse).toHaveBeenCalledWith(undefined);
  });

  it('resets the widget after a CAPTCHA-protected operation returns an auth error', async () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', 'site-key');
    const reset = vi.fn();
    vi.stubGlobal('window', { hcaptcha: { getResponse: vi.fn().mockReturnValue('captcha-token'), reset } });

    const options = getAuthCaptchaOptions();
    const result = await runAuthCaptchaAttempt(options, async () => ({ error: 'auth failed' }));

    expect(result).toEqual({ error: 'auth failed' });
    expect(reset).toHaveBeenCalledWith(undefined);
  });

  it('resets the widget when a CAPTCHA-protected operation throws', async () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', 'site-key');
    const reset = vi.fn();
    vi.stubGlobal('window', { hcaptcha: { getResponse: vi.fn(), reset } });

    await expect(runAuthCaptchaAttempt({}, async () => Promise.reject(new Error('network failed')))).rejects.toThrow(
      'network failed',
    );
    expect(reset).toHaveBeenCalledWith(undefined);
  });
});
