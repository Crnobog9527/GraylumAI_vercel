/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import {
  modelIdentityGuardEnabled, modelIdentityGuardView, readModelIdentityGuard, setModelIdentityGuard,
} from './guardSetting';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const DEFAULT = { version: 1, enabled: true, revision: 0, updatedBy: null, updatedAt: null };
const rpcOnly = (rpc: (name: string, args?: unknown) => unknown) => ({ rpc: async (name: string, args?: unknown) => rpc(name, args) }) as never;

it('reads the database default as enabled', async () => {
  const db = rpcOnly(() => ({ data: DEFAULT, error: null }));
  expect(await readModelIdentityGuard(db)).toEqual(DEFAULT);
  expect(await modelIdentityGuardEnabled(db)).toBe(true);
});

it.each([
  ['rpc error', () => ({ data: null, error: { code: 'XX000', message: 'private' } })],
  ['thrown', () => { throw new Error('private'); }],
  ['malformed', () => ({ data: { ...DEFAULT, enabled: 'false' }, error: null })],
  ['extra key', () => ({ data: { ...DEFAULT, model: 'x' }, error: null })],
])('keeps protection on when the setting cannot be read (%s)', async (_name, rpc) => {
  const db = rpcOnly(rpc);
  await expect(readModelIdentityGuard(db)).rejects.toMatchObject({ message: 'MODEL_IDENTITY_GUARD_UNAVAILABLE' });
  expect(await modelIdentityGuardEnabled(db)).toBe(true);
});

it('reads a saved off state', async () => {
  const off = { ...DEFAULT, enabled: false, revision: 1, updatedBy: ADMIN, updatedAt: '2026-10-12T00:00:00.000000Z' };
  expect(await modelIdentityGuardEnabled(rpcOnly(() => ({ data: off, error: null })))).toBe(false);
});

it('passes the acting admin and expected revision to the dedicated writer', async () => {
  const calls: unknown[] = [];
  const saved = { ...DEFAULT, enabled: false, revision: 1, updatedBy: ADMIN, updatedAt: '2026-10-12T00:00:00.000000Z' };
  const db = rpcOnly((name, args) => { calls.push([name, args]); return { data: saved, error: null }; });
  expect(await setModelIdentityGuard(db, ADMIN, { enabled: false, expectedRevision: 0 })).toEqual(saved);
  expect(calls).toEqual([['model_identity_guard_set', { p_enabled: false, p_expected_revision: 0, p_actor: ADMIN }]]);
});

it.each([
  ['PT409', 'CONFLICT'], ['42501', 'FORBIDDEN'], ['XX000', 'SERVICE_UNAVAILABLE'],
])('maps writer error %s to %s without leaking details', async (code, trpcCode) => {
  const db = rpcOnly(() => ({ data: null, error: { code, message: 'private detail' } }));
  const error = await setModelIdentityGuard(db, ADMIN, { enabled: true, expectedRevision: 3 }).catch(e => e);
  expect(error).toMatchObject({ code: trpcCode });
  expect(String(error.message)).not.toContain('private');
});

it('rejects malformed input before calling the database', async () => {
  let called = false;
  const db = rpcOnly(() => { called = true; return { data: DEFAULT, error: null }; });
  await expect(setModelIdentityGuard(db, ADMIN, { enabled: 'no', expectedRevision: -1 } as never)).rejects.toThrow();
  expect(called).toBe(false);
});

it('admin view resolves operator emails for the current state and history', async () => {
  const saved = { ...DEFAULT, enabled: false, revision: 2, updatedBy: ADMIN, updatedAt: '2026-10-12T01:00:00.000000Z' };
  const chain = (data: unknown) => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'in']) q[k] = () => q;
    q.limit = async () => ({ data, error: null });
    q.then = (resolve: (v: unknown) => void) => resolve({ data, error: null });
    return q;
  };
  const db = {
    rpc: async () => ({ data: saved, error: null }),
    from: (table: string) => table === 'user_activity_logs'
      ? chain([{ admin_id: ADMIN, details: { enabled: false }, created_at: '2026-10-12T01:00:00Z' },
        { admin_id: ADMIN, details: { enabled: true }, created_at: '2026-10-11T01:00:00Z' }])
      : chain([{ id: ADMIN, email: 'owner@example.test' }]),
  } as never;
  expect(await modelIdentityGuardView(db)).toEqual({
    config: saved,
    updatedByEmail: 'owner@example.test',
    history: [
      { enabled: false, operatorEmail: 'owner@example.test', at: '2026-10-12T01:00:00Z' },
      { enabled: true, operatorEmail: 'owner@example.test', at: '2026-10-11T01:00:00Z' },
    ],
  });
});
