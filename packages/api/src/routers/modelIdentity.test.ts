/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { modelIdentityRouter } from './modelIdentity';
import { settingsRouter } from './settings';

const ACTOR = '00000000-0000-4000-8000-0000000000aa';
function harness(role: 'admin' | 'user' | 'anonymous') {
  let config = { version: 1, enabled: true, revision: 0, updatedBy: null as string | null, updatedAt: null as string | null };
  const writes: unknown[] = [];
  const logs: Array<{ admin_id: string; details: { enabled: boolean }; created_at: string }> = [];
  const chain = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'in']) q[k] = () => q;
    q.limit = async () => ({ data: rows(), error: null });
    q.then = (resolve: (v: unknown) => void) => resolve({ data: rows(), error: null });
    q.single = async () => ({ data: { id: ACTOR, role, status: 'active', is_deleted: 'false', credits: 0, nickname: 'Synthetic',
      email: 'admin@example.test' }, error: null });
    return q;
  };
  const db = {
    from: (table: string) => {
      if (table === 'user_activity_logs') return chain(() => [...logs].reverse());
      if (table === 'profiles') return chain(() => [{ id: ACTOR, email: 'admin@example.test' }]);
      throw new Error(table);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'model_identity_guard_config') return { data: config, error: null };
      if (name !== 'model_identity_guard_set') throw new Error(name);
      writes.push(args);
      if (args.p_expected_revision !== config.revision) return { data: null, error: { code: 'PT409' } };
      config = { version: 1, enabled: args.p_enabled as boolean, revision: config.revision + 1,
        updatedBy: args.p_actor as string, updatedAt: '2026-10-12T00:00:00.000000Z' };
      logs.push({ admin_id: ACTOR, details: { enabled: config.enabled }, created_at: '2026-10-12T00:00:00Z' });
      return { data: config, error: null };
    },
  };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: ACTOR, email: 'admin@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', userRole: role === 'admin' ? 'admin' : 'user',
    supabase: db, supabaseAuth: db, supabasePublic: {}, supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: modelIdentityRouter.createCaller(ctx), generic: settingsRouter.createCaller(ctx), writes };
}

it('admin turns the switch off with the acting id and gets the read-back with operator', async () => {
  const f = harness('admin');
  expect((await f.caller.get()).config.enabled).toBe(true);
  const result = await f.caller.set({ enabled: false, expectedRevision: 0 });
  expect(result.config).toMatchObject({ enabled: false, revision: 1, updatedBy: ACTOR });
  expect(result.updatedByEmail).toBe('admin@example.test');
  expect(result.history).toEqual([{ enabled: false, operatorEmail: 'admin@example.test', at: '2026-10-12T00:00:00Z' }]);
  expect(f.writes).toEqual([{ p_enabled: false, p_expected_revision: 0, p_actor: ACTOR }]);
});

it('a stale editor gets a conflict instead of overwriting', async () => {
  const f = harness('admin');
  await f.caller.set({ enabled: false, expectedRevision: 0 });
  await expect(f.caller.set({ enabled: true, expectedRevision: 0 })).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await f.caller.get()).config.enabled).toBe(false);
});

it.each(['user', 'anonymous'] as const)('denies %s both read and write', async role => {
  const f = harness(role);
  for (const call of [() => f.caller.get(), () => f.caller.set({ enabled: false, expectedRevision: 0 })]) {
    await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  }
  expect(f.writes).toEqual([]);
});

it('generic settings save cannot write the switch', async () => {
  const f = harness('admin');
  await expect(f.generic.updateSystemSettings({ key: 'model_identity_guard', value: { enabled: false } }))
    .rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
