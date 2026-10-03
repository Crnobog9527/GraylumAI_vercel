/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { erasureFinancialBudget, recoverErasedAccounts } from './financialRecovery';
const a = '10000000-0000-4000-8000-000000000001';
const e = '10000000-0000-4000-8000-000000000002';
const r = '10000000-0000-4000-8000-000000000003';
const item = { actorId: a, executionId: e, runId: r, reason: 'BILLING_PENDING', recoveryPolicy: {} };
const batch = (items = [item], pending = 1) => ({ selectedActorId: a, items, nextRunId: null,
  totalPending: pending, oldestPendingAt: pending ? '2026-01-01T00:00:00Z' : null,
  reasons: pending ? { BILLING_NO_PROVIDER_ID: pending } : {} });
it('closes without Auth, body access, provider work or a follow-up user request; unknown is not success', async () => {
  let closed = false;
  const rpc = vi.fn(async (name: string) => {
    if (name === 'account_erasure_financial_batch') return { data: batch(closed ? [] : [item]), error: null };
    if (name === 'runtime_financial_recovery') { closed = true; return { data: { state: 'cost_pending', runId: r }, error: null }; }
    return { data: null, error: null };
  });
  const result = await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(5000), profileId: a });
  expect(result).toMatchObject({ success: false, processed: 1, pending: 1, failed: 0 });
  expect(result.oldestPendingAt).toBe('2026-01-01T00:00:00Z');
  expect(rpc.mock.calls.map(([name]) => name)).not.toContain('bill2_recovery_claim');
});
it('isolates a failed run, paginates stable run IDs, and never feeds cross-actor items to recovery', async () => {
  const next = '10000000-0000-4000-8000-000000000004';
  let pages = 0;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'account_erasure_financial_batch') {
      pages++;
      if (pages === 1) return { data: { ...batch(), nextRunId: r }, error: null };
      if (pages === 2) { expect(args.p_after_run_id).toBe(r); return { data: batch([{ ...item, executionId: next }]), error: null }; }
      return { data: batch([], 1), error: null };
    }
    if (name === 'runtime_financial_recovery') return args.p_execution_id === e
      ? { data: null, error: {} } : { data: { state: 'cancelled', runId: next }, error: null };
    return { data: null, error: null };
  });
  const result = await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(5000), profileId: a });
  expect(result).toMatchObject({ success: false, processed: 1, failed: 1 });
  const cross = vi.fn(async () => ({ data: batch([{ ...item, actorId: next }]), error: null }));
  expect(await recoverErasedAccounts({ database: { rpc: cross }, budget: erasureFinancialBudget(5000), profileId: a }))
    .toMatchObject({ success: false, processed: 0, failed: 1 });
  expect(cross).toHaveBeenCalledTimes(1);
});
it('closes before a 45s lookup and stops starting queries when the 60s host margin cannot fit one', async () => {
  let now = 0, queries = 0, closed = false;
  const events: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    events.push(name);
    if (name === 'account_erasure_financial_batch') return { data: batch(closed ? [] : [item]), error: null };
    if (name === 'runtime_financial_recovery') { closed = true; return { data: { state: 'cost_pending', runId: r }, error: null }; }
    if (name === 'bill2_pending_calls') return { data: [r, e], error: null };
    if (name === 'bill2_recovery_claim') return { data: { providerId: 'gen-local', protocol: 'fixture-cost-v1' }, error: null };
    return { data: null, error: null };
  });
  const lookup = vi.fn(async () => { queries++; now += 45_000; throw new Error('bounded timeout'); });
  const report = await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(55_000, () => now),
    profileId: a, adapter: () => ({ dispatch: vi.fn(), lookup }), now: () => now });
  expect(queries).toBe(1);
  expect(report).toMatchObject({ success: false, pending: 1, durationMs: 45_000 });
  expect(events.indexOf('runtime_financial_recovery')).toBeLessThan(events.indexOf('bill2_recovery_claim'));
  const noTime = vi.fn();
  await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(30_000), profileId: a,
    adapter: noTime });
  expect(noTime).not.toHaveBeenCalled();
});
it('inventory/binding failure grants no maintenance authority; an exhausted budget starts no work', async () => {
  const rpc = vi.fn(async () => ({ data: null, error: { message: 'denied' } }));
  expect(await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(5000) }))
    .toMatchObject({ success: false, failed: 1 });
  let now = 0;
  const budget = erasureFinancialBudget(1000, () => now);
  now = 1001; rpc.mockClear();
  expect(await recoverErasedAccounts({ database: { rpc }, budget })).toMatchObject({ success: false, failed: 1 });
  expect(rpc).not.toHaveBeenCalled();
});
