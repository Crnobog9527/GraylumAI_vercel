/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { platformSecretsRouter } from './platformSecrets';
import { logger } from '../lib/logger';
import { PLATFORM_SECRET_SLOTS } from '../services/platformSecrets/slots';
import { getPlatformSecret, resetPlatformSecretCacheForTests } from '../services/platformSecrets/reader';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
// Fake values only. CANARY must never leave the database mock.
const CANARY = 'ROUTERCANARY';
const OPENROUTER = `sk-or-v1-${CANARY}-fake-0000c3d4`;

type Row = { slot: string; configured: boolean; last4: string | null; revision: number; updatedBy: string | null;
  updatedAt: string | null };
function harness(role: 'admin' | 'user' | 'anonymous', options: { failCode?: string; failStatus?: boolean; failEmail?: 'error' | 'throw' } = {}) {
  const vault = new Map<string, string>();
  const rows = new Map<string, Row>(PLATFORM_SECRET_SLOTS.map(slot =>
    [slot, { slot, configured: false, last4: null, revision: 0, updatedBy: null, updatedAt: null }]));
  const calls: Array<[string, Record<string, unknown>]> = [];
  const status = () => [...rows.values()];
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.eq = () => query;
  query.in = async () => {
    if (options.failEmail === 'throw') throw new Error('profile unavailable');
    return { data: [{ id: ACTOR, email: 'admin@example.test' }], error: options.failEmail ? { code: 'XX000' } : null };
  };
  query.single = async () => ({ data: { id: ACTOR, role, status: 'active', is_deleted: 'false', credits: 0,
    nickname: 'Synthetic', email: 'admin@example.test' }, error: null });
  const db = {
    from: (table: string) => { if (table !== 'profiles') throw new Error(table); return query; },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      const reply = (() => {
        if (name === 'platform_secret_status') return { data: status(), error: options.failStatus ? { code: 'XX000' } : null };
        if (name === 'platform_secret_read') return { data: vault.get(args.p_slot as string) ?? null, error: null };
        if (options.failCode) return { data: null, error: { code: options.failCode, message: 'failed' } };
        const row = rows.get(args.p_slot as string)!;
        if (args.p_expected_revision !== row.revision) return { data: null, error: { code: 'PT409' } };
        if (name === 'platform_secret_set') vault.set(row.slot, args.p_value as string);
        else vault.delete(row.slot);
        const value = vault.get(row.slot);
        rows.set(row.slot, { ...row, configured: !!value, last4: value ? value.slice(-4) : null, revision: row.revision + 1,
          updatedBy: args.p_actor as string, updatedAt: '2026-10-14T00:00:00.000000Z' });
        return { data: status(), error: null };
      })();
      return Object.assign(Promise.resolve(reply), { abortSignal: async () => reply });
    },
  };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: ACTOR, email: 'admin@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', userRole: role === 'admin' ? 'admin' : 'user',
    supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: platformSecretsRouter.createCaller(ctx), calls, db };
}

let logged: string[] = [];
beforeEach(() => {
  resetPlatformSecretCacheForTests();
  logged = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => { logged.push(JSON.stringify(args)); });
  }
});
afterEach(() => vi.restoreAllMocks());

it('admin saves a key; every answer shows only the last four characters', async () => {
  const f = harness('admin');
  const before = await f.caller.status();
  expect(before.slots.map(s => s.slot)).toEqual([...PLATFORM_SECRET_SLOTS]);
  const after = await f.caller.set({ slot: 'openrouter', value: `  ${OPENROUTER}\n`, expectedRevision: 0 });
  expect(after.slots[0]).toMatchObject({ slot: 'openrouter', configured: true, last4: 'c3d4', revision: 1,
    updatedByEmail: 'admin@example.test', source: 'admin', envFallback: null });
  expect(f.calls).toContainEqual(['platform_secret_set',
    { p_slot: 'openrouter', p_value: OPENROUTER, p_expected_revision: 0, p_actor: ACTOR }]);
  for (const answer of [before, after, await f.caller.status()]) expect(JSON.stringify(answer)).not.toContain(CANARY);
  expect(f.calls.some(([name]) => name === 'platform_secret_read')).toBe(false);
  expect(logged.join('\n')).not.toContain(CANARY);
});

it('save and clear invalidate this instance cache at once', async () => {
  const f = harness('admin');
  await f.caller.set({ slot: 'tikhub', value: `tikhub-${CANARY}-fake-first`, expectedRevision: 0 });
  expect((await getPlatformSecret(f.db as never, 'tikhub', { env: {} })).value).toBe(`tikhub-${CANARY}-fake-first`);
  await f.caller.set({ slot: 'tikhub', value: `tikhub-${CANARY}-fake-second`, expectedRevision: 1 });
  expect((await getPlatformSecret(f.db as never, 'tikhub', { env: {} })).value).toBe(`tikhub-${CANARY}-fake-second`);
  const cleared = await f.caller.clear({ slot: 'tikhub', expectedRevision: 2 });
  expect(cleared.slots.find(s => s.slot === 'tikhub')).toMatchObject({ configured: false, last4: null, revision: 3 });
  await expect(getPlatformSecret(f.db as never, 'tikhub', { env: {} })).rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
});

