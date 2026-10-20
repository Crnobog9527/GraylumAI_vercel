/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ start: vi.fn(), callback: vi.fn(), caller: vi.fn() }));
vi.mock('@/lib/publish-monitor-connect', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/publish-monitor-connect')>()),
  connectCaller: mocks.caller,
}));
import { POST } from './start/route';
import { GET } from './callback/route';

const request = '00000000-0000-4000-8000-0000000d0001';
const origin = 'https://app.synthetic.test';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue({ start: mocks.start, callback: mocks.callback });
});

it('start: refuses a cross-site POST before any work', async () => {
  const res = await POST(new NextRequest(`${origin}/api/publish-monitor/connect/start`,
    { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}' }));
  expect(res.status).toBe(403);
  expect(mocks.caller).not.toHaveBeenCalled();
});

it('start: binds the attempt to this browser with an httpOnly cookie and returns only the link', async () => {
  mocks.start.mockResolvedValue({ requestId: request, url: 'https://x.com/i/oauth2', combinedAuthorization: true });
  const res = await POST(new NextRequest(`${origin}/api/publish-monitor/connect/start`,
    { method: 'POST', headers: { origin }, body: JSON.stringify({ accountProjectId: request }) }));
  expect(await res.json()).toEqual({ url: 'https://x.com/i/oauth2', combinedAuthorization: true });
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toContain(`graylum_pm_connect=${request}`);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/SameSite=lax/i);
});

it('start: refusals come back as fixed codes', async () => {
  mocks.start.mockRejectedValue(new Error('PUBLISH_MONITOR_ENTITLEMENT_REQUIRED'));
  const res = await POST(new NextRequest(`${origin}/api/publish-monitor/connect/start`,
    { method: 'POST', headers: { origin }, body: '{}' }));
  expect([res.status, await res.json()]).toEqual([400, { error: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' }]);
  mocks.start.mockRejectedValue(new Error('PUBLISH_MONITOR_PROVIDER_UNAVAILABLE'));
  const outage = await POST(new NextRequest(`${origin}/api/publish-monitor/connect/start`,
    { method: 'POST', headers: { origin }, body: '{}' }));
  expect(outage.status).toBe(503);
});

it('callback: without this browser\'s cookie nothing is recorded', async () => {
  const res = await GET(new NextRequest(`${origin}/api/publish-monitor/connect/callback?accountIds=spc_1&isSuccess=true`));
  expect(res.headers.get('location')).toBe(`${origin}/app/publish-monitor/connect?error=PUBLISH_MONITOR_REQUEST_INVALID`);
  expect(mocks.callback).not.toHaveBeenCalled();
});

it('callback: records the cookie\'s attempt with sanitized hints, even when the provider reports failure', async () => {
  mocks.callback.mockResolvedValue({ requestId: request, offered: 1, takenOver: 0 });
  const res = await GET(new NextRequest(
    `${origin}/api/publish-monitor/connect/callback?accountIds=spc_1,../x,spc_2&accountIds=spc_3&isSuccess=false&requestId=forged`,
    { headers: { cookie: `graylum_pm_connect=${request}` } }));
  expect(mocks.callback).toHaveBeenCalledWith({ requestId: request, accountIds: ['spc_1', 'spc_2', 'spc_3'] });
  expect(res.headers.get('location')).toBe(`${origin}/app/publish-monitor/connect?request=${request}&provider=failed`);
});

it('callback: only someone else\'s account came back -> the owned-elsewhere explanation, not an empty page', async () => {
  mocks.callback.mockResolvedValue({ requestId: request, offered: 0, takenOver: 1 });
  const res = await GET(new NextRequest(`${origin}/api/publish-monitor/connect/callback?accountIds=spc_1`,
    { headers: { cookie: `graylum_pm_connect=${request}` } }));
  expect(res.headers.get('location')).toBe(`${origin}/app/publish-monitor/connect?error=PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE`);
  mocks.callback.mockResolvedValue({ requestId: request, offered: 1, takenOver: 1 });
  const mixed = await GET(new NextRequest(`${origin}/api/publish-monitor/connect/callback?accountIds=spc_1,spc_2`,
    { headers: { cookie: `graylum_pm_connect=${request}` } }));
  expect(mixed.headers.get('location')).toBe(`${origin}/app/publish-monitor/connect?ownedElsewhere=1&request=${request}`);
});

it('callback: an expired login goes to login and comes back to the same callback', async () => {
  mocks.callback.mockRejectedValue(Object.assign(new Error('You must be logged in'), { code: 'UNAUTHORIZED' }));
  const res = await GET(new NextRequest(`${origin}/api/publish-monitor/connect/callback?accountIds=spc_1`,
    { headers: { cookie: `graylum_pm_connect=${request}` } }));
  const location = new URL(res.headers.get('location')!);
  expect([location.pathname, location.searchParams.get('redirect')])
    .toEqual(['/login', '/api/publish-monitor/connect/callback?accountIds=spc_1']);
});
