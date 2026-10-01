import { AuthRetryableFetchError, createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_UNAVAILABLE_MESSAGE } from './safe-error-message';
import {
  ACCOUNT_GATE_MESSAGES,
  buildForgotPasswordPath,
  buildRecoveryRedirectUrl,
  classifyAccountGateError,
  changePasswordWithToken,
  classifyPasswordUpdateError,
  classifyRecoveryExchangeError,
  isFreshRecoverySession,
  isTransientAuthError,
  parseRecoveryFailure,
  RECOVERY_FAILURE_MESSAGES,
  recoveryFailureNotice,
  PASSWORD_UPDATE_UNCERTAIN_MESSAGE,
  readAccessTokenClaims,
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

describe('request page notice after a failed link', () => {
  it('comes from the reason alone, with the fixed text and nothing from the provider', () => {
    const landing = new URL('https://auth-staging.graylum.com/forgot-password?reason=expired'
      + '#error=access_denied&error_code=user_banned&error_description=User+is+banned&sb=');
    const notice = recoveryFailureNotice(landing.searchParams.get('reason'));
    expect(notice).toEqual({ tone: 'error', message: '重置链接无效、已过期或已被使用，请重新申请。' });
    expect(notice!.message).not.toMatch(/banned|invalid|expired|access_denied/i);
    expect(recoveryFailureNotice('browser')).toEqual({ tone: 'error', message: RECOVERY_FAILURE_MESSAGES.browser });
    expect(recoveryFailureNotice('User is banned')).toBeNull();
    expect(recoveryFailureNotice(null)).toBeNull();
  });
});

describe('reset request outcome', () => {
  const sent = { tone: 'success', message: RESET_EMAIL_SENT_MESSAGE, cooldownSeconds: RESET_REQUEST_COOLDOWN_SECONDS };
  // GoTrue v2.197.0 answers an unknown email with success; only a registered email reaches sending.
  const unknownEmail = null;

  it.each([
    ['a failed send', authError('unexpected_failure', 500)],
    ['a server error without code', { status: 500, message: 'Internal Server Error' }],
    ['a gateway error (SDK, 502)', new AuthRetryableFetchError('Bad Gateway', 502)],
    ['a gateway error (SDK, 503)', new AuthRetryableFetchError('Service Unavailable', 503)],
    ['a gateway error (SDK, 504)', new AuthRetryableFetchError('Gateway Timeout', 504)],
    ['a gateway error (SDK, 530)', new AuthRetryableFetchError('x', 530)],
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
    ['a request without any HTTP response (SDK, status 0)', new AuthRetryableFetchError('Failed to fetch', 0), RESET_NETWORK_MESSAGE],
    ['a thrown fetch', new TypeError('Failed to fetch'), RESET_NETWORK_MESSAGE],
  ])('reports %s, which is the same for every address, without a cooldown', (_, error, message) => {
    expect(resetRequestOutcome(error)).toEqual({ tone: 'error', message, cooldownSeconds: 0 });
    expect(message).not.toMatch(/已注册|未注册/);
  });
});

// The real SDK turns each response into the error the page sees: auth-js 2.105.4 handleError wraps
// 502/503/504/520-524/530 as AuthRetryableFetchError with that status, and a failed fetch as status 0.
describe('reset request outcome for real SDK responses', () => {
  async function outcomeFor(respond: () => Promise<Response>) {
    const client = createClient('http://gotrue.local', 'anon', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: respond },
    });
    const { error } = await client.auth.resetPasswordForEmail('a@example.test', { redirectTo: 'http://127.0.0.1:3000/auth/callback' });
    return { error, outcome: resetRequestOutcome(error) };
  }
  // Shaped like GoTrue v2.197.0 errors: the API version header makes auth-js read the string `code`.
  const json = (status: number, body: object) => async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
  });
  const sent = { tone: 'success', message: RESET_EMAIL_SENT_MESSAGE, cooldownSeconds: RESET_REQUEST_COOLDOWN_SECONDS };

  it('shows an unknown email (GoTrue answers 200) and every registered-only failure identically', async () => {
    const unknownEmail = await outcomeFor(json(200, {}));
    expect(unknownEmail).toEqual({ error: null, outcome: sent });
    for (const status of [502, 503, 504]) {
      const gateway = await outcomeFor(async () => new Response('upstream timed out', { status }));
      expect(gateway.error).toBeInstanceOf(AuthRetryableFetchError);
      expect(gateway.error).toMatchObject({ status });
      expect(gateway.outcome).toEqual(unknownEmail.outcome);
    }
    const sendFailed = await outcomeFor(json(500, { code: 'unexpected_failure', message: 'Error sending recovery email' }));
    expect(sendFailed.outcome).toEqual(unknownEmail.outcome);
    const emailLimit = await outcomeFor(json(429, { code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }));
    expect(emailLimit.outcome).toEqual(unknownEmail.outcome);
  });

  it('reports only failures that are the same for every address', async () => {
    const noResponse = await outcomeFor(async () => { throw new TypeError('Failed to fetch'); });
    expect(noResponse.error).toBeInstanceOf(AuthRetryableFetchError);
    expect(noResponse.error).toMatchObject({ status: 0 });
    expect(noResponse.outcome).toEqual({ tone: 'error', message: RESET_NETWORK_MESSAGE, cooldownSeconds: 0 });
    expect((await outcomeFor(json(429, { code: 'over_request_rate_limit', message: 'x' }))).outcome)
      .toEqual({ tone: 'error', message: RESET_RATE_LIMIT_MESSAGE, cooldownSeconds: 0 });
    expect((await outcomeFor(json(400, { code: 'captcha_failed', message: 'x' }))).outcome)
      .toEqual({ tone: 'error', message: RESET_CAPTCHA_FAILED_MESSAGE, cooldownSeconds: 0 });
  });
});

