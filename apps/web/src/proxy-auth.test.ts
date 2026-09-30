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

describe('proxy login requirement by host', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: null } });
  });

  it('sends anonymous visitors on every app host to login', async () => {
    for (const host of ['auth-staging.graylum.com', 'graylumai-staging.vercel.app', 'app.graylum.com', 'new.example.com']) {
      expect(await get(`https://${host}/profile`)).toEqual({
        status: 307,
        location: `https://${host}/login?redirect=%2Fprofile`,
      });
    }
  });

  it('sends a verified user away from login on the staging domain', async () => {
    getUser.mockResolvedValue({ data: { user: { email: 'a@example.com', email_confirmed_at: '2026-09-30T00:00:00Z' } } });
    expect(await get('https://auth-staging.graylum.com/login?redirect=%2Fprofile')).toEqual({
      status: 307,
      location: 'https://auth-staging.graylum.com/profile',
    });
  });

  it('keeps public pages open on the staging domain', async () => {
    for (const path of ['/login', '/verify-email', '/landing']) {
      expect((await get(`https://auth-staging.graylum.com${path}`)).status).toBe(200);
    }
  });

  it('keeps the public site public without treating look-alike hosts as it', async () => {
    expect((await get('https://www.graylum.com/landing')).status).toBe(200);
    expect(await get('https://evilgraylum.com/landing')).toEqual({ status: 200, location: null });
    expect(await get('https://evilgraylum.com/profile')).toEqual({
      status: 307,
      location: 'https://evilgraylum.com/login?redirect=%2Fprofile',
    });
  });
});
