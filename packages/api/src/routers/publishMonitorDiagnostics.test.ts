/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ entitlements: vi.fn(), limit: vi.fn() }));
vi.mock('../services/membershipEntitlements', () => ({ readMembershipEntitlements: mocks.entitlements }));
vi.mock('../services/redisRateLimiter', () => ({ checkRateLimitOrThrow: mocks.limit }));
import { publishMonitorRouter } from './publishMonitor';

const actor = '00000000-0000-4000-8000-0000000f0001', post = '00000000-0000-4000-8000-0000000f0002';
const profile = { id: actor, role: 'user', status: 'active', nickname: 'U', email: 'u@example.com' };
function caller(rpc: ReturnType<typeof vi.fn>, switchOn = true) {
  const from = (table: string) => {
    let key = '';
    return { select() { return this; }, eq(_c: string, value: string) { key = value; return this; }, single: async () => ({ data: profile, error: null }),
      maybeSingle: async () => ({ data: table !== 'system_settings' ? profile : key === 'publish_monitor_enabled' ? { value: switchOn } : null, error: null }) };
  };
  const db = { from, rpc };
  return publishMonitorRouter.createCaller({ headers: new Headers(), user: { id: actor, email: 'u@example.com', app_metadata: {}, user_metadata: {} },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never);
}

describe('publish-monitor diagnostics router', () => {
  it('saves for a plan with a data window, rate limited, and refuses a plan without one before touching the database', async () => {
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 30 });
    const rpc = vi.fn().mockResolvedValue({ data: { id: post, capturedOn: '2026-11-03' }, error: null });
    await expect(caller(rpc).diagnostics.save({ postId: post, rates: { retain_3s: 0.5 } })).resolves.toEqual({ id: post, capturedOn: '2026-11-03' });
    expect(mocks.limit).toHaveBeenCalledWith(`publish-monitor-diagnostic:${actor}`, 'api');
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 0 });
    const untouched = vi.fn();
    await expect(caller(untouched).diagnostics.save({ postId: post, rates: { retain_3s: 0.5 } })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED' });
    await expect(caller(untouched).diagnostics.candidates()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(untouched).not.toHaveBeenCalled();
  });

  it('maps a post that is not the user\'s to NOT_FOUND and bad numbers to BAD_REQUEST; removal works while the feature is paused', async () => {
    mocks.entitlements.mockResolvedValue({ ownDataWindowDays: 90 });
    const missing = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_POST_NOT_FOUND' } });
    await expect(caller(missing).diagnostics.save({ postId: post, rates: { retain_3s: 0.5 } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const invalid = vi.fn().mockResolvedValue({ data: null, error: { message: 'PUBLISH_MONITOR_INPUT_INVALID' } });
    await expect(caller(invalid).diagnostics.save({ postId: post, rates: { retain_3s: 0.5 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller(vi.fn(), true).diagnostics.save({ postId: post, rates: { retain_3s: 7 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const removed = vi.fn().mockResolvedValue({ data: true, error: null });
    await expect(caller(removed, false).diagnostics.remove({ id: post })).resolves.toBe(true);
    await expect(caller(vi.fn(), false).diagnostics.save({ postId: post, rates: { retain_3s: 0.5 } })).rejects.toMatchObject({ message: 'PUBLISH_MONITOR_DISABLED' });
  });
});
