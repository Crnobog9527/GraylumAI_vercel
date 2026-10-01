import { sanitizeRedirectTarget } from '@/lib/auth';
import { isPublicPathname } from '@/lib/public-paths';

// What the app does after an API call is rejected as unauthenticated. Recovery is bounded: one
// session refresh, then at most one automatic trip to the login page per cooldown; after that the
// visitor gets a notice with a button instead, so a page can never bounce or spin forever.
export type UnauthorizedAction =
  | { kind: 'ignore' }
  | { kind: 'refresh' }
  | { kind: 'redirect'; to: string }
  | { kind: 'notice'; reason: UnauthorizedNoticeReason };

export type UnauthorizedNoticeReason = 'no-session' | 'session-rejected';

export const AUTO_LOGIN_REDIRECT_KEY = 'graylum:auth-recovery-redirect-at';
export const AUTO_LOGIN_REDIRECT_COOLDOWN_MS = 60_000;

export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('data' in error)) {
    return false;
  }
  const data = error.data;
  if (!data || typeof data !== 'object') {
    return false;
  }
  const { code, httpStatus } = data as { code?: unknown; httpStatus?: unknown };
  return code === 'UNAUTHORIZED' || httpStatus === 401;
}

export function buildLoginPath(pathname: string, search: string) {
  const params = new URLSearchParams({ redirect: sanitizeRedirectTarget(`${pathname}${search}`) });
  return `/login?${params.toString()}`;
}

export function decideUnauthorizedAction(input: {
  pathname: string;
  search: string;
  hasSession: boolean;
  sessionRefreshUsed: boolean;
  lastRedirectAt: number | null;
  now: number;
}): UnauthorizedAction {
  if (isPublicPathname(input.pathname)) {
    return { kind: 'ignore' };
  }
  if (input.hasSession) {
    return input.sessionRefreshUsed ? { kind: 'notice', reason: 'session-rejected' } : { kind: 'refresh' };
  }
  const recentlyRedirected = input.lastRedirectAt !== null
    && input.now - input.lastRedirectAt >= 0
    && input.now - input.lastRedirectAt < AUTO_LOGIN_REDIRECT_COOLDOWN_MS;
  if (recentlyRedirected) {
    return { kind: 'notice', reason: 'no-session' };
  }
  return { kind: 'redirect', to: buildLoginPath(input.pathname, input.search) };
}

export function readLastAutoRedirect(): number | null {
  try {
    const value = Number(window.sessionStorage.getItem(AUTO_LOGIN_REDIRECT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function recordAutoRedirect(now: number) {
  try {
    window.sessionStorage.setItem(AUTO_LOGIN_REDIRECT_KEY, String(now));
  } catch {
    // Without storage the cooldown cannot be kept; the notice path still stops repeated redirects
    // within this page load because recovery stays locked after a redirect.
  }
}
