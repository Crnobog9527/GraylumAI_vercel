import { describe, expect, it } from 'vitest';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from './safe-error-message';
import {
  ACCOUNT_GATE_MESSAGES,
  buildForgotPasswordPath,
  buildRecoveryRedirectUrl,
  classifyAccountGateError,
  classifyPasswordUpdateError,
  classifyRecoveryExchangeError,
  isFreshRecoverySession,
  isTransientAuthError,
  parseRecoveryFailure,
  RECOVERY_SESSION_MAX_AGE_SECONDS,
  recoveryTimestamp,
  RESET_CAPTCHA_FAILED_MESSAGE,
  RESET_EMAIL_SENT_MESSAGE,
  RESET_INVALID_EMAIL_MESSAGE,
  RESET_NETWORK_MESSAGE,
  RESET_RATE_LIMIT_MESSAGE,
  RESET_REQUEST_COOLDOWN_SECONDS,
  resetRequestOutcome,
  validateNewPassword,
} from './passwordRecovery';

const authError = (code: string, status = 400) => Object.assign(new Error('provider text'), { code, status });
const trpcError = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

describe('reset link destination', () => {
  it('goes through the shared callback to the new-password page', () => {
    const url = new URL(buildRecoveryRedirectUrl('https://auth-staging.graylum.com'));
    expect(`${url.origin}${url.pathname}`).toBe('https://auth-staging.graylum.com/auth/callback');
    expect(Object.fromEntries(url.searchParams)).toEqual({ next: '/reset-password', flow: 'recovery' });
  });

  it('honors only the fixed failure reasons', () => {
    expect(buildForgotPasswordPath('browser')).toBe('/forgot-password?reason=browser');
    expect(buildForgotPasswordPath()).toBe('/forgot-password');
    expect(parseRecoveryFailure('expired')).toBe('expired');
    expect(parseRecoveryFailure('<b>pay here</b>')).toBeNull();
    expect(parseRecoveryFailure(null)).toBeNull();
  });

  it('separates a link opened in another browser from other exchange failures', () => {
    expect(classifyRecoveryExchangeError(authError('pkce_code_verifier_not_found'))).toBe('browser');
    expect(classifyRecoveryExchangeError(authError('bad_code_verifier'))).toBe('browser');
    // Opening the callback address again in the same browser: the flow is spent, not elsewhere.
    expect(classifyRecoveryExchangeError(authError('flow_state_not_found'))).toBe('expired');
    expect(classifyRecoveryExchangeError(authError('flow_state_expired'))).toBe('expired');
    expect(classifyRecoveryExchangeError(authError('unexpected_failure'))).toBe('failed');
    expect(classifyRecoveryExchangeError(null)).toBe('failed');
  });
});

describe('reset request outcome', () => {
  const sent = { tone: 'success', message: RESET_EMAIL_SENT_MESSAGE, cooldownSeconds: RESET_REQUEST_COOLDOWN_SECONDS };
  // GoTrue v2.197.0 answers an unknown email with success; only a registered email reaches sending.
  const unknownEmail = null;

  it.each([
    ['a failed send', authError('unexpected_failure', 500)],
    ['a server error without code', { status: 502, message: 'Bad Gateway' }],
    ['the per-email send limit', authError('over_email_send_rate_limit', 429)],
    ['an address the mailer refuses', authError('email_address_not_authorized', 400)],
    ['an unknown error', new Error('Error sending recovery email')],
  ])('makes %s for a registered email look exactly like an unknown email', (_, registeredEmail) => {
    expect(resetRequestOutcome(registeredEmail)).toEqual(resetRequestOutcome(unknownEmail));
    expect(resetRequestOutcome(unknownEmail)).toEqual(sent);
  });

  it.each([
    ['the human check', authError('captcha_failed', 400), RESET_CAPTCHA_FAILED_MESSAGE],
    ['the per-visitor request limit', authError('over_request_rate_limit', 429), RESET_RATE_LIMIT_MESSAGE],
    ['a 429 without code', { status: 429 }, RESET_RATE_LIMIT_MESSAGE],
    ['a malformed address', authError('validation_failed', 400), RESET_INVALID_EMAIL_MESSAGE],
    ['a request that never arrived', Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }), RESET_NETWORK_MESSAGE],
    ['a thrown fetch', new TypeError('Failed to fetch'), RESET_NETWORK_MESSAGE],
  ])('reports %s, which is the same for every address, without a cooldown', (_, error, message) => {
    expect(resetRequestOutcome(error)).toEqual({ tone: 'error', message, cooldownSeconds: 0 });
    expect(message).not.toMatch(/已注册|未注册/);
  });
});

