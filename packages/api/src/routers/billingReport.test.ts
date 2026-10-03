/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { billingReportRouter } from './billingReport';

function harness(role: 'admin' | 'user' | 'anonymous', rpcResult: { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
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

describe('BILL2 model report endpoint', () => {
  it('reads a bounded window through the admin-only report function', async () => {
    const f = harness('admin', { data: [], error: null });
    const report = await f.caller.bill2ByModel({ days: 7 });
    expect(report).toMatchObject({ available: true, models: [], truncated: false });
    expect(f.calls[0]).toMatchObject({ fn: 'bill2_admin_call_report', args: { p_limit: 5000 } });
    const { p_from: from, p_to: to } = f.calls[0]!.args as { p_from: string; p_to: string };
    expect(Date.parse(to) - Date.parse(from)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('aggregates returned rows (text numbers) into per-model, purpose and date lines', async () => {
    const rows = [
      { call_id: 'a', run_id: 'r', call_sequence: 1, created_at: '2026-10-01T00:00:00Z', provider: 'openrouter', model: 'v/a',
        call_state: 'responded', selected_cost_usd: '0.002', run_state: 'settled', run_outcome: 'delivered', credits_per_usd: '100',
        run_multiplier: '3', run_charged: 1, run_actual_restore: 0, run_call_count: 2, call_multiplier: '2', multiplier_source: 'model',
        purpose: 'interactive' },
      { call_id: 'b', run_id: 'r', call_sequence: 2, created_at: '2026-10-01T00:00:01Z', provider: 'openrouter', model: 'v/b',
        call_state: 'responded', selected_cost_usd: '0.002', run_state: 'settled', run_outcome: 'delivered', credits_per_usd: '100',
        run_multiplier: '3', run_charged: 1, run_actual_restore: 0, run_call_count: 2, call_multiplier: '3', multiplier_source: 'global',
        purpose: 'interactive' },
    ];
    const f = harness('admin', { data: rows, error: null });
    const report = await f.caller.bill2ByModel({ days: 30 });
    expect(report).toMatchObject({ available: true, totals: { calls: 2, runs: 1, chargedCredits: 1, unallocatedChargedCredits: 0 } });
    if (!report.available) throw new Error('unavailable');
    expect(report.models.map((m) => [m.model, m.attributedChargedCredits])).toEqual([['v/a', 1], ['v/b', 0]]);
    expect(report.byPurpose).toEqual([{ key: 'interactive', calls: 2, unknownCostCalls: 0, knownOfficialCostUsd: '0.004', knownWeightedUsd: '0.01', officialCostUsd: '0.004', weightedUsd: '0.01' }]);
  });

  it('a missing function is reported as unavailable, never as an empty month', async () => {
    const f = harness('admin', { data: null, error: { code: 'PGRST202' } });
    expect(await f.caller.bill2ByModel({ days: 30 })).toMatchObject({ available: false });
  });

  it.each([0, 91, 1.5])('rejects a window of %s days', async (days) => {
    const f = harness('admin', { data: [], error: null });
    await expect(f.caller.bill2ByModel({ days })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.calls).toEqual([]);
  });

  it.each(['user', 'anonymous'] as const)('denies %s', async (role) => {
    const f = harness(role, { data: [], error: null });
    await expect(f.caller.bill2ByModel({ days: 30 })).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
    expect(f.calls).toEqual([]);
  });
});
