import { describe, expect, it } from 'vitest';
import {
  buildVerifyEmailPath,
  classifyLoginError,
  INVALID_CREDENTIALS_MESSAGE,
  loginErrorMessage,
  parseVerifyReason,
  routeCallbackError,
  readAuthFragment,
  EMAIL_VERIFIED_LOGIN_MESSAGE,
  VERIFY_REASON_MESSAGES,
} from './authFlow';

const authError = (code: string | undefined, message: string) => Object.assign(new Error(message), { code });

describe('classifyLoginError', () => {
  it('routes email_not_confirmed to the verify page by code', () => {
    expect(classifyLoginError(authError('email_not_confirmed', 'Email not confirmed'), 'x')).toEqual({ kind: 'unconfirmed' });
  });

  it('turns invalid_credentials into one generic message with the resend entry', () => {
    // A wrong password and an unknown email return the same code, so both read the same.
    expect(classifyLoginError(authError('invalid_credentials', 'Invalid login credentials'), 'x')).toEqual({
      kind: 'error', message: INVALID_CREDENTIALS_MESSAGE, offerResend: true,
    });
  });

  it('never routes by text when a code is present', () => {
    expect(classifyLoginError(authError('validation_failed', 'Unable to validate email address'), '登录失败'))
      .toMatchObject({ kind: 'error', offerResend: false });
  });

  it('keeps the old text match only when the code is missing', () => {
    expect(classifyLoginError(authError(undefined, 'Email not confirmed'), 'x')).toEqual({ kind: 'unconfirmed' });
    expect(classifyLoginError(authError(undefined, 'Something else'), '登录失败')).toEqual({
      kind: 'error', message: 'Something else', offerResend: false,
    });
  });

  it('keeps the closed-account message for banned users', () => {
    expect(classifyLoginError(authError('user_banned', 'User is banned'), 'x'))
      .toMatchObject({ kind: 'error', message: '该账号已注销或已被停用，无法登录', offerResend: false });
  });
});

describe('verify page reason', () => {
  it('accepts only the listed reasons', () => {
    expect(parseVerifyReason('signup')).toBe('signup');
    expect(parseVerifyReason('expired')).toBe('expired');
    for (const value of [null, '', 'Expired', '<b>x</b>', 'signup ']) expect(parseVerifyReason(value)).toBeNull();
  });

  it('uses one sign-up text that does not depend on whether the email existed', () => {
    expect(VERIFY_REASON_MESSAGES.signup).toContain('如果这个邮箱之前注册过，请直接登录');
    expect(VERIFY_REASON_MESSAGES.signup).toContain('重复注册不会修改原来的密码');
  });

  it('builds encoded paths and omits an empty email', () => {
    expect(buildVerifyEmailPath('a+b@example.test', '/profile?x=1', 'signup'))
      .toBe('/verify-email?email=a%2Bb%40example.test&redirect=%2Fprofile%3Fx%3D1&reason=signup');
    expect(buildVerifyEmailPath('', '/profile', 'expired')).toBe('/verify-email?redirect=%2Fprofile&reason=expired');
    expect(buildVerifyEmailPath('a@example.test', '/')).toBe('/verify-email?email=a%40example.test&redirect=%2F');
  });
});

describe('routeCallbackError', () => {
  const params = (query: string) => new URLSearchParams(query);

  it('sends only whitelisted link errors to the resend page', () => {
    expect(routeCallbackError(params('error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid')))
      .toEqual({ to: 'verify-expired' });
  });

  it('sends every other error to the generic login error', () => {
    expect(routeCallbackError(params('error=access_denied'))).toEqual({ to: 'login-error' });
    expect(routeCallbackError(params('error=server_error&error_code=unexpected_failure'))).toEqual({ to: 'login-error' });
    expect(routeCallbackError(params('error_code=otp_expired_but_not'))).toEqual({ to: 'login-error' });
  });

  it('ignores a normal callback', () => {
    expect(routeCallbackError(params('code=abc&next=%2Fprofile'))).toBeNull();
  });
});

describe('readAuthFragment', () => {
  it('reads the same error whitelist from a URL fragment', () => {
    expect(readAuthFragment('#error=access_denied&error_code=otp_expired&error_description=x&sb='))
      .toEqual({ to: 'verify-expired' });
    expect(readAuthFragment('#error=access_denied')).toEqual({ to: 'login-error' });
  });

  it('turns a confirmed sign-up fragment into the fixed log-in text, never a session', () => {
    expect(readAuthFragment('#access_token=a&refresh_token=r&expires_in=3600&token_type=bearer&type=signup'))
      .toEqual({ to: 'verified' });
    expect(EMAIL_VERIFIED_LOGIN_MESSAGE).toBe('邮箱已验证，请登录。');
  });

  it('only discards other token fragments', () => {
    expect(readAuthFragment('#access_token=a&refresh_token=r&type=magiclink')).toEqual({ to: 'discard' });
    expect(readAuthFragment('#refresh_token=r')).toEqual({ to: 'discard' });
  });

  it('ignores an empty or unrelated fragment', () => {
    expect(readAuthFragment('')).toBeNull();
    expect(readAuthFragment('#pricing')).toBeNull();
  });
});

describe('loginErrorMessage', () => {
  it('shows fixed text for known codes and nothing for anything else', () => {
    expect(loginErrorMessage('callback_failed')).toBe('登录验证失败，请稍后重试。');
    for (const value of [null, '', '请联系客服转账', '%E7%99%BB%E5%BD%95']) expect(loginErrorMessage(value)).toBeNull();
  });
});
