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
});
