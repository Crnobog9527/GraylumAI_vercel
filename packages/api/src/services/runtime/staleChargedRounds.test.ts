/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findStaleChargedRounds, STALE_ROUND_AGE_MS, STALE_ROUND_SCAN_LIMIT } from './staleChargedRounds';

const now = Date.parse('2026-10-13T00:00:00.000Z');
type Tables = Record<string, Array<Record<string, unknown>>>;
/** Records every filter so the test can check what the report reads; returns the table rows. */
function database(tables: Tables, failing?: string) {
  const reads: Array<{ table: string; filters: unknown[][] }> = [];
  const client = { from(table: string) {
    const read = { table, filters: [] as unknown[][] }; reads.push(read);
    const query: Record<string, unknown> = {};
    for (const name of ['select', 'in', 'lt', 'not', 'order', 'limit', 'eq', 'gt', 'or'])
      query[name] = (...args: unknown[]) => { read.filters.push([name, ...args]); return query; };
    query.then = (resolve: (value: unknown) => void) =>
      resolve(table === failing ? { data: null, error: { message: 'denied' } } : { data: tables[table] ?? [], error: null });
    return query;
  } } as unknown as SupabaseClient;
  return { client, reads };
}
const old = new Date(now - STALE_ROUND_AGE_MS - 1000).toISOString();
const execution = (n: number) => ({ id: 'e-' + n, actor_id: 'a-' + n, billing_run_id: 'r-' + n, created_at: old });
const settled = (run: string, charged: number, extra: Record<string, unknown> = {}) => ({ run_id: run,
  dispatched_at: old, settled_at: old, provider_rejected: false, charged_delta: charged, compensated_at: null, ...extra });

it('lists open charged rounds older than 24 hours, skipping unknown, uncharged, compensated and refunded ones', async () => {
  const f = database({
    runtime_executions: [1, 2, 3, 4, 5, 6].map(execution),
    // r-6 is closed or not PAYG: absent from the open v2 runs.
    bill2_runs: [1, 2, 3, 4, 5].map(n => ({ id: 'r-' + n })),
    bill2_calls: [
      settled('r-1', 1), settled('r-1', 2),
      settled('r-2', 3), { ...settled('r-2', 0), settled_at: null },
      settled('r-3', 0),
      settled('r-4', 2, { compensated_at: old }),
      settled('r-5', 4),
    ],
    credit_transactions: [{ idempotency_key: null, description: '[Admin] stale-round:r-5 系统原因未完成回合退款' }],
  });
  const report = await findStaleChargedRounds(f.client, now);
  expect(report).toEqual({ success: false, truncated: false, findings: [{ kind: 'stale_charged_round', executionId: 'e-1',
    runId: 'r-1', chargedCredits: 3, since: old, refundMarker: 'stale-round:r-1' }] });
  const scan = f.reads.find(read => read.table === 'runtime_executions')!.filters;
  expect(scan).toContainEqual(['in', 'state', ['prepared', 'running', 'interrupted']]);
  expect(scan).toContainEqual(['lt', 'created_at', new Date(now - STALE_ROUND_AGE_MS).toISOString()]);
  expect(f.reads.find(read => read.table === 'bill2_runs')!.filters).toEqual(expect.arrayContaining([
    ['eq', 'contract_version', 'bill2.v2'], ['eq', 'closed', false]]));
  // Only positive credit adjustments of the affected users can settle a report.
  expect(f.reads.find(read => read.table === 'credit_transactions')!.filters).toEqual(expect.arrayContaining([
    ['in', 'user_id', ['a-1', 'a-5']], ['gt', 'amount', 0]]));
});

it('a refund recorded under the idempotency key also settles the report', async () => {
  const f = database({ runtime_executions: [execution(1)], bill2_runs: [{ id: 'r-1' }], bill2_calls: [settled('r-1', 1)],
    credit_transactions: [{ idempotency_key: 'admin_adjustment:admin:a-1:stale-round:r-1', description: '[Admin] refund' }] });
  expect(await findStaleChargedRounds(f.client, now)).toEqual({ success: true, findings: [], truncated: false });
});

it('reports a full page as truncated and fails closed on any read error', async () => {
  const many = Array.from({ length: STALE_ROUND_SCAN_LIMIT }, (_, n) => execution(n));
  expect((await findStaleChargedRounds(database({ runtime_executions: many }).client, now)).truncated).toBe(true);
  for (const table of ['runtime_executions', 'bill2_runs', 'bill2_calls', 'credit_transactions']) {
    const f = database({ runtime_executions: [execution(1)], bill2_runs: [{ id: 'r-1' }], bill2_calls: [settled('r-1', 1)] }, table);
    await expect(findStaleChargedRounds(f.client, now)).rejects.toThrow('STALE_ROUND_SCAN_FAILED');
  }
});
