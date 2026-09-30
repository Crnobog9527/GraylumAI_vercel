// End-to-end against a disposable local GoTrue (same version as staging) and its mail catcher.
// Skipped unless started by apps/web/tests/run-unconfirmed-login-gotrue.mjs, which sets the URLs.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { classifyLoginError, INVALID_CREDENTIALS_MESSAGE, routeFragmentError } from './authFlow';

vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
vi.mock('@repo/api/src/root', () => ({ appRouter: { createCaller: vi.fn() } }));
vi.mock('@repo/api/src/trpc', () => ({ createTRPCContext: vi.fn() }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const authUrl = process.env.UNCONFIRMED_LOGIN_GOTRUE_URL;
const mailUrl = process.env.UNCONFIRMED_LOGIN_MAIL_URL;
const APP = 'http://127.0.0.1:3000';

function client() {
  const memory = new Map<string, string>();
  return createClient('http://gotrue.local', 'local-anon', {
    auth: {
      flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
      storage: {
        getItem: key => memory.get(key) ?? null,
        setItem: (key, value) => { memory.set(key, value); },
        removeItem: key => { memory.delete(key); },
      },
    },
    // GoTrue runs without the /auth/v1 gateway prefix locally.
    global: { fetch: (input, init) => fetch(String(input).replace('http://gotrue.local/auth/v1', authUrl!), init) },
  });
}

async function latestLink(email: string, after: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const list = await (await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    const message = list.messages?.find((m: { Created: string }) => Date.parse(m.Created) >= after);
    if (message) {
      const body = await (await fetch(`${mailUrl}/api/v1/message/${message.ID}`)).json();
      return String(body.HTML.match(/href="([^"]+)"/)[1]).replaceAll('&amp;', '&');
    }
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('confirmation mail not received');
}

describe.skipIf(!authUrl || !mailUrl)('unconfirmed email sign-in against local GoTrue', () => {
  const email = `u-${randomUUID().slice(0, 8)}@example.test`;
  const password = `Pw-${randomUUID()}`;
  const emailRedirectTo = `${APP}/auth/callback?next=%2Fprofile`;

  it('signs up and routes the correct password to the verify page by error code', async () => {
    const signUp = await client().auth.signUp({ email, password, options: { emailRedirectTo } });
    expect(signUp.error).toBeNull();
    const { error } = await client().auth.signInWithPassword({ email, password });
    expect(error).toMatchObject({ code: 'email_not_confirmed' });
    expect(classifyLoginError(error, 'x')).toEqual({ kind: 'unconfirmed' });
  });

  it('answers a wrong password and an unknown email identically, both with the resend entry', async () => {
    const wrong = await client().auth.signInWithPassword({ email, password: `${password}-x` });
    const unknown = await client().auth.signInWithPassword({ email: `nobody-${email}`, password });
    const expected = { kind: 'error', message: INVALID_CREDENTIALS_MESSAGE, offerResend: true };
    expect(wrong.error).toMatchObject({ code: 'invalid_credentials' });
    expect(classifyLoginError(wrong.error, 'x')).toEqual(expected);
    expect(classifyLoginError(unknown.error, 'x')).toEqual(expected);
  });

  it('accepts a resend for an unknown email exactly like a real one', async () => {
    const real = await client().auth.resend({ type: 'signup', email, options: { emailRedirectTo } });
    const unknown = await client().auth.resend({ type: 'signup', email: `nobody-${email}`, options: { emailRedirectTo } });
    expect(real.error).toBeNull();
    expect(unknown.error).toBeNull();
  });

  it('treats a repeat sign-up as success without changing the password', async () => {
    // The page shows the same neutral text for every successful sign-up; it never reads identities.
    const again = await client().auth.signUp({ email, password: `${password}-new`, options: { emailRedirectTo } });
    expect(again.error).toBeNull();
    const oldPassword = await client().auth.signInWithPassword({ email, password });
    const newPassword = await client().auth.signInWithPassword({ email, password: `${password}-new` });
    expect(classifyLoginError(oldPassword.error, 'x')).toEqual({ kind: 'unconfirmed' });
    expect(classifyLoginError(newPassword.error, 'x')).toMatchObject({ offerResend: true });
  });

  it('lands an expired confirmation link on the resend page with the fixed reason', async () => {
    const landingFor = async (link: string) => {
      await new Promise(done => setTimeout(done, 3500)); // the runner sets GOTRUE_MAILER_OTP_EXP to 2 seconds
      const response = await fetch(`${authUrl}/verify${new URL(link).search}`, { redirect: 'manual' });
      return new URL(response.headers.get('location')!);
    };
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://gotrue.local';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'local-anon';
    const { GET } = await import('@/app/auth/callback/route');
    const route = async (landing: URL) => new URL((await GET(new NextRequest(landing.toString()))).headers.get('location')!);

    // Sign-up link (PKCE): the error arrives as query parameters and the server routes it.
    const pkceEmail = `p-${email}`;
    const signedUpAt = Date.now() - 1000;
    await client().auth.signUp({ email: pkceEmail, password, options: { emailRedirectTo } });
    const pkceLanding = await landingFor(await latestLink(pkceEmail, signedUpAt));
    expect(pkceLanding.searchParams.get('error_code')).toBe('otp_expired');
    const pkceTo = await route(pkceLanding);
    expect(pkceTo.pathname).toBe('/verify-email');
    expect(Object.fromEntries(pkceTo.searchParams)).toEqual({ redirect: '/profile', reason: 'expired' });

    // Resent link (no PKCE): the error is only in the fragment. The server sends the visit to the
    // login page (the browser carries the fragment along) and the page routes it by the same list.
    const resentAt = Date.now() - 1000;
    await client().auth.resend({ type: 'signup', email, options: { emailRedirectTo } });
    const resentLanding = await landingFor(await latestLink(email, resentAt));
    expect(resentLanding.searchParams.get('error_code')).toBeNull();
    const resentTo = await route(resentLanding);
    expect(resentTo.pathname).toBe('/login');
    expect(Object.fromEntries(resentTo.searchParams)).toEqual({ redirect: '/profile' });
    expect(routeFragmentError(resentLanding.hash)).toEqual({ to: 'verify-expired' });
  }, 30_000);
});