it('saves the Post for Me webhook secret in its own slot', async () => {
  const f = harness('admin');
  const after = await f.caller.set({ slot: 'postforme_webhook', value: `whsecret-${CANARY}-fake-m3n4`, expectedRevision: 0 });
  expect(after.slots.find(s => s.slot === 'postforme_webhook')).toMatchObject({ configured: true, last4: 'm3n4',
    envFallback: { name: 'POSTFORME_WEBHOOK_SECRET' } });
  expect(after.slots.find(s => s.slot === 'postforme')).toMatchObject({ configured: false });
  expect(JSON.stringify(after)).not.toContain(CANARY);
  await expect(f.caller.set({ slot: 'postforme_webhook', value: 'too-short', expectedRevision: 1 }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

it('a stale editor gets a conflict instead of overwriting', async () => {
  const f = harness('admin');
  await f.caller.set({ slot: 'parallel', value: `parallel-${CANARY}-fake-a`, expectedRevision: 0 });
  await expect(f.caller.set({ slot: 'parallel', value: `parallel-${CANARY}-fake-b`, expectedRevision: 0 }))
    .rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(f.caller.clear({ slot: 'parallel', expectedRevision: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
});

it.each(['user', 'anonymous'] as const)('denies %s every procedure without touching the database', async role => {
  const f = harness(role);
  for (const call of [() => f.caller.status(), () => f.caller.clear({ slot: 'openrouter', expectedRevision: 0 }),
    () => f.caller.set({ slot: 'openrouter', value: OPENROUTER, expectedRevision: 0 })]) {
    await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  }
  expect(f.calls).toEqual([]);
});

it.each([
  ['openrouter', `pfm_test_${CANARY}abc`],
  ['postforme', `sk-or-v1-${CANARY}-fake`],
  ['tikhub', `short${CANARY}`.slice(0, 10)],
  ['tikhub', `has space ${CANARY}-fake`],
  ['unknown', `whatever-${CANARY}-fake-value`],
])('rejects a malformed %s key without echoing it', async (slot, value) => {
  const f = harness('admin');
  const error = await f.caller.set({ slot: slot as 'tikhub', value, expectedRevision: 0 }).catch(e => e);
  expect(error).toMatchObject({ code: 'BAD_REQUEST' });
  expect(JSON.stringify({ message: error.message, cause: String(error.cause) })).not.toContain(CANARY);
  expect(f.calls).toEqual([]);
});

it.each([
  ['42501', 'FORBIDDEN'], ['23514', 'BAD_REQUEST'], ['55000', 'SERVICE_UNAVAILABLE'], ['XX000', 'SERVICE_UNAVAILABLE'],
])('maps database code %s to %s and logs only the code', async (dbCode, trpcCode) => {
  const f = harness('admin', { failCode: dbCode });
  const error = await f.caller.set({ slot: 'openrouter', value: OPENROUTER, expectedRevision: 0 }).catch(e => e);
  expect(error).toMatchObject({ code: trpcCode });
  expect(JSON.stringify(error)).not.toContain(CANARY);
  expect(logged.join('\n')).not.toContain(CANARY);
});

it('shows the transition fallback: environment present with its last four characters', async () => {
  vi.stubEnv('POSTFORME_API_KEY', 'pfm_test_fakeenvironment9z8y');
  try {
    const { slots } = await harness('admin').caller.status();
    expect(slots.find(s => s.slot === 'postforme')).toMatchObject({ configured: false, source: 'env',
      envFallback: { name: 'POSTFORME_API_KEY', present: true, last4: '9z8y' } });
    expect(slots.find(s => s.slot === 'openrouter')).toMatchObject({ source: 'none', envFallback: null });
    expect(JSON.stringify(slots)).not.toContain('fakeenvironment');
  } finally { vi.unstubAllEnvs(); }
});


it('uses committed writer metadata without a second status RPC', async () => {
  const f = harness('admin', { failStatus: true });
  const saved = await f.caller.set({ slot: 'openrouter', value: OPENROUTER, expectedRevision: 0 });
  expect(saved.slots[0]).toMatchObject({ configured: true, revision: 1, last4: 'c3d4' });
  const cleared = await f.caller.clear({ slot: 'openrouter', expectedRevision: 1 });
  expect(cleared.slots[0]).toMatchObject({ configured: false, revision: 2, last4: null });
  expect(f.calls.map(([name]) => name)).toEqual(['platform_secret_set', 'platform_secret_clear']);
});

it.each(['error', 'throw'] as const)('keeps successful writes when operator lookup returns %s', async failEmail => {
  const f = harness('admin', { failEmail });
  const saved = await f.caller.set({ slot: 'openrouter', value: OPENROUTER, expectedRevision: 0 });
  expect(saved.statusRefreshFailed).toBe(true);
  expect(saved.slots[0]).toMatchObject({ configured: true, revision: 1, last4: 'c3d4', updatedByEmail: null });
  const cleared = await f.caller.clear({ slot: 'openrouter', expectedRevision: 1 });
  expect(cleared.statusRefreshFailed).toBe(true);
  expect(cleared.slots[0]).toMatchObject({ configured: false, revision: 2 });
  await expect(f.caller.status()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(JSON.stringify([saved, cleared, logged])).not.toContain(CANARY);
});
