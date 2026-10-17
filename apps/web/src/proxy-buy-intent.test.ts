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
  return { status: response.status, to: location ? new URL(location) : null };
}

const GOLD_MONTHLY = '/profile?tab=subscription&buy=gold&cycle=monthly';
const VERIFIED = { email: 'a@example.com', email_confirmed_at: '2026-10-01T00:00:00Z' };

// Owner 2026-10-17: a logged-out visitor who picks a plan on the landing page goes to sign-up (login is one click
// away there) and comes back to that plan's checkout dialog. Only the allowed plan values come back.
describe('landing-page buy links for logged-out visitors', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: null } });
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('opens sign-up and keeps the plan on app hosts and local dev', async () => {
    for (const origin of ['https://auth-staging.graylum.com', 'https://app.graylum.com', 'http://localhost:3000']) {
      const { status, to } = await get(`${origin}${GOLD_MONTHLY}`);
      expect(status, origin).toBe(307);
      expect(to?.origin, origin).toBe(origin);
      expect(to?.pathname, origin).toBe('/login');
      expect(to?.searchParams.get('action'), origin).toBe('signup');
      expect(to?.searchParams.get('redirect'), origin).toBe(GOLD_MONTHLY);
    }
  });

  it('keeps a listed offer and the yearly cycle', async () => {
    const { to } = await get('https://auth-staging.graylum.com/profile?buy=pro&cycle=yearly&offer=founder');
    expect(to?.searchParams.get('redirect')).toBe('/profile?tab=subscription&buy=pro&cycle=yearly&offer=founder');
  });

  it('rebuilds the return path so nothing else from the link rides along', async () => {
    const { to } = await get('https://auth-staging.graylum.com/profile?tab=subscription&buy=gold&cycle=monthly'
      + '&offer=free99&next=https%3A%2F%2Fevil.example&redirect=%2F%2Fevil.example&tab=admin#x');
    expect(to?.searchParams.get('action')).toBe('signup');
    expect(to?.searchParams.get('redirect')).toBe(GOLD_MONTHLY);
    expect(to?.searchParams.getAll('redirect')).toHaveLength(1);
    expect(to?.searchParams.has('next')).toBe(false);
  });

  it('treats malformed or off-page buy params as an ordinary login', async () => {
    const cases = ['/profile?tab=subscription&buy=platinum&cycle=monthly', '/profile?buy=gold&cycle=weekly',
      '/profile?buy=gold', '/positioning?buy=gold&cycle=monthly', '/profile/settings?buy=gold&cycle=monthly'];
    for (const path of cases) {
      const { status, to } = await get(`https://auth-staging.graylum.com${path}`);
      expect(status, path).toBe(307);
      expect(to?.pathname, path).toBe('/login');
      expect(to?.searchParams.has('action'), path).toBe(false);
      expect(to?.searchParams.get('redirect'), path).toBe(path);
    }
  });

  it('forwards a buy link on the public site to the app host with the same path', async () => {
    const { status, to } = await get(`https://www.graylum.com${GOLD_MONTHLY}`);
    expect(status).toBe(307);
    expect(to?.hostname).toBe('app.graylum.com');
    expect(`${to?.pathname}${to?.search}`).toBe(GOLD_MONTHLY);
  });

  it('leaves the signed-in direct link (#961) untouched', async () => {
    getUser.mockResolvedValue({ data: { user: VERIFIED } });
    expect(await get(`https://auth-staging.graylum.com${GOLD_MONTHLY}`)).toEqual({ status: 200, to: null });
  });

  it('still sends a signed-in but unverified visitor to verify the email first, plan kept', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'a@example.com', email_confirmed_at: null } } });
    const { to } = await get(`https://auth-staging.graylum.com${GOLD_MONTHLY}`);
    expect(to?.pathname).toBe('/verify-email');
    expect(to?.searchParams.get('redirect')).toBe(GOLD_MONTHLY);
  });

  it('sends a signed-in visitor who reopens the sign-up link straight back to the plan', async () => {
    getUser.mockResolvedValue({ data: { user: VERIFIED } });
    const { to } = await get(`https://auth-staging.graylum.com/login?action=signup&redirect=${encodeURIComponent(GOLD_MONTHLY)}`);
    expect(`${to?.pathname}${to?.search}`).toBe(GOLD_MONTHLY);
    const evil = await get('https://auth-staging.graylum.com/login?action=signup&redirect=%2F%2Fevil.example');
    expect(evil.to?.origin).toBe('https://auth-staging.graylum.com');
    expect(evil.to?.pathname).toBe('/profile');
  });
});
