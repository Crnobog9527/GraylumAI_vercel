/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { mentorBudgetRouter } from './mentorBudget';
import { settingsRouter } from './settings';
import { PURPOSE_BUDGET_KEY, PURPOSE_INPUT_CAPS } from '../services/runtime/purposeBudgets';
const config = { version: 1 as const,
  interactive: { inputBytes: 80000, maxOutputTokens: 32000, historyItems: 100 },
  organize: { inputBytes: 64000, historyItems: 0 },
  report: { inputBytes: 80000, maxOutputTokens: 64000, historyItems: 0 } };
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
  return { caller: mentorBudgetRouter.createCaller(ctx), generic: settingsRouter.createCaller(ctx), stored, writes };
}
it('admin saves and reads back; organizer output keeps its sole authority', async () => {
  const f = harness('admin');
  expect(await f.caller.get()).toMatchObject({ source: 'legacy', config: null, organizeOutput: { maxOutputTokens: 2048 } });
  f.stored.set('v3_summary_max_tokens', '3072');
  expect(await f.caller.update(config)).toMatchObject({ source: 'configured', config,
    organizeOutput: { source: 'v3_summary_max_tokens', maxOutputTokens: 3072 } });
  expect((await f.caller.get()).config).toEqual(config);
  expect(f.writes).toHaveLength(1);
});
it.each(['user', 'anonymous'] as const)('denies %s without writing settings', async role => {
  const f = harness(role);
  for (const call of [() => f.caller.get(), () => f.caller.update(config)])
    await expect(call()).rejects.toMatchObject({ code: role === 'anonymous' ? 'UNAUTHORIZED' : 'FORBIDDEN' });
  expect(f.writes).toEqual([]);
});
it.each([
  { ...config, interactive: { ...config.interactive, inputBytes: PURPOSE_INPUT_CAPS.interactive + 1 } },
  { ...config, organize: { ...config.organize, inputBytes: PURPOSE_INPUT_CAPS.organize + 1 } },
  { ...config, report: { ...config.report, inputBytes: PURPOSE_INPUT_CAPS.report + 1 } },
  { ...config, organize: { ...config.organize, maxOutputTokens: 3000 } },
  { ...config, interactive: { ...config.interactive, maxOutputTokens: 128001 } },
  { ...config, report: { ...config.report, historyItems: -1 } },
  { ...config, interactive: { ...config.interactive, inputBytes: 2.5 } },
  { ...config, unknown: true },
])('rejects invalid configuration before any write %#', async invalid => {
  const f = harness('admin');
  await expect(f.caller.update(invalid)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
it('generic single/bulk settings APIs cannot bypass the budget contract', async () => {
  const f = harness('admin'), row = { key: PURPOSE_BUDGET_KEY, value: config };
  await expect(f.generic.updateSystemSettings(row)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(f.generic.updateSystemSettingsBulk([row])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(f.writes).toEqual([]);
});
