/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
const role = vi.fn();
const maintenanceValue = vi.fn();
const query = (result: () => unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => result() }) }) });
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser }, from: () => query(() => ({ data: { role: role() } })) }),
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => query(() => ({ data: { value: maintenanceValue() }, error: null })) }),
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));

const VERIFIED = { id: 'user-1', email: 'a@example.com', email_confirmed_at: '2026-10-01T00:00:00Z', app_metadata: {} };

async function get(url: string) {
  // A fresh module per request: the maintenance switch is cached for a few seconds inside the proxy.
  vi.resetModules();
  const { proxy } = await import('./proxy');
  const response = await proxy(new NextRequest(url));
  const location = response.headers.get('location');
  return { status: response.status, to: location ? new URL(location) : null };
}

// With the single host (E1) maintenance applies by path: public site pages stay readable, as the public host was
// before; logged-in and login pages wait on the maintenance page; admins keep working.
describe('maintenance mode on the single host', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    maintenanceValue.mockReturnValue(true);
    role.mockReturnValue('user');
    getUser.mockResolvedValue({ data: { user: VERIFIED } });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps public pages, the API and the maintenance page itself open', async () => {
    for (const path of ['/', '/pricing', '/zh-tw/about', '/blog', '/api/health', '/maintenance']) {
      expect((await get(`https://www.graylum.com${path}`)).to, path).toBeNull();
    }
  });

  it('sends a non-admin on a logged-in or login page to the maintenance page with the way back', async () => {
    for (const path of ['/app/positioning', '/app', '/login']) {
      const { status, to } = await get(`https://www.graylum.com${path}?x=1`);
      expect(status, path).toBe(307);
      expect(to?.pathname, path).toBe('/maintenance');
      expect(to?.searchParams.get('from'), path).toBe(`${path}?x=1`);
    }
  });

  it('lets an admin keep working and sends them from the maintenance page to admin', async () => {
    role.mockReturnValue('admin');
    expect((await get('https://www.graylum.com/app/positioning')).to).toBeNull();
    const { status, to } = await get('https://www.graylum.com/maintenance');
    expect(status).toBe(307);
    expect(to?.pathname).toBe('/admin');
  });
});
