/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { DataUseError, expireDataUseConsentAudit, filterTeamReadable, readDataUseConsent, setDataUseConsent } from './consent';
const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const state = { purpose: 'team_improvement', currentVersion: 'd5-v1', granted: false, version: null, grantedAt: null, revokedAt: null };
const db = (impl: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) => {
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    const promise = Promise.resolve(impl(name, args));
    return Object.assign(promise, { abortSignal: () => promise });
  });
  return { rpc } as never as { rpc: typeof rpc };
};

it('reads and sets consent only for the given profile through the dedicated RPCs', async () => {
  const d = db(() => ({ data: state, error: null }));
  expect(await readDataUseConsent(d as never, id(1))).toEqual(state);
  await setDataUseConsent(d as never, id(1), { granted: true, version: 'd5-v1' });
  expect(d.rpc.mock.calls).toEqual([['data_use_consent_state', { a: id(1) }],
    ['data_use_consent_set', { a: id(1), p_granted: true, p_version: 'd5-v1' }]]);
});

it.each([
  ['DATA_USE_VERSION_STALE', 'DATA_USE_VERSION_STALE'], ['DATA_USE_ACCOUNT_CLOSED', 'DATA_USE_ACCOUNT_CLOSED'],
  ['permission denied for table profiles', 'DATA_USE_UNAVAILABLE'],
])('maps database error %s to a public code', async (message, code) => {
  const d = db(() => ({ data: null, error: { message } }));
  await expect(setDataUseConsent(d as never, id(1), { granted: true, version: 'd5-v1' }))
    .rejects.toMatchObject({ code, message: code });
});

it('rejects malformed input and malformed state without calling or trusting the database', async () => {
  const d = db(() => ({ data: { ...state, extra: 1 }, error: null }));
  await expect(setDataUseConsent(d as never, id(1), { granted: true, version: 'D5 v1' })).rejects.toThrow();
  expect(d.rpc).not.toHaveBeenCalled();
  await expect(readDataUseConsent(d as never, id(1))).rejects.toBeInstanceOf(DataUseError);
});

it('team filter keeps only rows of consenting owners and dedupes owners per call', async () => {
  const d = db((_name, args) => ({ data: (args.p_profile_ids as string[]).filter(x => x === id(2)), error: null }));
  const rows = [{ owner: id(1), n: 1 }, { owner: id(2), n: 2 }, { owner: id(2).toUpperCase(), n: 3 }, { owner: id(3), n: 4 }];
  expect(await filterTeamReadable(d as never, rows, row => row.owner)).toEqual([rows[1], rows[2]]);
  expect(d.rpc).toHaveBeenCalledTimes(1);
  expect(d.rpc.mock.calls[0]).toEqual(['data_use_team_readable', { p_profile_ids: [id(1), id(2), id(3)] }]);
});

it('team filter accepts row-object responses and splits large owner lists into bounded calls', async () => {
  const owners = Array.from({ length: 1001 }, (_, i) => id(i + 1));
  const d = db((_name, args) => ({ data: (args.p_profile_ids as string[]).map(x => ({ data_use_team_readable: x })), error: null }));
  expect(await filterTeamReadable(d as never, owners, x => x)).toHaveLength(1001);
  expect(d.rpc.mock.calls.map(call => (call[1].p_profile_ids as string[]).length)).toEqual([1000, 1]);
});

it.each([
  ['an RPC error', { data: null, error: { message: 'boom' } }],
  ['an unexpected shape', { data: [{ id: id(1) }], error: null }],
  ['an owner the caller did not ask about', { data: [id(9)], error: null }],
])('team filter fails closed on %s', async (_label, response) => {
  const d = db(() => response);
  await expect(filterTeamReadable(d as never, [{ owner: id(1) }], row => row.owner))
    .rejects.toMatchObject({ code: 'DATA_USE_UNAVAILABLE' });
});

it('team filter rejects a non-uuid owner instead of guessing', async () => {
  const d = db(() => ({ data: [], error: null }));
  await expect(filterTeamReadable(d as never, [{ owner: 'not-a-user' }], row => row.owner)).rejects.toThrow();
  expect(d.rpc).not.toHaveBeenCalled();
});

it('audit expiry returns the removed count and fails on error', async () => {
  expect(await expireDataUseConsentAudit(db(() => ({ data: 2, error: null })) as never)).toBe(2);
  await expect(expireDataUseConsentAudit(db(() => ({ data: null, error: { message: 'x' } })) as never))
    .rejects.toBeInstanceOf(DataUseError);
});
