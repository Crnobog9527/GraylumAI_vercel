/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Runtime refuses a request whose access token would expire before the request can finish
 * persisting (packages/api/src/services/runtime/actor.ts, about 285 s), asking the client to
 * refresh. The Supabase SDK only refreshes about 90 s before expiry, so without this every
 * token had a few minutes in which sending failed with "请重新登录".
 */
export const SESSION_REFRESH_REQUIRED_MESSAGE = '登录会话剩余时间不足，请重新登录后继续原请求。';
export const SESSION_REFRESH_REQUIRED_CODE = 'RUNTIME_STAGING_AUTH_REFRESH_REQUIRED';
/** Refresh ahead of a mutation when less than this is left: covers the server's persistence budget. */
export const SESSION_MIN_REMAINING_MS = 6 * 60_000;

/** The exact Runtime refusal, in a normal result or inside a streamed one. */
export function isSessionRefreshRequired(error: unknown) {
  const message = error instanceof Error ? error.message
    : typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message : '';
  return message.includes(SESSION_REFRESH_REQUIRED_MESSAGE) || message.includes(SESSION_REFRESH_REQUIRED_CODE);
}

type Session = { access_token: string; expires_at?: number } | null;
type SessionResult = { data: { session: Session }; error?: unknown };
export type SessionRefresherDeps = {
  getSession: () => Promise<SessionResult>;
  refreshSession: () => Promise<SessionResult>;
  /** The new access token, so the next request carries it. */
  onToken: (token: string) => void;
  now?: () => number;
  minRemainingMs?: number;
};

/**
 * One refresh at a time for the whole page: concurrent callers share it, so the refresh
 * token is never spent twice.
 */
export function createSessionRefresher(deps: SessionRefresherDeps) {
  const now = deps.now ?? Date.now;
  const minRemaining = deps.minRemainingMs ?? SESSION_MIN_REMAINING_MS;
  let inFlight: Promise<boolean> | null = null;

  /** Refresh the session; true only when a new session with a token came back. */
  function refresh() {
    inFlight ??= deps.refreshSession().then(({ data, error }) => {
      const token = !error ? data.session?.access_token : undefined;
      if (token) deps.onToken(token);
      return Boolean(token);
    }, () => false).finally(() => { inFlight = null; });
    return inFlight;
  }

  /**
   * Before a request: refresh when the token is about to run short. Never blocks the request:
   * without a session, or when the check itself fails, the request goes out unchanged.
   */
  async function ensureFresh() {
    try {
      const { data } = await deps.getSession();
      const expiresAt = data.session?.expires_at;
      if (!data.session || typeof expiresAt !== 'number') return;
      if (expiresAt * 1000 - now() <= minRemaining) await refresh();
    } catch {
      /* The server still checks; a refusal is handled by the retry. */
    }
  }

  return { refresh, ensureFresh };
}
export type SessionRefresher = ReturnType<typeof createSessionRefresher>;
