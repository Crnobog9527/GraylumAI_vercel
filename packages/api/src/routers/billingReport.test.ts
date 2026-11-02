/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { billingReportRouter } from './billingReport';

function harness(role: 'admin' | 'user' | 'anonymous', rpcResult: { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      if (table === 'system_settings') return { select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: null, error: null }) };
      if (table !== 'profiles') throw new Error(table);
      return { select() { return this; }, eq() { return this; },
        single: async () => ({ data: { id: 'actor', role, status: 'active', credits: 0, nickname: 'S', email: 's@example.test' }, error: null }) };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpcResult; },
  };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: 'actor', email: 's@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: billingReportRouter.createCaller(ctx), calls };
}

const reportData = {
  models: [{ model: 'v/a', calls: 2, unknownCostCalls: 0, unknownActualCalls: 0, nominalUsd: '0.004', actualUsd: '0.003', minMultiplier: '2', maxMultiplier: '3' }],
  byDate: [{ date: '2026-10-01', calls: 2, unknownCostCalls: 0, nominalUsd: '0.004' }],
  totals: { calls: 2, unknownCostCalls: 0, unknownActualCalls: 0, nominalUsd: '0.004', actualUsd: '0.003', turns: 1, chargedCredits: 1, absorbedCredits: 0, unsettledTurns: 0 },
};
const unsettledData = { total: 0, turns: [] };

describe('turn cost report endpoints', () => {
  it('reads a bounded window through the admin-only report function', async () => {
    const f = harness('admin', { data: reportData, error: null });
    const report = await f.caller.turnByModel({ days: 7 });
    expect(report).toMatchObject({ available: true, totals: { calls: 2, turns: 1 } });
    expect(f.calls[0]).toMatchObject({ fn: 'turn_admin_model_report' });
    const { p_from: from, p_to: to } = f.calls[0]!.args as { p_from: string; p_to: string };
    expect(Date.parse(to) - Date.parse(from)).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('a missing function is reported as unavailable, never as an empty month', async () => {
    const f = harness('admin', { data: null, error: { code: 'PGRST202' } });
    expect(await f.caller.turnByModel({ days: 30 })).toMatchObject({ available: false });
    expect(await f.caller.unsettledTurns()).toMatchObject({ available: false });
  });
  it('lists unsettled turns through the read-only function', async () => {
    const f = harness('admin', { data: unsettledData, error: null });
    expect(await f.caller.unsettledTurns()).toEqual({ available: true, total: 0, turns: [] });
    expect(f.calls).toEqual([{ fn: 'turn_admin_unsettled_turns', args: { p_limit: 100 } }]);
  });
  it.each([0, 91, 1.5])('rejects a window of %s days', async (days) => {
    const f = harness('admin', { data: reportData, error: null });
    await expect(f.caller.turnByModel({ days })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.calls).toEqual([]);
  });
  it.each(['user', 'anonymous'] as const)('denies %s both views', async (role) => {
    const f = harness(role, { data: reportData, error: null });
    const code = role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    await expect(f.caller.turnByModel({ days: 30 })).rejects.toMatchObject({ code });
    await expect(f.caller.unsettledTurns()).rejects.toMatchObject({ code });
    expect(f.calls).toEqual([]);
  });
});

describe('platform alert endpoint permissions', () => {
  it('allows administrators to read disabled reminders and missing configuration', async () => {
    const f = harness('admin', { data: [], error: null });
    expect(await f.caller.platformAbsorbConfig()).toBeNull();
    expect(await f.caller.platformAbsorbAlerts()).toEqual({ status: 'disabled', alerts: [] });
  });
  it.each(['user', 'anonymous'] as const)('denies every platform alert operation to %s', async (role) => {
    const f = harness(role, { data: [], error: null });
    const code = role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN';
    await expect(f.caller.platformAbsorbConfig()).rejects.toMatchObject({ code });
    await expect(f.caller.platformAbsorbAlerts()).rejects.toMatchObject({ code });
    await expect(f.caller.savePlatformAbsorbConfig({ defaultUsd: '1', models: {} })).rejects.toMatchObject({ code });
    await expect(f.caller.acknowledgePlatformAbsorb({ model: 'v/a', utcDate: '2026-10-01' })).rejects.toMatchObject({ code });
    expect(f.calls).toEqual([]);
  });
});

