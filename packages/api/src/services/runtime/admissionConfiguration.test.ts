/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import {it, expect, vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {readAdmissionConfiguration} from './admissionConfiguration';
import {newWorkGate, readAdmissionSettings} from './newWorkGate';
import {readPurposeBudgets} from './purposeBudgets';
import {summaryPolicy} from '../artifacts/summaryPolicy';
import {DEFAULT_RUNTIME_RATE_LIMITS} from './rateLimitSettings';

const primary = '10000000-0000-4000-8000-000000000001';
const summary = '10000000-0000-4000-8000-000000000002';
const budget = {version: 2, interactive: {inputBytes: 64000, historyItems: 100},
  organize: {inputBytes: 64000, historyItems: 0}, report: {inputBytes: 90000, historyItems: 0}};
function fixture() {
  let stopped = false;
  const rows = vi.fn(async () => ({data: [
    {key: 'runtime_rate_limits', value: {...DEFAULT_RUNTIME_RATE_LIMITS, stopNewCalls: stopped}},
    {key: 'runtime_purpose_budgets', value: JSON.stringify(budget)},
    {key: 'v3_summary_model_id', value: summary}, {key: 'v3_summary_max_tokens', value: 2048},
  ], error: null}));
  const fresh = vi.fn(async () => ({data: {value: {...DEFAULT_RUNTIME_RATE_LIMITS, stopNewCalls: stopped}}, error: null}));
  const query = {select: () => query, in: rows, eq: () => query, maybeSingle: fresh};
  const admin = {from: () => query} as unknown as SupabaseClient;
  return {admin, rows, fresh, stop: () => {stopped = true;}};
}
it('shares one snapshot for limits, identity, purpose budget and attached organizer, but refreshes the call gate', async () => {
  const f = fixture(), configuration = readAdmissionConfiguration(f.admin);
  const [gate, budgets, stored] = await Promise.all([
    readAdmissionSettings(f.admin, configuration), readPurposeBudgets(f.admin, configuration), configuration,
  ]);
  expect(gate).toMatchObject({ok: true, identityGuard: true, config: {stopNewCalls: false}});
  expect(budgets).toEqual(budget);
  expect(summaryPolicy(Object.fromEntries(stored.data!.map(row => [row.key, row.value])), primary))
    .toEqual({modelId: summary, maxTokens: 2048});
  expect(f.rows).toHaveBeenCalledTimes(1);
  // A pause committed after admission is still seen immediately before the next model call.
  f.stop();
  expect(await newWorkGate(f.admin, 'staging').calls(primary, 1, 'bill2.v2')).toMatchObject({ok: false, reason: 'paused'});
  expect(f.fresh).toHaveBeenCalledTimes(1);
  expect(await readAdmissionSettings(f.admin, readAdmissionConfiguration(f.admin)))
    .toMatchObject({ok: true, config: {stopNewCalls: true}});
  expect(f.rows).toHaveBeenCalledTimes(2);
});
it('a failed shared read refuses both gate and budget rather than becoming a default', async () => {
  const f = fixture();
  f.rows.mockRejectedValueOnce(Error('private database detail'));
  const configuration = readAdmissionConfiguration(f.admin);
  expect(await readAdmissionSettings(f.admin, configuration)).toEqual({ok: false});
  await expect(readPurposeBudgets(f.admin, configuration)).rejects.toMatchObject({reason: 'RUNTIME_BUDGET_CONFIG_UNAVAILABLE'});
  expect(f.rows).toHaveBeenCalledTimes(1);
});
