import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser } }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const { proxy } = await import('./proxy');

async function get(url: string) {
  const response = await proxy(new NextRequest(url));
  return { status: response.status, location: response.headers.get('location') };
}

describe('proxy login requirement on every host', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: null } });
  });

  it('sends anonymous visitors on every host to login on that host', async () => {
    for (const host of ['www.graylum.com', 'auth-staging.graylum.com', 'example-preview.vercel.app', 'app.graylum.com',
      'new.example.com']) {
      expect(await get(`https://${host}/app/profile`)).toEqual({
        status: 307,
        location: `https://${host}/login?redirect=%2Fapp%2Fprofile`,
      });
    }
  });

  it('sends a verified user away from login on the staging domain', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'a@example.com', email_confirmed_at: '2026-09-30T00:00:00Z' } } });
    expect(await get('https://auth-staging.graylum.com/login?redirect=%2Fapp%2Fprofile')).toEqual({
      status: 307,
      location: 'https://auth-staging.graylum.com/app/profile',
    });
    // A return target saved before the /app move still lands on the moved page.
    expect(await get('https://www.graylum.com/login?redirect=%2Fprofile%3Ftab%3Dx')).toEqual({
      status: 307,
      location: 'https://www.graylum.com/app/profile?tab=x',
    });
  });

  it('sends an unverified user to the verify page without the email in the URL', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'a+b@example.com', email_confirmed_at: null } } });
    const cases = [
      ['https://auth-staging.graylum.com/app/profile?tab=x', 'https://auth-staging.graylum.com/verify-email?redirect=%2Fapp%2Fprofile%3Ftab%3Dx'],
      // An old return target is moved under /app before it is passed on.
      ['https://auth-staging.graylum.com/login?redirect=%2Fpositioning', 'https://auth-staging.graylum.com/verify-email?redirect=%2Fapp%2Fpositioning'],
      ['http://localhost:3000/app/profile', 'http://localhost:3000/verify-email?redirect=%2Fapp%2Fprofile'],
      ['https://www.graylum.com/login?redirect=%2Fprofile', 'https://www.graylum.com/verify-email?redirect=%2Fapp%2Fprofile'],
    ];
    for (const [from, location] of cases) {
      expect(await get(from)).toEqual({ status: 307, location });
    }
  });

  it('keeps public pages open on the staging domain', async () => {
    for (const path of ['/login', '/verify-email', '/landing', '/forgot-password', '/reset-password']) {
      expect((await get(`https://auth-staging.graylum.com${path}`)).status).toBe(200);
    }
  });

  it('lets a signed-in user open the reset pages instead of bouncing them like the login page', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'a@example.com', email_confirmed_at: '2026-09-30T00:00:00Z' } } });
    for (const path of ['/forgot-password', '/reset-password']) {
      expect(await get(`https://auth-staging.graylum.com${path}`)).toEqual({ status: 200, location: null });
    }
  });

  it('treats every host alike, look-alike hosts included', async () => {
    for (const host of ['www.graylum.com', 'evilgraylum.com']) {
      expect(await get(`https://${host}/landing/preview/l`)).toEqual({ status: 200, location: null });
      expect(await get(`https://${host}/app/profile`)).toEqual({
        status: 307,
        location: `https://${host}/login?redirect=%2Fapp%2Fprofile`,
      });
    }
  });

  it('serves login and sign-up on the production host itself instead of forwarding them', async () => {
    for (const path of ['/login?action=signup', '/register', '/verify-email', '/forgot-password']) {
      expect(await get(`https://www.graylum.com${path}`), path).toEqual({ status: 200, location: null });
    }
  });
});
