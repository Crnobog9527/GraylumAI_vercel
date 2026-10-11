/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { dataUseRouter } from './dataUse';
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = { purpose: 'team_improvement', currentVersion: 'd5-v1', granted: true, version: 'd5-v1',
  grantedAt: '2026-10-11T00:00:00Z', revokedAt: null };
function fixture(options: { user?: boolean; admin?: boolean; error?: string; status?: string } = {}) {
  const rpc = vi.fn((name: string) => Promise.resolve(options.error ? { data: null, error: { message: options.error } }
    : { data: name.startsWith('data_use') ? state : null, error: null }));
  const profile = { id: id(1), role: 'user', status: options.status ?? 'active', credits: 0, nickname: 'n' };
  const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: profile, error: null }),
    single: async () => ({ data: profile, error: null }) };
  const db = { rpc, from: () => q };
  const caller = dataUseRouter.createCaller({ headers: new Headers(),
    user: options.user === false ? null : { id: id(1), app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: options.admin ?? true } as never);
  return { caller, rpc };
}

it('signed-in user grants, reads and revokes only their own consent', async () => {
  const f = fixture();
  expect(await f.caller.setConsent({ granted: true, version: 'd5-v1' })).toEqual(state);
  expect(await f.caller.consent()).toEqual(state);
  await f.caller.setConsent({ granted: false, version: 'd5-v1' });
  const calls = f.rpc.mock.calls.filter(([name]) => String(name).startsWith('data_use'));
  expect(calls).toEqual([
    ['data_use_consent_set', { a: id(1), p_granted: true, p_version: 'd5-v1' }],
    ['data_use_consent_state', { a: id(1) }],
    ['data_use_consent_set', { a: id(1), p_granted: false, p_version: 'd5-v1' }],
  ]);
});

it('anonymous callers are denied and no consent RPC runs', async () => {
  const f = fixture({ user: false });
  await expect(f.caller.consent()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  await expect(f.caller.setConsent({ granted: true, version: 'd5-v1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  expect(f.rpc.mock.calls.some(([name]) => String(name).startsWith('data_use'))).toBe(false);
});

it('a closed account cannot use the switch through the API', async () => {
  const f = fixture({ status: 'deleted' });
  await expect(f.caller.setConsent({ granted: true, version: 'd5-v1' })).rejects.toBeTruthy();
  expect(f.rpc.mock.calls.some(([name]) => String(name).startsWith('data_use'))).toBe(false);
});

it('input cannot name another profile', async () => {
  const f = fixture();
  await expect(f.caller.setConsent({ granted: true, version: 'd5-v1', profileId: id(2) } as never))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it.each([
  ['DATA_USE_VERSION_STALE', 'CONFLICT'], ['DATA_USE_ACCOUNT_CLOSED', 'FORBIDDEN'],
  ['relation does not exist', 'INTERNAL_SERVER_ERROR'],
])('maps %s to %s without leaking database text', async (message, code) => {
  const f = fixture({ error: message });
  const error = await f.caller.setConsent({ granted: true, version: 'd5-v1' }).catch(e => e);
  expect(error).toMatchObject({ code });
  expect(error.message).toMatch(/^DATA_USE_[A-Z_]+$/);
});

it('without service-role credentials the switch is unavailable rather than falling back to the user client', async () => {
  const f = fixture({ admin: false });
  await expect(f.caller.consent()).rejects.toMatchObject({ message: 'DATA_USE_UNAVAILABLE' });
});
