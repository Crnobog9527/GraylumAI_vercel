/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
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

describe('public pricing page routes (moved from /landing/pricing to /pricing on 2026-10-18)', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: null } });
  });

  it('serves /pricing itself without login on the public site, the app host and the local www simulation', async () => {
    for (const url of ['https://www.graylum.com/pricing', 'https://auth-staging.graylum.com/pricing', 'http://localhost:3000/pricing',
      'http://localhost:3000/pricing?domain=www']) {
      expect(await get(url), url).toEqual({ status: 200, to: null });
    }
  });

  it('sends /plans on the public site to the pricing page, keeping the query', async () => {
    for (const path of ['/plans', '/plans/']) {
      expect(await get(`https://www.graylum.com${path}`)).toEqual({ status: 307, to: 'https://www.graylum.com/pricing' });
    }
    expect(await get('http://localhost:3000/plans?domain=www')).toEqual({ status: 307, to: 'http://localhost:3000/pricing?domain=www' });
  });

  it('does not make lookalike paths public', async () => {
    const { to } = await get('https://www.graylum.com/pricing-old');
    expect(to).not.toBe('https://www.graylum.com/pricing');
    expect(to).not.toBeNull();
    // On the app host, a lookalike still asks a logged-out visitor to log in.
    expect((await get('https://auth-staging.graylum.com/pricing-old')).to).toContain('/login');
  });
});
