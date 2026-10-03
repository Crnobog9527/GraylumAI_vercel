/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { inflightFinancialHost } from './inflightFinancial';
import { createRuntimeBudget } from './budget';
const actorId = '10000000-0000-4000-8000-000000000001';
const runId = '10000000-0000-4000-8000-000000000002';
const executionId = '10000000-0000-4000-8000-000000000003';
const callId = '10000000-0000-4000-8000-000000000004';
const args = { p_actor_id: actorId, p_run_id: runId, p_call_id: callId };
it.each(['failed', 'rotate', 'foreign'])('does not obtain financial authority from %s dispatch', async mode => {
  const rpc = vi.fn(async () => ({ data: { dispatch: mode === 'foreign' }, error: mode === 'failed' ? {} : null }));
  const host = inflightFinancialHost({ database: { rpc }, actorId, executionId,
    budget: createRuntimeBudget(), actor: vi.fn() });
  await host.database.rpc('bill2_dispatch', { ...args, p_actor_id: mode === 'foreign' ? callId : actorId });
  expect(await host.finish()).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(1);
});
it('keeps a normally active execution open but cancels its original dispatched run after Auth revocation', async () => {
  const actor = vi.fn(async () => actorId);
  let cancelled = false;
  const rpc = vi.fn(async (name: string) => {
    if (name === 'runtime_execution') return { data: { executionId, runId }, error: null };
    if (name === 'bill2_dispatch') return { data: { dispatch: true }, error: null };
    if (name === 'runtime_cancel') { cancelled = true; return { data: {}, error: null }; }
    return cancelled ? { data: { state: 'cost_pending', runId }, error: null }
      : { data: null, error: { message: 'RUNTIME_EXECUTION_STILL_ALLOWED' } };
  });
  const host = inflightFinancialHost({ database: { rpc }, actorId, executionId, actor, budget: createRuntimeBudget() });
  await host.database.rpc('runtime_execution', { p_actor_id: actorId, p_execution_id: executionId });
  await host.database.rpc('bill2_dispatch', args);
  await host.finish(); expect(cancelled).toBe(false);
  actor.mockRejectedValue(new Error('RUNTIME_DENIED'));
  expect(await host.finish()).toMatchObject({ state: 'cost_pending' });
  expect(rpc).toHaveBeenCalledWith('runtime_cancel', { p_actor_id: actorId, p_execution_id: executionId });
});
it('joins financial recovery after the erasure verdict, without another user Auth request or body exposure', async () => {
  const actor = vi.fn();
  const rpc = vi.fn(async (name: string) => ({ data: name === 'runtime_execution' ? { executionId, runId }
    : name === 'bill2_dispatch' ? { dispatch: true }
    : name === 'bill2_record' ? { accountClosed: true } : { state: 'cancelled', runId }, error: null }));
  const host = inflightFinancialHost({ database: { rpc }, actorId, executionId, actor, budget: createRuntimeBudget() });
  await host.database.rpc('runtime_execution', { p_actor_id: actorId, p_execution_id: executionId });
  await host.database.rpc('bill2_dispatch', args);
  await host.database.rpc('bill2_record', args);
  expect(host.isAccountClosed()).toBe(true);
  expect(await host.finish()).toMatchObject({ state: 'cancelled' });
  expect(actor).not.toHaveBeenCalled();
});

it('cannot borrow a dispatched run from another execution owned by the same actor', async () => {
  const rpc = vi.fn(async (name: string) => ({ data: name === 'runtime_execution'
    ? { executionId, runId } : { dispatch: true }, error: null }));
  const host = inflightFinancialHost({ database: { rpc }, actorId, executionId, actor: vi.fn(), budget: createRuntimeBudget() });
  await host.database.rpc('runtime_execution', { p_actor_id: actorId, p_execution_id: executionId });
  await host.database.rpc('bill2_dispatch', { ...args, p_run_id: callId });
  expect(await host.finish()).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(2);
});
