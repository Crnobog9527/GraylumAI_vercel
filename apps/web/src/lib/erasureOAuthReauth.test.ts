/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  OAUTH_REAUTH_MAX_AGE_MS, OAUTH_REAUTH_RETURN_PATH, oauthReauthRedirect, rememberOAuthReauth, takeOAuthReauth,
  withoutOAuthReauthParam,
} from './erasureOAuthReauth';

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    size: () => data.size,
  };
}
const back = '?tab=security&erasure=reauth';
const t0 = 1_800_000_000_000;

describe('Google re-verification for account erasure (deep review 11-11 item 3)', () => {
  it('returns through the auth callback to the security tab as a Google sign-in', () => {
    const url = new URL(oauthReauthRedirect('https://auth-staging.graylum.com'));
    expect(url.pathname).toBe('/auth/callback');
    expect(url.searchParams.get('flow')).toBe('oauth');
    expect(url.searchParams.get('next')).toBe(OAUTH_REAUTH_RETURN_PATH);
  });

  it('allows: the same account back within ten minutes reaches the last step, once', () => {
    const store = memory();
    rememberOAuthReauth(store, 'user-a', t0);
    expect(takeOAuthReauth(store, back, 'user-a', t0 + 30_000)).toEqual({ kind: 'confirm' });
    expect(store.size()).toBe(0);
    expect(takeOAuthReauth(store, back, 'user-a', t0 + 31_000)).toEqual({ kind: 'none' });
  });

  it('denies: another Google account, a stale note, or a link without a note', () => {
    const other = memory();
    rememberOAuthReauth(other, 'user-a', t0);
    expect(takeOAuthReauth(other, back, 'user-b', t0 + 1_000)).toEqual({ kind: 'other_account' });

    const stale = memory();
    rememberOAuthReauth(stale, 'user-a', t0);
    expect(takeOAuthReauth(stale, back, 'user-a', t0 + OAUTH_REAUTH_MAX_AGE_MS + 1)).toEqual({ kind: 'expired' });

    const future = memory();
    rememberOAuthReauth(future, 'user-a', t0 + 60_000);
    expect(takeOAuthReauth(future, back, 'user-a', t0)).toEqual({ kind: 'expired' });

    expect(takeOAuthReauth(memory(), back, 'user-a', t0)).toEqual({ kind: 'none' });

    const garbled = memory();
    garbled.setItem('graylum:erasure-oauth-reauth', '{"userId":1');
    expect(takeOAuthReauth(garbled, back, 'user-a', t0)).toEqual({ kind: 'none' });
  });

  it('ignores the note on a normal visit and keeps it for the return', () => {
    const store = memory();
    rememberOAuthReauth(store, 'user-a', t0);
    expect(takeOAuthReauth(store, '?tab=security', 'user-a', t0)).toEqual({ kind: 'none' });
    expect(store.size()).toBe(1);
  });

  it('drops only the return parameter from the address', () => {
    expect(withoutOAuthReauthParam(`https://x.test/app/profile${back}#top`)).toBe('/app/profile?tab=security#top');
  });
});
