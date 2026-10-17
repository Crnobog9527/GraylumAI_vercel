/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAutomaticFinancialRecovery } from './automaticRecovery';
const mocks = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('./staleChargedRounds', async original => ({ ...await original<typeof import('./staleChargedRounds')>(),
  autoCompensateStaleRounds: mocks.close }));
const closed = { found: 1, compensated: 1, alreadyCompensated: 0, skipped: 0, failed: 0, credits: 3, deferred: 0 };
const order: string[] = [];
function admin() {
  const rpc = vi.fn((name: string) => {
    order.push(name);
    const result = Promise.resolve({ data: [], error: null });
    return Object.assign(result, { abortSignal: () => result });
  });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}
beforeEach(() => { order.length = 0; mocks.close.mockReset().mockImplementation(async () => { order.push('close'); return closed; }); });

it('the scheduled job closes stale rounds after financial recovery, within its own time budget', async () => {
  const a = admin();
  expect(await runAutomaticFinancialRecovery(a.client)).toEqual({ selected: 0, processed: 0, settled: 0, pending: 0, failed: 0,
    staleRounds: closed });
  // Recovery first: a call it settles is activity, so that round waits another 24 hours.
  expect(order).toEqual(['runtime_pending_financial_batch', 'close']);
  const [database, options] = mocks.close.mock.calls[0]!;
  // Every database request goes through the bounded client, never the raw service client.
  await database.rpc('runtime_stale_charged_rounds', {});
  expect(a.rpc).toHaveBeenLastCalledWith('runtime_stale_charged_rounds', {});
  expect(options.canStart()).toBe(true);
});

it('a user admission recovers only that user and never refunds rounds', async () => {
  const a = admin();
  expect(await runAutomaticFinancialRecovery(a.client, '10000000-0000-4000-8000-000000000001'))
    .toEqual({ selected: 0, processed: 0, settled: 0, pending: 0, failed: 0 });
  expect(mocks.close).not.toHaveBeenCalled();
});

it('no time left even to read the report is a failure, never a silent success', async () => {
  let clock = 0;
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const rpc = vi.fn(() => {
    // The recovery batch ran long: afterwards the whole job budget is gone.
    clock += 10 ** 9;
    const result = Promise.resolve({ data: [], error: null });
    return Object.assign(result, { abortSignal: () => result });
  });
  try {
    const result = await runAutomaticFinancialRecovery({ rpc } as unknown as SupabaseClient);
    expect(result.staleRounds).toMatchObject({ failed: 1, deferred: 0 });
    expect(mocks.close).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});
