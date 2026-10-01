// End-to-end against the disposable local GoTrue started by apps/web/tests/run-unconfirmed-login-gotrue.mjs:
// a confirmation link whose PKCE code cannot be exchanged in the browser that opens it, and a code
// that lands on the Site URL root. Skipped unless the runner sets the URLs.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { classifyCodeExchangeError } from './authFlow';

// The callback route's server client exchanges codes through whichever "browser" the test picks.
const browser = vi.hoisted(() => ({ current: null as null | { auth: { exchangeCodeForSession(code: string): unknown } } }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      exchangeCodeForSession: (code: string) => browser.current!.auth.exchangeCodeForSession(code),
    },
  }),
}));
vi.mock('@repo/api/src/root', () => ({ appRouter: { createCaller: vi.fn() } }));
vi.mock('@repo/api/src/trpc', () => ({ createTRPCContext: vi.fn() }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));

const authUrl = process.env.UNCONFIRMED_LOGIN_GOTRUE_URL;
const mailUrl = process.env.UNCONFIRMED_LOGIN_MAIL_URL;
const APP = 'http://127.0.0.1:3000';
const emailRedirectTo = `${APP}/auth/callback?next=%2Fprofile`;

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
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error('confirmation mail not received');
}

// Opens the link the way a mail client does and returns where GoTrue sends the browser.
async function openLink(link: string) {
  const response = await fetch(`${authUrl}/verify${new URL(link).search}`, { redirect: 'manual' });
  return new URL(response.headers.get('location')!);
}

async function signUpAndOpen(signUpIn: ReturnType<typeof browserClient>, email: string, password: string, redirect = emailRedirectTo) {
  const sentAt = Date.now() - 1000;
  const signUp = await signUpIn.auth.signUp({ email, password, options: { emailRedirectTo: redirect } });
  expect(signUp.error).toBeNull();
  return openLink(await latestLink(email, sentAt));
}

async function callback(landing: URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://gotrue.local';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'local-anon';
  const { GET } = await import('@/app/auth/callback/route');
  return new URL((await GET(new NextRequest(landing.toString()))).headers.get('location')!);
}

async function signsIn(email: string, password: string) {
  const { data, error } = await browserClient().auth.signInWithPassword({ email, password });
  return !error && Boolean(data.user?.email_confirmed_at);
}

describe.skipIf(!authUrl || !mailUrl).sequential('confirmation link that cannot be exchanged where it is opened', () => {
  const password = `Pw-${randomUUID()}`;
  const id = randomUUID().slice(0, 8);

  it('opened in another browser: email confirmed, callback asks for a password login', async () => {
    const email = `other-${id}@example.test`;
    const landing = await signUpAndOpen(browserClient(), email, password);
    expect(landing.pathname).toBe('/auth/callback');
    expect(landing.searchParams.get('code')).toBeTruthy();

    browser.current = browserClient(); // no verifier: a different browser or device
    const to = await callback(landing);
    expect(to.pathname).toBe('/login');
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'link_needs_login', redirect: '/profile' });
    expect(await signsIn(email, password)).toBe(true);
  });

  it('stale verifier in the same browser: GoTrue rejects the challenge, the email is still confirmed', async () => {
    const same = browserClient();
    const first = `stale-a-${id}@example.test`;
    const sentAt = Date.now() - 1000;
    expect((await same.auth.signUp({ email: first, password, options: { emailRedirectTo } })).error).toBeNull();
    const firstLink = await latestLink(first, sentAt);
    // A later flow in the same browser replaces the verifier, as an older duplicate cookie read first would.
    expect((await same.auth.signUp({ email: `stale-b-${id}@example.test`, password, options: { emailRedirectTo } })).error).toBeNull();
    const landing = await openLink(firstLink);

    const exchange = await same.auth.exchangeCodeForSession(landing.searchParams.get('code')!);
    expect(exchange.error?.message).toMatch(/code challenge does not match/i);
    expect(classifyCodeExchangeError(exchange.error)).toBe('link_needs_login');
    expect(await signsIn(first, password)).toBe(true);
  });

  it('same email signed up twice in one browser: the latest link exchanges with the current verifier', async () => {
    const same = browserClient();
    const email = `twice-${id}@example.test`;
    expect((await same.auth.signUp({ email, password, options: { emailRedirectTo } })).error).toBeNull();
    await new Promise(done => setTimeout(done, 2500)); // so the second mail is told apart from the first
    const landing = await signUpAndOpen(same, email, password);
    const exchange = await same.auth.exchangeCodeForSession(landing.searchParams.get('code')!);
    expect(exchange.error).toBeNull();
    expect(exchange.data.session).toBeTruthy();
  });

  it('a redirect GoTrue does not accept lands the code on the Site URL root, which the proxy hands to the callback', async () => {
    const email = `root-${id}@example.test`;
    const landing = await signUpAndOpen(browserClient(), email, password, 'http://not-allowed.example/auth/callback');
    expect(`${landing.origin}${landing.pathname}`).toBe(`${APP}/`);
    const code = landing.searchParams.get('code');
    expect(code).toBeTruthy();

    const { proxy } = await import('@/proxy');
    const forwarded = await proxy(new NextRequest(landing.toString()));
    const to = new URL(forwarded.headers.get('location')!);
    expect(to.pathname).toBe('/auth/callback');
    expect(Object.fromEntries(to.searchParams)).toEqual({ code, next: '/profile' });
  });
});
