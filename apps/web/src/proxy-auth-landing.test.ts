import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  return { status: response.status, to: location ? decodeURIComponent(location) : null };
}

const APP = 'https://graylumai-staging.vercel.app';

describe('proxy handling of GoTrue landings', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: null } });
  });

  it('forwards a code on the Site URL root to the server callback', async () => {
    expect(await get(`${APP}/?code=abc`)).toEqual({ status: 307, to: `${APP}/auth/callback?code=abc&next=/profile` });
  });

  it('keeps a code on any other page for that page, as before', async () => {
    expect(await get(`${APP}/library?item=1&code=abc`)).toEqual({
      status: 307,
      to: `${APP}/login?redirect=/library?item=1&code=abc`,
    });
    getUser.mockResolvedValue({ data: { user: { email: 'a@example.test', email_confirmed_at: '2026-09-30T00:00:00Z' } } });
    expect(await get(`${APP}/profile?code=abc`)).toEqual({ status: 200, to: null });
  });

  it('leaves the callback itself and API routes alone', async () => {
    expect((await get(`${APP}/auth/callback?code=abc`)).status).toBe(200);
    expect((await get(`${APP}/api/health?code=abc`)).to).toBeNull();
  });

  it('forwards a code on the public site root to the app callback without losing it', async () => {
    expect(await get('https://www.graylum.com/?code=abc')).toEqual({
      status: 307,
      to: 'https://www.graylum.com/auth/callback?code=abc&next=/profile',
    });
    // The public site then sends its /auth/callback, query included, to the app domain.
    expect(await get('https://www.graylum.com/auth/callback?code=abc&next=%2Fprofile')).toEqual({
      status: 307,
      to: 'https://app.graylum.com/auth/callback?code=abc&next=/profile',
    });
  });

  it('sends an expired-link landing on the root straight to the resend page', async () => {
    const landing = `${APP}/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid`;
    expect(await get(landing)).toEqual({ status: 307, to: `${APP}/verify-email?redirect=/profile&reason=expired` });
    // The resend page itself carries no error parameters, so it cannot loop back here.
    expect((await get(`${APP}/verify-email?redirect=%2Fprofile&reason=expired`)).status).toBe(200);
  });

  it('keeps the existing handling for other errors on the root', async () => {
    expect(await get(`${APP}/?error=access_denied&error_code=unexpected_failure`)).toEqual({
      status: 307,
      to: `${APP}/login?redirect=/?error=access_denied&error_code=unexpected_failure`,
    });
  });

  it('never sends a signed-in user from login to a target that still carries GoTrue errors', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'a@example.test', email_confirmed_at: '2026-09-30T00:00:00Z' } } });
    const redirect = encodeURIComponent('/?error=access_denied&error_code=otp_expired');
    expect(await get(`${APP}/login?redirect=${redirect}`)).toEqual({ status: 307, to: `${APP}/profile` });
  });
});
