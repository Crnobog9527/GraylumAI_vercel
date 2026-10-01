/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { runtimeRateLimitsRouter } from './runtimeRateLimits';
import { settingsRouter } from './settings';
import {
  DEFAULT_RUNTIME_RATE_LIMITS as config, RUNTIME_RATE_LIMIT_KEY as key, readRuntimeRateLimits, saveRuntimeRateLimits,
} from '../services/runtime/rateLimitSettings';
function harness(role: 'admin' | 'user' | 'anonymous') {
  const stored = new Map<string, unknown>();
  const writes: unknown[] = [];
  const db = { from(table: string) {
    if (table === 'profiles') return { select() { return this; }, eq() { return this; },
      single: async () => ({ data: { id: 'actor', role, status: 'active', credits: 0, nickname: 'Synthetic', email: 'synthetic@example.test' }, error: null }) };
    if (table !== 'system_settings') throw new Error(table);
    let key = '';
    return { select() { return this; }, eq(_field: string, value: string) { key = value; return this; },
      maybeSingle: async () => ({ data: stored.has(key) ? { key, value: stored.get(key) } : null, error: null }),
      upsert: async (row: { key: string; value: unknown }) => {
        writes.push(row); stored.set(row.key, row.value); return { error: null };
      } };
  } };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: 'actor', email: 'synthetic@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: runtimeRateLimitsRouter.createCaller(ctx), generic: settingsRouter.createCaller(ctx), stored, writes, db };
}

it('reads explicit defaults, saves all settings and reads actual stored state back', async () => {
  const f = harness('admin');
  expect(await f.caller.get()).toMatchObject({ source: 'default', config,
    enforcement: { admission: false, calls: false, pause: false } });
  const changed = { ...config, admissionPerMinute: 9, stopNewCalls: true };
  expect(await f.caller.update(changed)).toMatchObject({ source: 'configured', config: changed });
  expect((await f.caller.get()).config).toEqual(changed);
  expect(f.writes).toHaveLength(1);
});
it.each(['user', 'anonymous'] as const)('denies %s both read and write', async role => {
  const f = harness(role);
  for (const call of [() => f.caller.get(), () => f.caller.update(config)])
    await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  expect(f.writes).toEqual([]);
});
it.each([
  { ...config, admissionPerMinute: 0 }, { ...config, admissionPerMinute: 61 },
  { ...config, admissionPerMinute: 1.5 }, { ...config, admissionPer24Hours: 5001 },
  { ...config, admissionPer24Hours: 9 }, { ...config, callsPerMinute: 181 },
  { ...config, callsPer24Hours: 15001 }, { ...config, callsPer24Hours: 29 },
  { ...config, version: 2 }, { ...config, stopNewCalls: 'false' },
  { ...config, extra: true }, { ...config, callsPerMinute: -1 },
])('rejects invalid config before writes %#', async invalid => {
  const f = harness('admin');
  await expect(f.caller.update(invalid as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
it('blocks generic single/bulk writes', async () => {
  const f = harness('admin');
  await expect(f.generic.updateSystemSettings({ key, value: config })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(f.generic.updateSystemSettingsBulk([{ key, value: config }])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
it.each(['not-json', 'null', '{}', JSON.stringify({ ...config, version: 2 })])(
  'rejects malformed stored config instead of defaults: %s', async value => {
    const f = harness('admin'); f.stored.set(key, value);
    await expect(f.caller.get()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
it('does not cache configuration or hide a database read failure', async () => {
  const f = harness('admin');
  expect((await f.caller.get()).config.stopNewCalls).toBe(false);
  f.stored.set(key, { ...config, stopNewCalls: true });
  expect((await f.caller.get()).config.stopNewCalls).toBe(true);
  const db = { from: vi.fn(() => { throw new Error('synthetic private database error'); }) };
  await expect(readRuntimeRateLimits(db as never)).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE', message: '无法读取或保存使用额度，请稍后再试',
  });
});

it.each(['write', 'readback'])('does not report success on %s failure', async phase => {
  const query = { select() { return this; }, eq() { return this; },
    upsert: vi.fn(async () => ({ error: phase === 'write' ? { message: 'private write detail' } : null })),
    maybeSingle: vi.fn(async () => ({ data: null, error: { message: 'private read detail' } })),
  };
  await expect(saveRuntimeRateLimits({ from: () => query } as never, config))
    .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: '无法读取或保存使用额度，请稍后再试' });
  expect(query.upsert).toHaveBeenCalledTimes(1);
  expect(query.maybeSingle).toHaveBeenCalledTimes(phase === 'write' ? 0 : 1);
});
