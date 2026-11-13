/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ context: vi.fn(), limit: vi.fn(), start: vi.fn(), finish: vi.fn() }));
vi.mock('@/lib/shotviva-connect', async (original) => ({
  ...(await original<typeof import('@/lib/shotviva-connect')>()), shotvivaRouteContext: mocks.context, limitShotvivaStep: mocks.limit,
}));
vi.mock('@repo/api/src/services/connectors/shotviva/connect', async (original) => ({
  ...(await original<typeof import('@repo/api/src/services/connectors/shotviva/connect')>()),
  startShotvivaConnect: mocks.start, finishShotvivaConnect: mocks.finish,
}));
import { POST } from './connect/route';
import { GET } from './callback/route';
import { ShotvivaConnectError } from '@repo/api/src/services/connectors/shotviva/connect';

const me = '00000000-0000-4000-8000-000000000001';
const SITE = 'https://www.graylum.com';
const post = (origin: string | null = SITE) => new NextRequest(`${SITE}/api/connectors/shotviva/connect`,
  { method: 'POST', headers: origin ? { origin } : {} });
const back = (query: string, cookie?: string) => new NextRequest(`${SITE}/api/connectors/shotviva/callback?${query}`,
  { headers: cookie ? { cookie: `gl_shotviva_state=${cookie}` } : {} });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ admin: {}, profileId: me, baseUrl: 'https://shotviva.test' });
  mocks.limit.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ redirectUrl: 'https://shotviva.test/connect/graylum?state=s', cookie: `${me}.s` });
  mocks.finish.mockResolvedValue({ accountId: 'x' });
});

describe('POST /api/connectors/shotviva/connect', () => {
  it('answers the authorize URL and sets the httpOnly state cookie, scoped to the connector routes', async () => {
    const response = await POST(post());
    expect([response.status, await response.json()]).toEqual([200, { url: 'https://shotviva.test/connect/graylum?state=s' }]);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`gl_shotviva_state=${me}.s`);
    expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/Secure/i); expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toContain('Path=/api/connectors/shotviva');
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ profileId: me, appOrigin: SITE }));
  });

  it('refuses another site, a signed-out visitor, a free member and a busy limiter, without a cookie', async () => {
    for (const origin of [null, 'https://evil.test']) expect((await POST(post(origin))).status).toBe(403);
    mocks.context.mockResolvedValueOnce({ admin: {}, profileId: null, baseUrl: 'x' });
    expect((await POST(post())).status).toBe(401);
    mocks.start.mockRejectedValueOnce(new ShotvivaConnectError('SHOTVIVA_MEMBERSHIP_REQUIRED'));
    const free = await POST(post());
    expect([free.status, await free.json(), free.headers.get('set-cookie')]).toEqual([403, { error: 'SHOTVIVA_MEMBERSHIP_REQUIRED' }, null]);
    mocks.limit.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'TOO_MANY_REQUESTS' }));
    expect((await POST(post())).status).toBe(429);
    mocks.start.mockRejectedValueOnce(new Error('private detail'));
    const down = await POST(post());
    expect([down.status, await down.json()]).toEqual([503, { error: 'SHOTVIVA_UNAVAILABLE' }]);
  });
});

describe('GET /api/connectors/shotviva/callback', () => {
  it('connected: back to the integrations page, cookie cleared, no referrer', async () => {
    const response = await GET(back('code=c&state=s', `${me}.s`));
    expect(response.headers.get('location')).toBe(`${SITE}/app/integrations?shotviva=connected`);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('set-cookie')).toMatch(/gl_shotviva_state=;.*Max-Age=0/i);
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ profileId: me, cookie: `${me}.s`, state: 's', code: 'c' }));
  });

  it('a refusal comes back as a fixed code on the page, and the cookie is cleared too', async () => {
    mocks.finish.mockRejectedValueOnce(new ShotvivaConnectError('SHOTVIVA_STATE_INVALID'));
    const response = await GET(back('code=c&state=other', `${me}.s`));
    expect(response.headers.get('location')).toBe(`${SITE}/app/integrations?shotviva_error=SHOTVIVA_STATE_INVALID`);
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    mocks.finish.mockRejectedValueOnce(new Error('private detail'));
    expect((await GET(back('code=c&state=s'))).headers.get('location')).toContain('shotviva_error=SHOTVIVA_UNAVAILABLE');
  });

  it('signed out: to the login page and back here, without exchanging the code', async () => {
    mocks.context.mockResolvedValueOnce({ admin: {}, profileId: null, baseUrl: 'x' });
    const location = new URL((await GET(back('code=c&state=s'))).headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('redirect')).toBe('/api/connectors/shotviva/callback?code=c&state=s');
    expect(mocks.finish).not.toHaveBeenCalled();
  });
});
