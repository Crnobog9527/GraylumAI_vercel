import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthCaptchaSiteKey } from './authCaptcha';

describe('getAuthCaptchaSiteKey', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the trimmed public site key and is empty when CAPTCHA is not configured', () => {
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', '  site-key  ');
    expect(getAuthCaptchaSiteKey()).toBe('site-key');
    vi.stubEnv('NEXT_PUBLIC_HCAPTCHA_SITEKEY', '');
    expect(getAuthCaptchaSiteKey()).toBe('');
  });
});
