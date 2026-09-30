import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveAuthCallbackOrigin } from '@/lib/site-config';

const auth = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth }) }));
vi.mock('@repo/api/src/root', () => ({ appRouter: { createCaller: vi.fn() } }));
vi.mock('@repo/api/src/trpc', () => ({ createTRPCContext: vi.fn() }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const { GET } = await import('./route');
const callback = async (query: string) => {
  const response = await GET(new NextRequest(`http://127.0.0.1:3000/auth/callback?${query}`));
  return new URL(response.headers.get('location') ?? '');
};

describe('auth callback origin', () => {
  it('keeps callback redirects on the request host for Preview and localhost', () => {
    expect(resolveAuthCallbackOrigin(new URL('https://preview.example.vercel.app/auth/callback'))).toBe(
      'https://preview.example.vercel.app',
    );
    expect(resolveAuthCallbackOrigin(new URL('http://127.0.0.1:3000/auth/callback'))).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('normalizes production public-domain requests to the app auth origin', () => {
    expect(resolveAuthCallbackOrigin(new URL('https://www.graylum.com/auth/callback'))).toBe(
      'https://app.graylum.com',
    );
  });
});

describe('auth callback link errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getUser.mockResolvedValue({ data: { user: null } });
  });

  it('sends an expired email link to the resend page with a fixed reason only', async () => {
    const to = await callback('error=access_denied&error_code=otp_expired'
      + '&error_description=%E8%AF%B7%E8%81%94%E7%B3%BB%E5%AE%A2%E6%9C%8D&next=%2Fprofile');
    expect(to.pathname).toBe('/verify-email');
    expect(Object.fromEntries(to.searchParams)).toEqual({ redirect: '/profile', reason: 'expired' });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('sends other link errors to the login page with a code, never the provider text', async () => {
    const to = await callback('error=access_denied&error_description=Pay+here&next=%2F');
    expect(to.pathname).toBe('/login');
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'callback_failed' });
  });

  it('uses the same login error code when the code exchange fails', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: new Error('bad code') });
    const to = await callback('code=abc&next=%2F');
    expect(to.pathname).toBe('/login');
    expect(Object.fromEntries(to.searchParams)).toEqual({ error: 'callback_failed' });
  });

  it('sends a visit without session to the login page, where a fragment error is read', async () => {
    const to = await callback('next=%2Fprofile');
    expect(to.pathname).toBe('/login');
    expect(Object.fromEntries(to.searchParams)).toEqual({ redirect: '/profile' });
  });

  it('still sends a signed-in unverified user to the verify page with the email', async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: null });
    auth.getUser.mockResolvedValue({ data: { user: { email: 'a@example.test', email_confirmed_at: null } } });
    const to = await callback('code=abc&next=%2Fprofile');
    expect(to.pathname).toBe('/verify-email');
    expect(Object.fromEntries(to.searchParams)).toEqual({ email: 'a@example.test', redirect: '/profile' });
  });
});
