/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { expertConsultRouter } from './expertConsult';
import { notifyOwnerOfExpertConsult, requestExpertConsult } from '../services/expertConsult/request';
import { logger } from '../lib/logger';

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const created = { ticketId: id(9), createdAt: '2026-10-17T00:00:00Z', created: true };
const input = { need: '想请专家看看我的账号定位', contact: 'wechat: abc', source: 'report' as const };
function fixture(options: { user?: boolean; admin?: boolean; error?: string; status?: string; data?: unknown } = {}) {
  const rpc = vi.fn((name: string) => Promise.resolve(options.error ? { data: null, error: { message: options.error } }
    : { data: options.data ?? (name === 'expert_consult_state' ? { eligible: true, pending: null } : created), error: null }));
  const profile = { id: id(1), role: 'user', status: options.status ?? 'active', credits: 0, nickname: 'n' };
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: profile, error: null }),
    single: async () => ({ data: profile, error: null }) };
  const db = { rpc, from: () => q };
  const caller = expertConsultRouter.createCaller({ headers: new Headers(),
    user: options.user === false ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: options.admin ?? true } as never);
  const calls = () => rpc.mock.calls.filter(([name]) => String(name).startsWith('expert_consult'));
  return { caller, rpc, calls };
}

it('signed-in user reads their state and sends a trimmed request for their own account only', async () => {
  const f = fixture();
  expect(await f.caller.state()).toEqual({ eligible: true, pending: null });
  expect(await f.caller.request({ ...input, need: `  ${input.need}  `, contact: ' wechat: abc ' })).toEqual(created);
  expect(f.calls()).toEqual([
    ['expert_consult_state', { p_actor_id: id(1) }],
    ['expert_consult_request', { p_actor_id: id(1), p_need: input.need, p_contact: 'wechat: abc', p_source: 'report' }],
  ]);
});

it('anonymous callers are denied and no request RPC runs', async () => {
  const f = fixture({ user: false });
  await expect(f.caller.state()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(f.caller.request(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(f.calls()).toEqual([]);
});

it('a closed account cannot ask through the API', async () => {
  const f = fixture({ status: 'deleted' });
  await expect(f.caller.request(input)).rejects.toBeTruthy();
  expect(f.calls()).toEqual([]);
});

it.each([
  [{ profileId: id(2) }], [{ source: 'checkout' }], [{ need: '短' }], [{ contact: 'ab' }],
  [{ need: 'x'.repeat(2001) }], [{ contact: 'x'.repeat(201) }], [{ price: 300 }],
])('rejects input %j before any RPC', async (extra) => {
  const f = fixture();
  await expect(f.caller.request({ ...input, ...extra } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.calls()).toEqual([]);
});

it.each([
  ['EXPERT_CONSULT_NOT_ELIGIBLE', 'FORBIDDEN'], ['EXPERT_CONSULT_ACCOUNT_CLOSED', 'FORBIDDEN'],
  ['EXPERT_CONSULT_INVALID', 'BAD_REQUEST'], ['relation does not exist', 'INTERNAL_SERVER_ERROR'],
])('maps %s to %s without leaking database text', async (message, code) => {
  const f = fixture({ error: message });
  const error = await f.caller.request(input).catch(e => e);
  expect(error).toMatchObject({ code });
  expect(error.message).toMatch(/^EXPERT_CONSULT_[A-Z_]+$/);
});

it('a malformed database answer is unavailable, never trusted', async () => {
  const f = fixture({ data: { eligible: 'yes' } });
  await expect(f.caller.state()).rejects.toMatchObject({ message: 'EXPERT_CONSULT_UNAVAILABLE' });
});

it('without service-role access nothing runs', async () => {
  const f = fixture({ admin: false });
  await expect(f.caller.state()).rejects.toMatchObject({ message: 'EXPERT_CONSULT_UNAVAILABLE' });
  expect(f.calls()).toEqual([]);
});

it('notifies the Owner once, with the ticket id only, and a failed notice never fails the request', async () => {
  const notify = vi.fn(async () => { throw new Error('mail down'); });
  const db = { rpc: vi.fn(async () => ({ data: created, error: null })) };
  expect(await requestExpertConsult(db as never, id(1), input, notify)).toEqual(created);
  expect(notify).toHaveBeenCalledExactlyOnceWith({ ticketId: id(9) });
  db.rpc.mockResolvedValueOnce({ data: { ...created, created: false }, error: null });
  await requestExpertConsult(db as never, id(1), input, notify);
  expect(notify).toHaveBeenCalledTimes(1);
});

it('the default notice is a persisted warn-level log carrying only the ticket id', async () => {
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    await notifyOwnerOfExpertConsult({ ticketId: id(9) });
    expect(warn).toHaveBeenCalledExactlyOnceWith('api', 'expert_consult_requested', { ticketId: id(9) });
  } finally { warn.mockRestore(); }
});
