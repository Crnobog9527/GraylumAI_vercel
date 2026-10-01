// End-to-end against the disposable local GoTrue started by apps/web/tests/run-unconfirmed-login-gotrue.mjs
// (same GoTrue version as staging): the forgot-password request, the reset link through the real
// /auth/callback route, the new password, and the denied paths (reused link, other browser, banned
// account). Skipped unless the runner sets the URLs.
import { createHmac, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { classifyLoginError } from './authFlow';
import {
  buildRecoveryRedirectUrl,
  classifyPasswordUpdateError,
  isFreshRecoverySession,
} from './passwordRecovery';

// The callback route's server client acts as whichever simulated browser opens the link.
const browser = vi.hoisted(() => ({ current: null as null | SupabaseClient }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => browser.current ? browser.current.auth.getUser() : { data: { user: null } },
      exchangeCodeForSession: (code: string) => browser.current!.auth.exchangeCodeForSession(code),
    },
  }),
}));
vi.mock('@repo/api/src/root', () => ({ appRouter: { createCaller: vi.fn() } }));
vi.mock('@repo/api/src/trpc', () => ({ createTRPCContext: vi.fn() }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const authUrl = process.env.UNCONFIRMED_LOGIN_GOTRUE_URL;
const mailUrl = process.env.UNCONFIRMED_LOGIN_MAIL_URL;
const jwtSecret = process.env.UNCONFIRMED_LOGIN_GOTRUE_JWT_SECRET;
const APP = 'http://127.0.0.1:3000';
const redirectTo = buildRecoveryRedirectUrl(APP);

// One client per simulated browser; its storage holds that browser's PKCE code verifier.
function browserClient() {
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

function serviceToken() {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 600 })}`;
  return `${body}.${createHmac('sha256', jwtSecret!).update(body).digest('base64url')}`;
}

async function admin(path: string, method: string, body: object) {
  const response = await fetch(`${authUrl}/admin/${path}`, {
    method,
    headers: { authorization: `Bearer ${serviceToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json();
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
  throw new Error('reset mail not received');
}

// Requests a reset in `requester` and follows the mailed link to where GoTrue sends the browser.
async function requestAndOpenLink(requester: SupabaseClient, email: string) {
  const sentAt = Date.now() - 1000;
  const { error } = await requester.auth.resetPasswordForEmail(email, { redirectTo });
  expect(error).toBeNull();
  const link = await latestLink(email, sentAt);
  // The runner expires links after 2 seconds, so the link is opened right away.
  const response = await fetch(`${authUrl}/verify${new URL(link).search}`, { redirect: 'manual' });
  return { link, landing: new URL(response.headers.get('location')!) };
}

async function routeCallback(landing: URL, opener: SupabaseClient | null) {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://gotrue.local';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'local-anon';
  const { GET } = await import('@/app/auth/callback/route');
  browser.current = opener;
  const to = new URL((await GET(new NextRequest(landing.toString()))).headers.get('location')!);
  return `${to.pathname}${to.search}`;
}

describe.skipIf(!authUrl || !mailUrl || !jwtSecret)('password reset against local GoTrue', () => {
  const tag = randomUUID().slice(0, 8);
  const password = `Old-${randomUUID()}`;
  const newPassword = `New-${randomUUID()}`;

  it('answers a request for an unknown email exactly like a registered one', async () => {
    const email = `r-${tag}@example.test`;
    await admin('users', 'POST', { email, password, email_confirm: true });
    const known = await browserClient().auth.resetPasswordForEmail(email, { redirectTo });
    const unknown = await browserClient().auth.resetPasswordForEmail(`nobody-${tag}@example.test`, { redirectTo });
    expect(known).toEqual(unknown);
    expect(known.error).toBeNull();
  });

  it('resets the password through the callback in the requesting browser, once', async () => {
    const email = `ok-${tag}@example.test`;
    await admin('users', 'POST', { email, password, email_confirm: true });
    // Another device signed in before the reset.
    const otherDevice = browserClient();
    expect((await otherDevice.auth.signInWithPassword({ email, password })).error).toBeNull();
    const requester = browserClient();
    const { link, landing } = await requestAndOpenLink(requester, email);
    expect(landing.pathname).toBe('/auth/callback');
    expect(landing.searchParams.get('flow')).toBe('recovery');
    expect(landing.searchParams.get('code')).toBeTruthy();

    expect(await routeCallback(landing, requester)).toBe('/reset-password');
    const { data: level } = await requester.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(isFreshRecoverySession(level?.currentAuthenticationMethods, Date.now() / 1000)).toBe(true);

    const same = await requester.auth.updateUser({ password });
    expect(classifyPasswordUpdateError(same.error)).toEqual({ kind: 'error', message: '新密码不能和原来的密码相同。' });
    expect((await requester.auth.updateUser({ password: newPassword })).error).toBeNull();
    expect((await requester.auth.signOut({ scope: 'global' })).error).toBeNull();
    // The session from before the reset can neither be used nor refreshed any more.
    expect((await otherDevice.auth.getUser()).data.user).toBeNull();
    expect((await otherDevice.auth.refreshSession()).error).not.toBeNull();

    const oldLogin = await browserClient().auth.signInWithPassword({ email, password });
    expect(classifyLoginError(oldLogin.error, 'x')).toMatchObject({ kind: 'error', offerResend: true });
    const fresh = browserClient();
    expect((await fresh.auth.signInWithPassword({ email, password: newPassword })).error).toBeNull();
    // A normal sign-in never unlocks the new-password page.
    const { data: passwordLevel } = await fresh.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(isFreshRecoverySession(passwordLevel?.currentAuthenticationMethods, Date.now() / 1000)).toBe(false);

    // The same link again is refused and lands on the request page.
    const reused = await fetch(`${authUrl}/verify${new URL(link).search}`, { redirect: 'manual' });
    expect(await routeCallback(new URL(reused.headers.get('location')!), browserClient())).toBe('/forgot-password?reason=expired');
  });

  it('sends a link opened in another browser back to the request page without a session', async () => {
    const email = `other-${tag}@example.test`;
    await admin('users', 'POST', { email, password, email_confirm: true });
    const { landing } = await requestAndOpenLink(browserClient(), email);
    const other = browserClient();
    expect(await routeCallback(landing, other)).toBe('/forgot-password?reason=browser');
    expect((await other.auth.getUser()).data.user).toBeNull();
  });

  it('never gives a banned account a session, and its old password still cannot sign in', async () => {
    const email = `ban-${tag}@example.test`;
    const user = await admin('users', 'POST', { email, password, email_confirm: true });
    await admin(`users/${user.id}`, 'PUT', { ban_duration: '24h' });
    const requester = browserClient();
    const { landing } = await requestAndOpenLink(requester, email);
    expect(landing.searchParams.get('code')).toBeNull();
    expect(await routeCallback(landing, requester)).toBe('/forgot-password?reason=expired');
    expect((await requester.auth.getUser()).data.user).toBeNull();
    const login = await browserClient().auth.signInWithPassword({ email, password });
    expect(login.error).toMatchObject({ code: 'user_banned' });
  });
});
