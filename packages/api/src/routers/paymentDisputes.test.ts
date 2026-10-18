/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { paymentDisputesRouter } from './paymentDisputes';
import { logger } from '../lib/logger';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const ID = '00000000-0000-4000-8000-000000000001';
function harness(role: 'admin' | 'user' | 'anonymous', error: unknown = null, privileged = true, records = [{ id: ID }]) {
  const filters: unknown[] = [], calls: unknown[] = [];
  const profile: Record<string, unknown> = {};
  profile.select = profile.eq = () => profile;
  profile.single = async () => ({ data: { id: ACTOR, role, status: 'active', is_deleted: 'false', credits: 0,
    nickname: 'Synthetic', email: 'synthetic@example.test' }, error: null });
  const query: Record<string, unknown> = {};
  query.select = (fields: string) => { filters.push(['select', fields]); return query; };
  query.eq = (field: string, value: unknown) => { filters.push([field, value]); return query; };
  query.order = (field: string, options: unknown) => { filters.push(['order', field, options]); return query; };
  query.range = async (from: number, to: number) => {
    filters.push(['range', from, to]); return { data: records.slice(from, to + 1), error };
  };
  query.limit = async () => ({ data: [{ id: ID }], error });
  const db = { from: (table: string) => table === 'profiles' ? profile : query,
    rpc: async (name: string, args: unknown) => {
      calls.push([name, args]); return { data: { restored: 7, duplicate: false }, error };
    } };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: ACTOR, email: 'synthetic@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', userRole: role === 'admin' ? 'admin' : 'user',
    supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db,
    hasSupabaseAdminPrivileges: privileged } as never;
  return { caller: paymentDisputesRouter.createCaller(ctx), filters, calls };
}
beforeEach(() => {
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(logger, level).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
it('denies non-admin withdrawal and listing before financial queries', async () => {
  for (const role of ['user', 'anonymous'] as const) {
    const f = harness(role), code = role === 'user' ? 'FORBIDDEN' : 'UNAUTHORIZED';
    await expect(f.caller.list()).rejects.toMatchObject({ code });
    await expect(f.caller.withdraw({ disputeId: ID })).rejects.toMatchObject({ code });
    await expect(f.caller.resolveExternal({ disputeId: ID })).rejects.toMatchObject({ code });
    expect(f.calls).toEqual([]); expect(f.filters).toEqual([]);
  }
});
it('returns only a boolean notice scoped to the authenticated profile', async () => {
  const f = harness('user');
  expect(await f.caller.notice()).toEqual({ frozen: true });
  expect(f.filters).toContainEqual(['payment_orders.user_id', ACTOR]);
  expect(f.filters).toContainEqual(['freeze_state', 'frozen']);
  await expect(harness('anonymous').caller.notice()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
it('passes the active admin identity for a second database authorization check', async () => {
  const f = harness('admin');
  expect(await f.caller.withdraw({ disputeId: ID })).toEqual({ restored: 7, duplicate: false });
  expect(f.calls).toEqual([['pay_dispute_withdraw', { p_actor: ACTOR, p_dispute: ID }]]);
  await expect(f.caller.withdraw({ disputeId: 'bad' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
it('does not expose database errors or run financial operations without privileged access', async () => {
  const f = harness('admin', { message: 'private database details' });
  await expect(f.caller.withdraw({ disputeId: ID })).rejects.toMatchObject({ message: '冻结未撤回，请核对付款和拒付状态后重试' });
  const denied = harness('admin', null, false);
  await expect(denied.caller.list()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(denied.calls).toEqual([]); expect(denied.filters).toEqual([]);
});

it('keeps an older frozen dispute reachable beyond 100 newer records', async () => {
  const records = Array.from({ length: 101 }, (_, n) => ({ id: n === 100 ? ID : `newer-${n}` }));
  const f = harness('admin', null, true, records);
  expect(await f.caller.list()).toHaveLength(100);
  expect(await f.caller.list({ offset: 100 })).toEqual([{ id: ID }]);
  expect(f.filters).toContainEqual(['range', 100, 199]);
  expect(f.filters).toContainEqual(['order', 'id', { ascending: false }]);
  await expect(f.caller.list({ offset: -1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it('passes admin identity to off-site resolution and safely reports a matched-payment conflict', async () => {
  const f = harness('admin');
  expect(await f.caller.resolveExternal({ disputeId: ID })).toEqual({ resolved: true });
  expect(f.calls).toEqual([['pay_dispute_resolve_external', { p_actor: ACTOR, p_dispute: ID }]]);
  await expect(harness('admin', { message: 'private details' }).caller.resolveExternal({ disputeId: ID }))
    .rejects.toMatchObject({ message: '未能结案，请核实是否已有对应订单' });
});
