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
