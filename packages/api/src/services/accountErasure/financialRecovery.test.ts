/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { erasureFinancialBudget, recoverErasedAccounts } from './financialRecovery';
const a = '10000000-0000-4000-8000-000000000001';
const batch = (pending = 1) => ({ selectedActorId: a, items: [], nextRunId: null,
  totalPending: pending, oldestPendingAt: pending ? '2026-01-01T00:00:00Z' : null,
  reasons: pending ? { BILLING_NO_PROVIDER_ID: pending } : {} });
it('only counts what is pending and notes the account; it settles, cancels and looks up nothing, and unknown is not success', async () => {
  const rpc = vi.fn(async (name: string) => name === 'account_erasure_financial_batch'
    ? { data: batch(), error: null } : { data: null, error: null });
  const result = await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(5000), profileId: a });
  expect(result).toMatchObject({ success: false, processed: 0, pending: 1, failed: 0 });
  expect(result.oldestPendingAt).toBe('2026-01-01T00:00:00Z');
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(['account_erasure_financial_batch', 'account_erasure_note_error']);
  expect(rpc).toHaveBeenLastCalledWith('account_erasure_note_error', { p_profile_id: a, p_code: 'BILLING_NO_PROVIDER_ID' });
});
it('notes BILLING_CLEAR only when nothing is pending, and a failed note is a failure', async () => {
  const rpc = vi.fn(async (name: string) => name === 'account_erasure_financial_batch'
    ? { data: batch(0), error: null } : { data: null, error: null });
  expect(await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(5000), profileId: a }))
    .toMatchObject({ success: true, pending: 0 });
  expect(rpc).toHaveBeenLastCalledWith('account_erasure_note_error', { p_profile_id: a, p_code: 'BILLING_CLEAR' });
  const bad = vi.fn(async (name: string) => name === 'account_erasure_financial_batch'
    ? { data: batch(0), error: null } : { data: null, error: { message: 'denied' } });
  expect(await recoverErasedAccounts({ database: { rpc: bad }, budget: erasureFinancialBudget(5000), profileId: a }))
    .toMatchObject({ success: false, failed: 1 });
});
it('the cron form (no account) only reads the inventory', async () => {
  const rpc = vi.fn(async () => ({ data: batch(2), error: null }));
  expect(await recoverErasedAccounts({ database: { rpc }, budget: erasureFinancialBudget(5000) }))
    .toMatchObject({ success: false, pending: 2 });
  expect(rpc).toHaveBeenCalledTimes(1);
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
