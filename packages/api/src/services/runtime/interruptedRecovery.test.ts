/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { expect, it, vi } from 'vitest';
import { erasureFinancialBudget } from '../accountErasure/financialRecovery';
import { recoverInterruptedExecutions } from './interruptedRecovery';

const actor = '10000000-0000-4000-8000-000000000001';
const execution = '10000000-0000-4000-8000-000000000002';
const item = { actorId: actor, executionId: execution, runId: actor, epoch: 1 };
function fixture(items: unknown = [item]) {
  const finish = vi.fn(async () => ({ data: { state: 'cancelled' }, error: null as unknown }));
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => args.p_execution_id
    ? finish() : { data: items, error: null });
  return { rpc, finish, input: { database: { rpc }, actorId: actor, budget: erasureFinancialBudget(8_000) } };
}
it('uses only service-owned identities and the original epoch, without a provider capability', async () => {
  const f = fixture();
  expect(await recoverInterruptedExecutions(f.input)).toEqual({ selected: 1, processed: 1, settled: 1, pending: 0, failed: 0 });
  expect(f.rpc.mock.calls).toEqual([
    ['runtime_interrupted_recovery', { p_actor_id: actor, p_limit: 20 }],
    ['runtime_interrupted_recovery', { p_actor_id: actor, p_execution_id: execution, p_epoch: 1 }],
  ]);
});
it('records a lost race as skipped, never successful cancellation', async () => {
  const f = fixture(); f.finish.mockResolvedValue({ data: { state: 'skipped' }, error: null });
  expect(await recoverInterruptedExecutions(f.input)).toMatchObject({ processed: 1, settled: 0, pending: 1, failed: 0 });
});
it('never retries an ambiguous mutation or claims it settled', async () => {
  const f = fixture(); f.finish.mockRejectedValue(new Error('synthetic response loss'));
  expect(await recoverInterruptedExecutions(f.input)).toMatchObject({ settled: 0, failed: 1 });
  expect(f.finish).toHaveBeenCalledTimes(1);
});
it('fails closed on a cross-actor inventory and skips lookup when out of time', async () => {
  const f = fixture([{ ...item, actorId: execution }]);
  expect(await recoverInterruptedExecutions(f.input)).toMatchObject({ failed: 1, settled: 0 });
  expect(f.finish).not.toHaveBeenCalled();
  const timed = fixture(); timed.input.budget = erasureFinancialBudget(2_000);
  expect(await recoverInterruptedExecutions(timed.input)).toMatchObject({ selected: 0, failed: 0 });
  expect(timed.rpc).not.toHaveBeenCalled();
});
