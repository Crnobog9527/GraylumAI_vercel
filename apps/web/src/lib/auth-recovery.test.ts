import { describe, expect, it } from 'vitest';
import {
  AUTO_LOGIN_REDIRECT_COOLDOWN_MS,
  decideUnauthorizedAction,
  isUnauthorizedError,
} from './auth-recovery';

const base = {
  pathname: '/profile',
  search: '?tab=security',
  hasSession: false,
  sessionRefreshUsed: false,
  lastRedirectAt: null,
  now: 1_000_000,
};

describe('isUnauthorizedError', () => {
  it('recognizes tRPC UNAUTHORIZED by code or HTTP status only', () => {
    expect(isUnauthorizedError({ data: { code: 'UNAUTHORIZED', httpStatus: 401 } })).toBe(true);
    expect(isUnauthorizedError({ data: { httpStatus: 401 } })).toBe(true);
    expect(isUnauthorizedError({ data: { code: 'FORBIDDEN', httpStatus: 403 } })).toBe(false);
    expect(isUnauthorizedError(new Error('401'))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
  });
});

describe('decideUnauthorizedAction', () => {
  it('sends a visitor without a session to login once, keeping the page as redirect target', () => {
    expect(decideUnauthorizedAction(base)).toEqual({
      kind: 'redirect',
      to: '/login?redirect=%2Fprofile%3Ftab%3Dsecurity',
    });
  });

  it('sends a verified account with no session in this browser to login instead of spinning', () => {
    // The verify link was opened in another browser: the email is confirmed but no session exists here,
    // so every API call on /profile is rejected. The first 401 must lead to login, not to more retries.
    const action = decideUnauthorizedAction({ ...base, search: '', hasSession: false });
    expect(action).toEqual({ kind: 'redirect', to: '/login?redirect=%2Fprofile' });
  });

  it('shows a notice instead of redirecting again within the cooldown', () => {
    const lastRedirectAt = base.now - AUTO_LOGIN_REDIRECT_COOLDOWN_MS + 1;
    expect(decideUnauthorizedAction({ ...base, lastRedirectAt })).toEqual({ kind: 'notice', reason: 'no-session' });
    const expired = base.now - AUTO_LOGIN_REDIRECT_COOLDOWN_MS;
    expect(decideUnauthorizedAction({ ...base, lastRedirectAt: expired }).kind).toBe('redirect');
  });

  it('refreshes a live session once, then stops with a notice', () => {
    expect(decideUnauthorizedAction({ ...base, hasSession: true })).toEqual({ kind: 'refresh' });
    expect(decideUnauthorizedAction({ ...base, hasSession: true, sessionRefreshUsed: true })).toEqual({
      kind: 'notice',
      reason: 'session-rejected',
    });
  });

  it('never acts on public pages such as login or verify-email', () => {
    for (const pathname of ['/login', '/verify-email', '/landing', '/auth/callback']) {
      expect(decideUnauthorizedAction({ ...base, pathname })).toEqual({ kind: 'ignore' });
    }
  });

  it('falls back to the default target when the current path is not a safe redirect', () => {
    const action = decideUnauthorizedAction({ ...base, pathname: '//evil.example', search: '' });
    expect(action).toEqual({ kind: 'redirect', to: '/login?redirect=%2Fprofile' });
  });
});
