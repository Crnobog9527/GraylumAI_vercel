/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ entitlements: vi.fn() }));
vi.mock('../services/membershipEntitlements', () => ({ readMembershipEntitlements: mocks.entitlements }));
import { publishMonitorRouter } from './publishMonitor';

const actor = '00000000-0000-4000-8000-0000000f0001';
const profile = { id: actor, role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };
function caller(rpc: ReturnType<typeof vi.fn>, switchOn: boolean) {
  const from = (table: string) => ({ select() { return this; }, eq() { return this; },
    single: async () => ({ data: profile, error: null }),
    maybeSingle: async () => ({ data: table === 'system_settings' ? { value: switchOn } : profile, error: null }) });
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
