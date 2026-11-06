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


describe('refundStuckTurn (按回合全额退回并关闭)', () => {
  const actorId = '11111111-1111-4111-8111-111111111111';
  const input = { actorId, turnId: 7, reason: 'lookup never answers' };
  const done = { refunded: true, turnId: 7, chargedCredits: 0, reservedCredits: 60, closeKind: 'interrupted', settlement: 'done', stateBefore: 'closed' };

  it('calls the admin function with the signed-in admin, a fresh request id and the reason', async () => {
    const f = harness('admin', { data: done, error: null });
    expect(await f.caller.refundStuckTurn(input)).toEqual(done);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ fn: 'turn_admin_refund_all', args: { p_actor_id: actorId, p_turn_id: 7, p_admin_id: 'actor', p_reason: 'lookup never answers' } });
    expect(f.calls[0]!.args.p_request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it.each(['user', 'anonymous'] as const)('denies %s before anything is called', async (role) => {
    const f = harness(role, { data: done, error: null });
    await expect(f.caller.refundStuckTurn(input)).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
    expect(f.calls).toEqual([]);
  });
  it('answers an already settled turn without an error (a repeat changes nothing)', async () => {
    const f = harness('admin', { data: { refunded: false, reason: 'already_settled', turnId: 7, chargedCredits: 0 }, error: null });
    expect(await f.caller.refundStuckTurn(input)).toMatchObject({ refunded: false, reason: 'already_settled' });
  });
  it('refuses a turn younger than 24 hours and a turn with nothing pending', async () => {
    expect(await harness('admin', { data: { refunded: false, reason: 'too_young', turnId: 7 }, error: null }).caller.refundStuckTurn(input)
      .catch(error => error)).toMatchObject({ code: 'BAD_REQUEST', message: 'TURN_TOO_YOUNG' });
    expect(await harness('admin', { data: { refunded: false, reason: 'not_pending', turnId: 7 }, error: null }).caller.refundStuckTurn(input)
      .catch(error => error)).toMatchObject({ code: 'CONFLICT', message: 'TURN_NOT_PENDING' });
  });
  it('maps the database refusals and failures to errors, never to a success', async () => {
    await expect(harness('admin', { data: null, error: { message: 'TURN_ADMIN_DENIED', code: '42501' } }).caller.refundStuckTurn(input))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'TURN_ADMIN_DENIED' });
    await expect(harness('admin', { data: null, error: { message: 'TURN_DENIED', code: '42501' } }).caller.refundStuckTurn(input))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(harness('admin', { data: null, error: { message: 'TURN_REFUND_INCOMPLETE', code: '55000' } }).caller.refundStuckTurn(input))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'TURN_REFUND_INCOMPLETE' });
    await expect(harness('admin', { data: { unexpected: true }, error: null }).caller.refundStuckTurn(input))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'TURN_REFUND_FAILED' });
  });
  it.each([{ turnId: 0 }, { turnId: 1.5 }, { actorId: 'not-a-uuid' }, { reason: 'x'.repeat(201) }, { extra: 1 }])('rejects the input %j', async (patch) => {
    const f = harness('admin', { data: done, error: null });
    await expect(f.caller.refundStuckTurn({ ...input, ...patch } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.calls).toEqual([]);
  });
});
