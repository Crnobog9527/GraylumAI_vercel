/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ entitlements: vi.fn(), uploads: vi.fn(), limit: vi.fn() }));
vi.mock('../services/membershipEntitlements', () => ({ readMembershipEntitlements: mocks.entitlements }));
vi.mock('../services/publishMonitor/postForMe/config', async importOriginal => ({
  ...(await importOriginal<object>()), takeUploadSlots: mocks.uploads }));
vi.mock('../services/redisRateLimiter', () => ({ checkRateLimitOrThrow: mocks.limit }));
import { publishMonitorRouter } from './publishMonitor';

const actor = '00000000-0000-4000-8000-0000000f0001';
const profile = { id: actor, role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };
function caller(rpc: ReturnType<typeof vi.fn>, switchOn: boolean, settings: Record<string, unknown> = {}) {
  const from = (table: string) => {
    let key = '';
    return { select() { return this; }, eq(_column: string, value: string) { key = value; return this; },
      single: async () => ({ data: profile, error: null }),
      maybeSingle: async () => ({ data: table !== 'system_settings' ? profile
        : key === 'publish_monitor_enabled' ? { value: switchOn } : key in settings ? { value: settings[key] } : null,
      error: null }) };
  };
  const db = { from, rpc };
  return publishMonitorRouter.createCaller({
    headers: new Headers(), user: { id: actor, email: 'u@example.com', app_metadata: {}, user_metadata: {} },
    isEmailVerified: true, authProvider: 'email',
    supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true,
  } as never);
}

