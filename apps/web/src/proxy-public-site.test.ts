/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser } }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const { proxy } = await import('./proxy');

async function get(url: string) {
  const response = await proxy(new NextRequest(url));
  const location = response.headers.get('location');
  return {
    status: response.status,
    to: location ? new URL(location) : null,
    rewrite: response.headers.get('x-middleware-rewrite'),
  };
}

const VERIFIED = { id: 'user-1', email: 'a@example.com', email_confirmed_at: '2026-10-01T00:00:00Z', app_metadata: {} };

// E1 single host (SEO_GEO_SPEC sections 2 and 15): every host follows the same path rules. The production host,
// staging, a preview deployment and local development behave alike; no host forwards to another one.
const HOSTS = ['www.graylum.com', 'auth-staging.graylum.com', 'example-preview.vercel.app', 'localhost:3000'];

// PUBLIC-SITE pages (SEO_GEO_SPEC 3.2) open without login, matched by whole path segment. The refund policy is
// public too (Owner 2026-10-17); so are the feature pages and the tutorial blog linked from the public header.
const OPEN = ['/about', '/zh-tw', '/zh-tw/', '/zh-tw/ig-jingying', '/zh-tw/about', '/refund', '/founders',
  '/graylum-vs-chatgpt', '/features', '/features/', '/features/positioning', '/features/jury', '/blog', '/blog/',
  '/blog/first-positioning-conversation', '/pricing', '/faq', '/terms', '/privacy', '/landing/preview/l'];
// Login entry pages stay at the root and open without a session, so email links work (SEO_GEO_SPEC section 2).
const LOGIN_ENTRY = ['/login', '/register', '/verify-email', '/forgot-password', '/reset-password', '/auth/callback'];
const LOOKALIKES = ['/zh-twx', '/zh-tw-admin', '/aboutx', '/about-us', '/refunds', '/refund-policy', '/founders-x',
  '/graylum-vs-chatgptx', '/featuresx', '/features-admin', '/feature', '/blogs', '/blog-admin', '/apps', '/application'];
const LOGGED_IN = ['/app', '/app/', '/app/profile', '/app/positioning', '/app/positioning/draft-1/topics', '/app/library',
  '/app/runtime', '/app/workbench/search', '/app/publish-monitor/connect', '/app/expert-consult', '/admin', '/admin/users'];

beforeEach(() => {
  getUser.mockResolvedValue({ data: { user: null } });
  vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('public pages on every host', () => {
  it.each(HOSTS)('serves the public pages and login entry pages on %s without login', async host => {
    for (const path of [...OPEN, ...LOGIN_ENTRY]) {
      expect(await get(`https://${host}${path}`), path).toMatchObject({ status: 200, to: null });
    }
  });

  it.each(HOSTS)('serves the public home page at the root of %s, logged out or in', async host => {
    for (const user of [null, VERIFIED]) {
      getUser.mockResolvedValue({ data: { user } });
      const { status, to, rewrite } = await get(`https://${host}/`);
      expect(status).toBe(200);
      expect(to).toBeNull();
      expect(new URL(rewrite!).pathname).toBe('/landing');
    }
  });
});

describe('logged-in pages on every host', () => {
  it.each(HOSTS)('sends a logged-out visitor on %s to login on the same host and back afterwards', async host => {
    for (const path of [...LOGGED_IN, ...LOOKALIKES]) {
      const { status, to } = await get(`https://${host}${path}?tab=x`);
      expect(status, path).toBe(307);
      expect(to?.host, path).toBe(host);
      expect(to?.pathname, path).toBe('/login');
      expect(to?.searchParams.get('redirect'), path).toBe(`${path}?tab=x`);
    }
  });

  it.each(HOSTS)('lets a verified user on %s open /app pages', async host => {
    getUser.mockResolvedValue({ data: { user: VERIFIED } });
    for (const path of LOGGED_IN.filter(path => path.startsWith('/app'))) {
      expect(await get(`https://${host}${path}`), path).toMatchObject({ status: 200, to: null });
    }
  });

  it('sends an unverified user to the verify page with the page as the return target', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'user-2', email: 'b@example.com', app_metadata: {} } } });
    const { status, to } = await get('https://www.graylum.com/app/library?item=1');
    expect(status).toBe(307);
    expect(to?.pathname).toBe('/verify-email');
    expect(to?.searchParams.get('redirect')).toBe('/app/library?item=1');
  });
});

describe('login pages for a user who is already logged in', () => {
  it('goes to the requested page, moving an old root address under /app', async () => {
    getUser.mockResolvedValue({ data: { user: VERIFIED } });
    const cases: Array<[string | null, string]> = [
      ['/positioning/draft-1?step=2', '/app/positioning/draft-1?step=2'],
      ['/app/library', '/app/library'],
      ['/', '/app'],
      ['/chat?conversation=old', '/app/positioning?conversation=old'],
      ['https://evil.example/x', '/app/profile'],
      [null, '/app/profile'],
    ];
    for (const [redirect, expected] of cases) {
      const query = redirect === null ? '' : `?redirect=${encodeURIComponent(redirect)}`;
      const { status, to } = await get(`https://www.graylum.com/login${query}`);
      expect(status, String(redirect)).toBe(307);
      expect(`${to?.pathname}${to?.search}`, String(redirect)).toBe(expected);
    }
  });
});
