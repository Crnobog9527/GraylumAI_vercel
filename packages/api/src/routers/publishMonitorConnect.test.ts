/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  entitlements: vi.fn(), rateLimit: vi.fn(), responses: [] as Response[], urls: [] as string[],
}));
vi.mock('../services/membershipEntitlements', () => ({ readMembershipEntitlements: mocks.entitlements }));
vi.mock('../services/redisRateLimiter', () => ({ checkRateLimitOrThrow: mocks.rateLimit }));
vi.mock('../services/publishMonitor/postForMe/config', () => ({
  PostForMeNotConfigured: class extends Error {},
  postForMeDeps: () => ({ apiKey: 'pfm_test_FAKEKEY000000000000', limiter: { acquire: async () => ({ ok: true }) },
    fetchImpl: async (url: string) => { mocks.urls.push(url); return mocks.responses.shift() ?? new Response('{}', { status: 500 }); } }),
}));
import { publishMonitorConnectRouter } from './publishMonitorConnect';

const actor = '00000000-0000-4000-8000-0000000c0001';
const account = '00000000-0000-4000-8000-0000000c0002';
const request = '00000000-0000-4000-8000-0000000c0003';
const conn = '00000000-0000-4000-8000-0000000c0004';
const EXTERNAL = 'a'.repeat(32) + '.' + 'b'.repeat(32);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const profile = { id: actor, role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };

function caller(rpc: ReturnType<typeof vi.fn>, cookie?: string, switchOn = true) {
  const from = (table: string) => ({ select() { return this; }, eq() { return this; },
    single: async () => ({ data: profile, error: null }),
    maybeSingle: async () => ({ data: table === 'system_settings' ? { value: switchOn } : profile, error: null }) });
  const db = { from, rpc };
  return publishMonitorConnectRouter.createCaller({
    headers: new Headers(cookie ? { cookie } : {}),
    user: { id: actor, email: 'u@example.com', app_metadata: {}, user_metadata: {} },
    isEmailVerified: true, authProvider: 'email',
    supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true,
  } as never);
}
const bound = `other=1; graylum_pm_connect=${request}`;

beforeEach(() => {
  mocks.responses.length = 0; mocks.urls.length = 0;
  mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 30, allowPublish: true });
  mocks.rateLimit.mockResolvedValue({ success: true });
});

describe('publish-monitor connect procedures', () => {
  it('start: refuses without a data window, or publishing without the publish entitlement', async () => {
    const rpc = vi.fn();
    mocks.entitlements.mockResolvedValueOnce({ ownDataWindowDays: 0, allowPublish: false });
    await expect(caller(rpc).start({ accountProjectId: account }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    mocks.entitlements.mockResolvedValueOnce({ ownDataWindowDays: 30, allowPublish: false });
    await expect(caller(rpc).start({ accountProjectId: account, publish: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('start: off switch refuses; allowed start is rate limited per user and returns the consent link', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { requestId: request, externalId: EXTERNAL, platform: 'youtube',
      permissions: ['feeds'] }, error: null });
    await expect(caller(rpc, undefined, false).start({ accountProjectId: account }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_DISABLED' });
    mocks.responses.push(json(201, { url: 'https://accounts.google.com/o' }));
    await expect(caller(rpc).start({ accountProjectId: account }))
      .resolves.toEqual({ requestId: request, url: 'https://accounts.google.com/o', combinedAuthorization: false });
    expect(mocks.rateLimit).toHaveBeenCalledWith(`publish-monitor-connect:${actor}`, 'auth');
  });

  it('callback, page, confirm and cancel all refuse an attempt this browser did not start', async () => {
    const rpc = vi.fn();
    for (const cookie of [undefined, 'graylum_pm_connect=00000000-0000-4000-8000-0000000c0999', 'graylum_pm_connect=junk']) {
      const c = caller(rpc, cookie);
      await expect(c.callback({ requestId: request, accountIds: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(c.pending({ requestId: request })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(c.confirm({ requestId: request, providerAccountId: 'spc_1', autoTrack: false }))
        .rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(c.cancel({ requestId: request })).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(mocks.urls).toEqual([]);
  });

  it('confirm deletes only unselected accounts still carrying this attempt\'s external_id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { connectionId: conn, externalId: EXTERNAL,
      unselected: ['spc_2', 'spc_3', 'spc_4'] }, error: null });
    mocks.responses.push(
      json(200, { id: 'spc_1', platform: 'facebook', status: 'connected', external_id: EXTERNAL }),
      json(200, { id: 'spc_2', platform: 'facebook', status: 'connected', external_id: EXTERNAL }), json(200, {}),
      json(200, { id: 'spc_3', platform: 'facebook', status: 'connected', external_id: 'c'.repeat(32) + '.' + 'd'.repeat(32) }),
      json(404, {}));
    await expect(caller(rpc, bound).confirm({ requestId: request, providerAccountId: 'spc_1', autoTrack: true }))
      .resolves.toEqual({ connectionId: conn, cleanupPending: false });
    expect(mocks.urls.map(u => u.replace(/^.*\/v1/, ''))).toEqual(['/social-accounts/spc_1', '/social-accounts/spc_2',
      '/social-accounts/spc_2', '/social-accounts/spc_3', '/social-accounts/spc_4']);
  });

  it('cancel cleans up; a provider failure is left for the sweep and reported', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { externalId: EXTERNAL, unselected: ['spc_2'] }, error: null });
    mocks.responses.push(json(503, {}));
    await expect(caller(rpc, bound).cancel({ requestId: request })).resolves.toEqual({ cancelled: true, cleanupPending: true });
  });

  it('pending shows names only for listed, available candidates of this attempt', async () => {
    const page = { requestId: request, platform: 'facebook', permissions: ['feeds'], confirmExpiresAt: '2026-10-14T08:00:00+00:00',
      target: { accountProjectId: account, platform: 'facebook', accountKey: 'brand', businessName: 'B' },
      candidates: [{ providerAccountId: 'spc_1', kind: 'new' }, { providerAccountId: 'spc_9', kind: 'unavailable' }] };
    const rpc = vi.fn().mockResolvedValue({ data: page, error: null });
    mocks.responses.push(json(200, { id: 'spc_1', platform: 'facebook', status: 'connected', external_id: EXTERNAL,
      username: 'brand page' }));
    const result = await caller(rpc, bound).pending({ requestId: request });
    expect(result.candidates).toEqual([{ providerAccountId: 'spc_1', kind: 'new', username: 'brand page' },
      { providerAccountId: 'spc_9', kind: 'unavailable', username: null }]);
    expect(mocks.urls).toHaveLength(1);
  });
});
