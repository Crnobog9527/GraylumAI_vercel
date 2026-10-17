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

describe('publish-monitor one-click publishing', () => {
  const biz = '00000000-0000-4000-8000-0000000f0003';
  const conn = '00000000-0000-4000-8000-0000000f0004';
  const submit = { idempotencyKey: 'key-00000001', businessId: biz, workItemId: null, connectionIds: [conn], caption: 'Hi',
    media: [] };
  it('refuses publishing without the entitlement before any database or provider work, and while paused', async () => {
    mocks.entitlements.mockResolvedValue({ allowPublish: false });
    const rpc = vi.fn();
    await expect(caller(rpc, true).publish.submit(submit))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    await expect(caller(rpc, true).publish.uploadUrl({ disclosureAccepted: true, count: 1 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    mocks.entitlements.mockResolvedValue({ allowPublish: true });
    await expect(caller(rpc, false).publish.submit(submit))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_DISABLED' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('an upload slot needs the confirmed disclosure; a job is readable only through the owner-scoped lookup', async () => {
    await expect(caller(vi.fn(), true).publish.uploadUrl({ disclosureAccepted: false, count: 1 } as never))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller(vi.fn(), true).publish.uploadUrl({ disclosureAccepted: true, count: 11 }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const job = '00000000-0000-4000-8000-0000000f0005';
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_JOB_NOT_FOUND' } });
    await expect(caller(rpc, false).publish.job({ jobId: job }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'PUBLISH_MONITOR_JOB_NOT_FOUND' });
    expect(rpc).toHaveBeenCalledWith('publish_monitor_publish_job', { a: actor, p_job: job });
  });
});
