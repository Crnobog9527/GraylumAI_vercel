/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { buildAuthCallbackUrl } from '@/lib/authFlow';
import { resolveAuthAppUrl } from '@/lib/site-config';

/**
 * Deep review 11-11 item 3: a Google account re-verifies for account erasure by signing in with Google once more,
 * not with an email code (the Supabase magic-link email it would get carries a link, no code). The fresh sign-in
 * is what the server checks (accountErasure/reauth.ts: an authentication within the last ten minutes).
 *
 * The dialog leaves the page for Google, so before it goes it notes in this tab which account asked and when. On the
 * way back the dialog reopens at the last step only when that note is fresh and names the account now signed in:
 * Google may hand back a different account, and that one must not land on "确认注销" by surprise. A link carrying
 * the return parameter without the note opens nothing.
 */
export const OAUTH_REAUTH_PARAM = 'erasure';
export const OAUTH_REAUTH_VALUE = 'reauth';
const STORAGE_KEY = 'graylum:erasure-oauth-reauth';
/** Same window as the server check; a slower round trip asks again. */
export const OAUTH_REAUTH_MAX_AGE_MS = 10 * 60 * 1000;

export const OAUTH_REAUTH_RETURN_PATH = `/app/profile?tab=security&${OAUTH_REAUTH_PARAM}=${OAUTH_REAUTH_VALUE}`;

type Note = { userId: string; at: number };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type OAuthReauthResume =
  | { kind: 'none' }
  | { kind: 'confirm' }
  | { kind: 'expired' }
  | { kind: 'other_account' };

export const OAUTH_REAUTH_MESSAGES = {
  expired: '重新验证超时了，请再验证一次。',
  other_account: '刚才在 Google 选择的不是要注销的那个账号，现在登录的是这个 Google 账号。'
    + '如果要注销原来的账号，请退出后用原来的账号登录再操作。',
  failed: '没能打开 Google 登录，请稍后重试。',
} as const;

export function oauthReauthRedirect(origin: string): string {
  return buildAuthCallbackUrl(resolveAuthAppUrl(origin), OAUTH_REAUTH_RETURN_PATH, 'oauth');
}

export function rememberOAuthReauth(store: Store, userId: string, now: number): void {
  store.setItem(STORAGE_KEY, JSON.stringify({ userId, at: now } satisfies Note));
}

function readNote(store: Store): Note | null {
  try {
    const value: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const { userId, at } = value as Record<string, unknown>;
    return typeof userId === 'string' && userId && typeof at === 'number' && Number.isFinite(at) ? { userId, at } : null;
  } catch {
    return null;
  }
}

/** Reads and always clears the note: it answers one return from Google only. */
export function takeOAuthReauth(store: Store, search: string, currentUserId: string, now: number): OAuthReauthResume {
  if (new URLSearchParams(search).get(OAUTH_REAUTH_PARAM) !== OAUTH_REAUTH_VALUE) return { kind: 'none' };
  const note = readNote(store);
  store.removeItem(STORAGE_KEY);
  if (!note || !currentUserId) return { kind: 'none' };
  if (note.userId !== currentUserId) return { kind: 'other_account' };
  if (note.at > now || now - note.at > OAUTH_REAUTH_MAX_AGE_MS) return { kind: 'expired' };
  return { kind: 'confirm' };
}

/** The address without the return parameter, so a reload does not reopen the dialog. */
export function withoutOAuthReauthParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(OAUTH_REAUTH_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}