describe('transient auth errors', () => {
  it('separates network and server failures from a missing or rejected session', () => {
    expect(isTransientAuthError(Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }))).toBe(true);
    expect(isTransientAuthError({ status: 503 })).toBe(true);
    expect(isTransientAuthError(Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400 })))
      .toBe(false);
    expect(isTransientAuthError(authError('session_not_found', 403))).toBe(false);
    expect(isTransientAuthError(null)).toBe(false);
  });
});

describe('recovery session check', () => {
  const now = 1_800_000_000;

  it('accepts a recent recovery entry', () => {
    expect(isFreshRecoverySession([{ method: 'recovery', timestamp: now - 30 }], now)).toBe(true);
    expect(isFreshRecoverySession([{ method: 'password', timestamp: now - 9999 }, { method: 'recovery', timestamp: now }], now))
      .toBe(true);
  });

  it('reports the newest reset behind the session', () => {
    expect(recoveryTimestamp([{ method: 'recovery', timestamp: 5 }, { method: 'recovery', timestamp: 9 }, { method: 'password', timestamp: 20 }]))
      .toBe(9);
    expect(recoveryTimestamp([{ method: 'password', timestamp: 20 }, 'recovery'])).toBeNull();
    expect(recoveryTimestamp(null)).toBeNull();
  });

  it('rejects sessions from other sign-ins, old resets and malformed claims', () => {
    expect(isFreshRecoverySession([{ method: 'password', timestamp: now }], now)).toBe(false);
    expect(isFreshRecoverySession([{ method: 'otp', timestamp: now }], now)).toBe(false);
    expect(isFreshRecoverySession([{ method: 'recovery', timestamp: now - RECOVERY_SESSION_MAX_AGE_SECONDS - 1 }], now)).toBe(false);
    expect(isFreshRecoverySession([{ method: 'recovery', timestamp: now + 3600 }], now)).toBe(false);
    expect(isFreshRecoverySession(['recovery'], now)).toBe(false);
    expect(isFreshRecoverySession([{ method: 'recovery', timestamp: 'now' }], now)).toBe(false);
    expect(isFreshRecoverySession(undefined, now)).toBe(false);
  });
});

describe('new password', () => {
  it('uses the profile page rules', () => {
    expect(validateNewPassword('', '')).toBe('请完整填写新密码。');
    expect(validateNewPassword('abcdefgh', 'abcdefgx')).toBe('两次输入的新密码不一致。');
    expect(validateNewPassword('short', 'short')).toBe('新密码至少需要 8 位字符。');
    expect(validateNewPassword('long-enough', 'long-enough')).toBeNull();
  });

  it('maps GoTrue update errors to fixed texts and a lost session to a new request', () => {
    expect(classifyPasswordUpdateError(authError('same_password', 422))).toEqual({
      kind: 'error', message: '新密码不能和原来的密码相同。',
    });
    expect(classifyPasswordUpdateError(authError('weak_password', 422))).toMatchObject({ kind: 'error' });
    expect(classifyPasswordUpdateError(authError('session_not_found', 403))).toEqual({ kind: 'session' });
    expect(classifyPasswordUpdateError({ status: 401 })).toEqual({ kind: 'session' });
    expect(classifyPasswordUpdateError(new Error('postgres exploded'))).toEqual({
      kind: 'error', message: '密码重置失败，请稍后重试。',
    });
  });
});

describe('account status before a reset', () => {
  it('blocks closed, disabled and banned accounts with one shared text', () => {
    for (const message of ['ACCOUNT_CLOSED: 账号已注销', '账号已被禁用，请联系管理员', '账号已被封禁']) {
      expect(classifyAccountGateError(trpcError('FORBIDDEN', message))).toBe('unavailable');
    }
    expect(ACCOUNT_GATE_MESSAGES.unavailable).toContain(ACCOUNT_UNAVAILABLE_MESSAGE);
  });

  it('fails closed with a retry when the status cannot be read', () => {
    expect(classifyAccountGateError(trpcError('INTERNAL_SERVER_ERROR', 'x'))).toBe('retry');
    expect(classifyAccountGateError(trpcError('UNAUTHORIZED', 'x'))).toBe('retry');
    expect(classifyAccountGateError(trpcError('FORBIDDEN', 'EMAIL_NOT_VERIFIED'))).toBe('retry');
    expect(classifyAccountGateError(new TypeError('Failed to fetch'))).toBe('retry');
  });
});
