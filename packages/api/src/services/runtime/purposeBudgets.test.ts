/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePurposeBudgets, purposeBudgetsSchema, readPurposeBudgets,
  readPurposeBudgetView, savePurposeBudgets, PURPOSE_OUTPUT_CAP } from './purposeBudgets';
const old = { version: 1 as const, interactive: { inputBytes: 24000, historyItems: 7, maxOutputTokens: 2000 },
  organize: { inputBytes: 16000, historyItems: 0 }, report: { inputBytes: 64000, historyItems: 100, maxOutputTokens: 1000 } };
function database(initial: unknown) {
  let value = initial;
  const db = { from: () => ({ select: () => ({ eq: (_column: string, key: string) => ({
    maybeSingle: async () => ({ data: key === 'runtime_purpose_budgets' ? { value } : { value: 2048 }, error: null }),
  }) }), upsert: async (row: { value: string }) => { value = JSON.parse(row.value); return { error: null }; } }) };
  return { db: db as unknown as SupabaseClient, stored: () => value };
}
it('normalizes legacy reads and stores rollback-compatible v1 while the old admin view remains usable', async () => {
  const f = database(old);
  const config = await readPurposeBudgets(f.db);
  expect(config).toEqual({ version: 2, interactive: { inputBytes: 24000, historyItems: 7 },
    organize: old.organize, report: { inputBytes: 64000, historyItems: 100 } });
  expect(f.stored()).toEqual(old);
  const view = await readPurposeBudgetView(f.db);
  expect(view.config?.version).toBe(1);
  expect(view.config?.interactive.maxOutputTokens).toBe(PURPOSE_OUTPUT_CAP);
  await savePurposeBudgets(f.db, old);
  expect(f.stored()).toEqual({ ...old, interactive: { ...old.interactive, maxOutputTokens: 8192 },
    report: { ...old.report, maxOutputTokens: 8192 } });
  expect(await readPurposeBudgets(f.db)).toEqual(config);
  expect((await readPurposeBudgetView(f.db)).config).toEqual(view.config);
});
it('accepts v2 without output controls and rejects unknown or out-of-bound configuration', () => {
  const v2 = normalizePurposeBudgets(old);
  expect(purposeBudgetsSchema.parse(v2)).toEqual(v2);
  expect(purposeBudgetsSchema.safeParse({ ...v2, interactive: { ...v2.interactive, maxOutputTokens: 1000 } }).success).toBe(false);
  expect(purposeBudgetsSchema.safeParse({ ...old, interactive: { ...old.interactive, maxOutputTokens: 32769 } }).success).toBe(false);
});

it('persists a v2 submission in the v1 shape that previous server releases accept', async () => {
  const f = database(old);
  const input = normalizePurposeBudgets(old);
  input.interactive.inputBytes = 32000;
  await savePurposeBudgets(f.db, input);
  expect(f.stored()).toEqual({ version: 1, interactive: { ...input.interactive, maxOutputTokens: 8192 },
    organize: input.organize, report: { ...input.report, maxOutputTokens: 8192 } });
  expect(await readPurposeBudgets(f.db)).toEqual(input);
});

it('shows 32768 while preserving input budgets, organizer output and rollback-compatible storage', async () => {
  const f = database(old);
  const view = await readPurposeBudgetView(f.db);
  expect(view.limits.maxOutputTokens).toBe(32768);
  expect(view.organizeOutput.maxOutputTokens).toBe(2048);
  expect(view.config?.interactive.inputBytes).toBe(old.interactive.inputBytes);
  expect(purposeBudgetsSchema.safeParse({ ...old, report: { ...old.report, maxOutputTokens: 32768 } }).success).toBe(true);
});
