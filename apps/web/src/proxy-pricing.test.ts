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

describe('public pricing entry routes', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: null } });
  });

  it('sends /pricing and /plans on the public site to the pricing page', async () => {
    for (const path of ['/pricing', '/plans', '/pricing/']) {
      expect(await get(`https://www.graylum.com${path}`)).toEqual({ status: 307, to: 'https://www.graylum.com/landing/pricing' });
    }
  });

  it('keeps the local www simulation parameter', async () => {
    expect(await get('http://localhost:3000/pricing?domain=www')).toEqual({
      status: 307, to: 'http://localhost:3000/landing/pricing?domain=www',
    });
  });

  it('serves the pricing page itself on the public site without login', async () => {
    expect(await get('https://www.graylum.com/landing/pricing')).toEqual({ status: 200, to: null });
  });

  it('does not redirect lookalike paths', async () => {
    expect((await get('https://www.graylum.com/pricing-old')).to).not.toBe('https://www.graylum.com/landing/pricing');
  });
});
