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

// PUBLIC-SITE pages (SEO_GEO_SPEC 3.2): About and the Taiwan section open without login, matched by whole
// path segment; everything else keeps its existing protection.
const OPEN = ['/about', '/zh-tw', '/zh-tw/', '/zh-tw/ig-jingying', '/zh-tw/about'];
const LOOKALIKES = ['/zh-twx', '/zh-tw-admin', '/aboutx', '/about-us'];
const LOGGED_IN = ['/profile', '/positioning', '/library'];

describe('PUBLIC-SITE pages without login', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: null } });
    // Fix the app host so the redirect target does not depend on the caller's shell.
    vi.stubEnv('NEXT_PUBLIC_AUTH_APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves About and the Taiwan pages on the public host', async () => {
    for (const path of OPEN) {
      expect(await get(`https://www.graylum.com${path}`), path).toEqual({ status: 200, to: null });
    }
  });

  it('still sends other paths on the public host to the app domain', async () => {
    for (const path of [...LOOKALIKES, ...LOGGED_IN]) {
      const { status, to } = await get(`https://www.graylum.com${path}`);
      expect(status, path).toBe(307);
      expect(to?.hostname, path).toBe('app.graylum.com');
      expect(to?.pathname, path).toBe(path);
    }
  });

  it('serves About and the Taiwan pages on an app host such as staging', async () => {
    for (const path of OPEN) {
      expect(await get(`https://auth-staging.graylum.com${path}`), path).toEqual({ status: 200, to: null });
    }
  });

  it('still sends logged-out visitors on an app host to login for every other path', async () => {
    for (const path of [...LOOKALIKES, ...LOGGED_IN]) {
      const { status, to } = await get(`https://auth-staging.graylum.com${path}`);
      expect(status, path).toBe(307);
      expect(to?.pathname, path).toBe('/login');
      expect(to?.searchParams.get('redirect'), path).toBe(path);
    }
  });
});