describe('access token claims', () => {
  const token = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

  it('reads the user and sign-in methods without a request', () => {
    const amr = [{ method: 'recovery', timestamp: 1_800_000_000 }];
    expect(readAccessTokenClaims(token({ sub: 'u1', amr, email: 'ü@example.test' }))).toEqual({ userId: 'u1', amr });
    expect(readAccessTokenClaims(token({ sub: 'u1' }))).toEqual({ userId: 'u1', amr: [] });
  });

  it('rejects anything that is not a token with a user', () => {
    expect(readAccessTokenClaims(token({ amr: [] }))).toBeNull();
    expect(readAccessTokenClaims('h.not-base64!.s')).toBeNull();
    expect(readAccessTokenClaims('')).toBeNull();
    expect(readAccessTokenClaims(undefined)).toBeNull();
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
    expect(classifyPasswordUpdateError({ status: 403, code: '' })).toEqual({ kind: 'session' });
    expect(classifyPasswordUpdateError({ status: 429, code: '' })).toEqual({ kind: 'error', message: '操作太频繁，请稍后再试。' });
    for (const status of [0, 500, 502, 504]) {
      expect(classifyPasswordUpdateError({ status, code: '' })).toEqual({ kind: 'error', message: PASSWORD_UPDATE_UNCERTAIN_MESSAGE });
    }
    expect(classifyPasswordUpdateError(new Error('postgres exploded'))).toEqual({
      kind: 'error', message: '密码重置失败，请稍后重试。',
    });
  });
});

describe('changePasswordWithToken', () => {
  const call = (respond: (url: string, init: RequestInit) => Promise<Response>) => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    const result = changePasswordWithToken({
      supabaseUrl: 'https://project.supabase.co/', anonKey: 'anon-key', accessToken: 'token-of-a', password: 'new-password', fetchImpl,
    });
    return { result, requests };
  };
  const json = (status: number, body: object) => async () => new Response(JSON.stringify(body), { status });

  it('sends PUT /user with exactly the given token, the public key and only the password', async () => {
    const { result, requests } = call(json(200, { id: 'u1' }));
    expect(await result).toEqual({ error: null });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://project.supabase.co/auth/v1/user');
    expect(requests[0].init.method).toBe('PUT');
    expect(requests[0].init.headers).toMatchObject({
      apikey: 'anon-key', Authorization: 'Bearer token-of-a', 'X-Supabase-Api-Version': '2024-01-01',
    });
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ password: 'new-password' });
  });

  it('reports the status and error code, never the provider text', async () => {
    expect(await call(json(422, { code: 'same_password', message: 'raw' })).result).toEqual({ error: { status: 422, code: 'same_password' } });
    expect(await call(json(403, { error_code: 'session_not_found', msg: 'raw' })).result)
      .toEqual({ error: { status: 403, code: 'session_not_found' } });
    expect(await call(async () => new Response('<html>Bad Gateway</html>', { status: 502 })).result)
      .toEqual({ error: { status: 502, code: '' } });
    expect(await call(async () => { throw new TypeError('Failed to fetch'); }).result).toEqual({ error: { status: 0, code: '' } });
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