describe('publish-monitor automatic review switch', () => {
  it('turning automatic review off works even while the feature is paused; turning it on does not', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { autoReviewEnabled: false, autoReviewEnabledAt: null }, error: null });
    await expect(caller(rpc, false).setAutoReview({ enabled: false }))
      .resolves.toEqual({ autoReviewEnabled: false, autoReviewEnabledAt: null });
    expect(rpc).toHaveBeenCalledWith('publish_monitor_set_auto_review', expect.objectContaining({ a: actor }));
    mocks.entitlements.mockResolvedValue({ allowWeeklyAutoReview: true });
    await expect(caller(vi.fn(), false).setAutoReview({ enabled: true }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_DISABLED' });
  });

  it('disconnect works while paused and refuses a connection that is not the user\'s own', async () => {
    const id = '00000000-0000-4000-8000-0000000f0002';
    const rpc = vi.fn().mockResolvedValue({ data: { connectionId: id, providerCleanup: true }, error: null });
    await expect(caller(rpc, false).disconnect({ connectionId: id })).resolves.toEqual({ connectionId: id, providerCleanup: true });
    expect(rpc).toHaveBeenCalledWith('publish_monitor_disconnect', { a: actor, p_connection_id: id });
    const foreign = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND' } });
    await expect(caller(foreign, true).disconnect({ connectionId: id }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND' });
  });
});

describe('publish-monitor one-click publishing', () => {
  const biz = '00000000-0000-4000-8000-0000000f0003';
  const conn = '00000000-0000-4000-8000-0000000f0004';
  const submit = { idempotencyKey: 'key-00000001', businessId: biz, workItemId: null, connectionIds: [conn], caption: 'Hi',
    media: [] };
  const open = { publish_monitor_publish_platforms: ['x'],
    publish_monitor_publish_price: { usdPerTarget: '0.01', multiplier: '6', creditsPerUsd: '100' } };
  const connection = (platform: string, id = conn) => ({ id, businessId: biz, accountProjectId: biz, role: 'own',
    source: 'postforme', platform, displayHint: null, status: 'connected', consentRead: true, consentAutoTrack: false,
    consentPublish: true, lastSuccessAt: null, postCount: 0 });

  it('opens only listed platforms, on the server, before any upload slot, claim or provider call', async () => {
    mocks.entitlements.mockResolvedValue({ allowPublish: true });
    mocks.limit.mockClear();
    mocks.uploads.mockClear();
    const youtube = vi.fn().mockResolvedValue({ data: [connection('youtube')], error: null });
    await expect(caller(youtube, true, open).publish.submit(submit))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_PLATFORM_NOT_OPEN' });
    await expect(caller(youtube, true, open).publish.uploadUrl({ disclosureAccepted: true, count: 1, connectionIds: [conn] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_PLATFORM_NOT_OPEN' });
    expect(youtube.mock.calls.map(call => call[0])).toEqual(['publish_monitor_connections', 'publish_monitor_connections']);
    // No list at all (the default) opens nothing, without even reading the connections.
    const none = vi.fn();
    await expect(caller(none, true).publish.submit(submit))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_PLATFORM_NOT_OPEN' });
    await expect(caller(none, true, { publish_monitor_publish_platforms: 'x' }).publish.submit(submit))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_PLATFORM_NOT_OPEN' });
    expect(none).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.uploads).not.toHaveBeenCalled();
  });

  it('refuses an unknown or unfit connection before any upload slot is issued', async () => {
    mocks.entitlements.mockResolvedValue({ allowPublish: true });
    mocks.limit.mockClear();
    mocks.uploads.mockClear();
    const other = '00000000-0000-4000-8000-0000000f0009';
    const second = '00000000-0000-4000-8000-0000000f000a';
    const unfit = [{ ...connection('x'), consentPublish: false }, { ...connection('x', second), source: 'tikhub' },
      { ...connection('x', other), status: 'reauth_required' }];
    for (const [ids, rows] of [[[other], [connection('x')]], [[conn], [unfit[0]]], [[second], [unfit[1]]], [[other], [unfit[2]]],
      [[conn, second], [connection('x'), connection('x', second)]]] as const) {
      const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
      await expect(caller(rpc, true, open).publish.uploadUrl({ disclosureAccepted: true, count: 1, connectionIds: [...ids] }))
        .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_TARGET_INVALID' });
    }
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.uploads).not.toHaveBeenCalled();
  });

  it('options lists the open platforms and the exact hold for 1..9 targets', async () => {
    mocks.entitlements.mockResolvedValue({ allowPublish: true });
    await expect(caller(vi.fn(), true, open).publish.options())
      .resolves.toEqual({ platforms: ['x'], holdCreditsByTargets: [6, 12, 18, 24, 30, 36, 42, 48, 54] });
    await expect(caller(vi.fn(), true, { publish_monitor_publish_price: { usdPerTarget: '0.015', multiplier: '6',
      creditsPerUsd: '100' } }).publish.options()).resolves.toEqual({ platforms: [],
      holdCreditsByTargets: [9, 18, 27, 36, 45, 54, 63, 72, 81] });
    await expect(caller(vi.fn(), true, { publish_monitor_publish_price: { usdPerTarget: '0.011', multiplier: '1',
      creditsPerUsd: '100' } }).publish.options()).resolves.toMatchObject({ holdCreditsByTargets: [2, 3, 4, 5, 6, 7, 8, 9, 10] });
    await expect(caller(vi.fn(), true, { publish_monitor_publish_price: { usdPerTarget: 'x' } }).publish.options())
      .resolves.toEqual({ platforms: [], holdCreditsByTargets: null });
  });

  it('refuses publishing without the entitlement before any database or provider work, and while paused', async () => {
    mocks.entitlements.mockResolvedValue({ allowPublish: false });
    const rpc = vi.fn();
    await expect(caller(rpc, true).publish.submit(submit))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    await expect(caller(rpc, true).publish.uploadUrl({ disclosureAccepted: true, count: 1, connectionIds: [conn] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    await expect(caller(rpc, true).publish.options())
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    mocks.entitlements.mockResolvedValue({ allowPublish: true });
    await expect(caller(rpc, false).publish.submit(submit))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_DISABLED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('upload slots are counted one by one against the per-user allowance before any provider call', async () => {
    mocks.entitlements.mockResolvedValue({ allowPublish: true });
    mocks.limit.mockResolvedValue({ success: true });
    mocks.uploads.mockResolvedValue({ ok: false, retryAfterSeconds: 120 });
    const rpc = vi.fn().mockResolvedValue({ data: [connection('x')], error: null });
    await expect(caller(rpc, true, open).publish.uploadUrl({ disclosureAccepted: true, count: 7, connectionIds: [conn] }))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mocks.uploads).toHaveBeenCalledWith(actor, 7);
  });

  it('an upload slot needs the confirmed disclosure; a job is readable only through the owner-scoped lookup', async () => {
    await expect(caller(vi.fn(), true).publish.uploadUrl({ disclosureAccepted: false, count: 1, connectionIds: [conn] } as never))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller(vi.fn(), true).publish.uploadUrl({ disclosureAccepted: true, count: 11, connectionIds: [conn] }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller(vi.fn(), true).publish.uploadUrl({ disclosureAccepted: true, count: 1 } as never))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const job = '00000000-0000-4000-8000-0000000f0005';
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_JOB_NOT_FOUND' } });
    await expect(caller(rpc, false).publish.job({ jobId: job }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'PUBLISH_MONITOR_JOB_NOT_FOUND' });
    expect(rpc).toHaveBeenCalledWith('publish_monitor_publish_job', { a: actor, p_job: job });
  });
});

describe('publish-monitor own data (PR-3a)', () => {
  const empty = { windowDays: 30, connections: [], posts: [] };
  it('the window comes from the entitlement; a plan without one is refused before any read', async () => {
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 0 });
    const none = vi.fn();
    await expect(caller(none, true).data({})).rejects.toMatchObject({ code: 'FORBIDDEN',
      message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    await expect(caller(none, true).refresh({ connectionId: actor })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(none).not.toHaveBeenCalled();
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 90 });
    const rpc = vi.fn().mockResolvedValue({ data: { ...empty, windowDays: 90 }, error: null });
    await caller(rpc, true).data({});
    expect(rpc).toHaveBeenCalledWith('publish_monitor_data', { a: actor, p_window_days: 90, p_connection_id: null });
  });

  it('reading needs the feature switch; a refresh within the hour is a rate limit; a foreign item is refused', async () => {
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 30 });
    await expect(caller(vi.fn(), false).data({})).rejects.toMatchObject({ message: 'PUBLISH_MONITOR_DISABLED' });
    const soon = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_REFRESH_TOO_SOON' } });
    await expect(caller(soon, true).linkPost({ postId: actor, workItemId: actor }))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    const foreign = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_WORK_ITEM_MISMATCH' } });
    await expect(caller(foreign, true).linkPost({ postId: actor, workItemId: actor }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_WORK_ITEM_MISMATCH' });
  });
});

describe('publish-monitor manual import (PR-3b)', () => {
  it('needs a data window and the feature switch; invalid rows are a bad request', async () => {
    const input = { accountProjectId: actor, origin: 'table' as const, rows: [{ postKey: 'p', url: null, postedAt: null,
      titleExcerpt: null, metrics: { likes: 1 } }] };
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 0 });
    await expect(caller(vi.fn(), true).manualImport(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 30 });
    await expect(caller(vi.fn(), false).manualImport(input)).rejects.toMatchObject({ message: 'PUBLISH_MONITOR_DISABLED' });
    const rpc = vi.fn().mockResolvedValue({ data: { connectionId: actor, inserted: 1, updated: 0 }, error: null });
    await expect(caller(rpc, true).manualImport(input)).resolves.toEqual({ connectionId: actor, inserted: 1, updated: 0 });
    await expect(caller(vi.fn(), true).manualImport({ ...input, rows: [{ ...input.rows[0]!, metrics: { likes: -1 } }] }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
