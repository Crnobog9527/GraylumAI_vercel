/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { authoritativeBilling, type BillingRpc } from './service';
import { executorRpc } from '../runtime/executorRpc';
import { createRuntimeBudget } from '../runtime/budget';

afterEach(() => { vi.restoreAllMocks(); });
function fixture() {
  const actor = randomUUID(), runId = randomUUID();
  const view = { id: runId, contractVersion: 'bill2.v2', state: 'dispatched', closed: false, conflict: false };
  const adapter = { dispatch: vi.fn(), lookup: vi.fn() };
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{data: unknown; error: unknown}>>()
    .mockResolvedValue({ data: view, error: null });
  const api = authoritativeBilling({ admin: { rpc }, actor: async () => actor, adapter });
  return { actor, runId, view, adapter, rpc, api };
}
it.each(['57014', 'PGRST003', '08006', 'ECONNRESET'])('retries bill2_read once for transient %s', async code => {
  const f = fixture();
  f.rpc.mockResolvedValueOnce({ data: null, error: { code } });
  expect(await f.api.readRun(f.runId)).toEqual(f.view);
  expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_read', 'bill2_read']);
  expect(f.rpc.mock.calls[1]![1]).toEqual(f.rpc.mock.calls[0]![1]);
  expect(f.adapter.dispatch).not.toHaveBeenCalled();
});
it.each(['42501', 'P0001', '22023', 'BILL2_RUN_DENIED'])('never retries read refusal %s', async code => {
  const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: { code } });
  await expect(f.api.readRun(f.runId)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
  expect(f.rpc).toHaveBeenCalledTimes(1);
});
it('stops after the second transient read failure', async () => {
  const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
  await expect(f.api.readRun(f.runId)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
  expect(f.rpc).toHaveBeenCalledTimes(2);
});
it('uses the same original timeout signal for both read attempts', async () => {
  const f = fixture(), signals: AbortSignal[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  let attempts = 0;
  const database: BillingRpc = { rpc: (name, args) => {
    const result = ++attempts === 1 ? { data: null, error: { code: '57014' } } : { data: f.view, error: null };
    return Object.assign(Promise.resolve(result), { abortSignal(signal: AbortSignal) {
      expect(name).toBe('bill2_read'); expect(args.p_actor_id).toBe(f.actor); signals.push(signal); return Promise.resolve(result);
    } });
  } };
  const api = authoritativeBilling({ admin: database, actor: async () => f.actor, adapter: f.adapter });
  await api.readRun(f.runId);
  expect(signals).toHaveLength(2); expect(signals[0]).toBe(signals[1]);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
});
it('does not send a read after the invocation deadline', async () => {
  const f = fixture(); let elapsed = 0; const budget = createRuntimeBudget(() => elapsed); elapsed = budget.persistenceDeadline;
  const api = authoritativeBilling({ admin: { rpc: f.rpc }, actor: async () => f.actor, adapter: f.adapter, budget });
  await expect(api.readRun(f.runId)).rejects.toThrow(); expect(f.rpc).not.toHaveBeenCalled();
});
it('retries exact runtime_receipt_saved reads through the executor, not runtime_response', async () => {
  const f = fixture(); f.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST003' } });
  const rpc = executorRpc({ database: { rpc: f.rpc }, actor: async () => f.actor });
  const args = { p_execution_id: randomUUID(), p_run_id: f.runId, p_call_id: randomUUID(), p_evidence: { synthetic: true } };
  expect(await rpc('runtime_receipt_saved', args)).toEqual(f.view);
  expect(f.rpc.mock.calls[1]![1]).toEqual({ ...args, p_actor_id: f.actor });
  f.rpc.mockClear(); f.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
  await expect(rpc('runtime_response', args)).rejects.toThrow('RUNTIME_DATABASE_UNAVAILABLE');
  expect(f.rpc).toHaveBeenCalledTimes(1);
});
it.each(['bill2_close', 'bill2_cancel'])('does not apply read retries to %s', async name => {
  const f = fixture(); f.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014' } });
  await expect(name === 'bill2_close' ? f.api.closeRun(f.runId, 'cancelled') : f.api.requestCancel(f.runId))
    .rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
  expect(f.rpc).toHaveBeenCalledTimes(1);
});
it('reenters v2 finalize once only after original open-run readback', async () => {
  const f = fixture(); f.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014' } });
  expect(await f.api.finalizeRun(f.runId)).toEqual(f.view);
  expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize', 'bill2_read', 'bill2_finalize']);
  expect(f.rpc.mock.calls[2]![1]).toEqual(f.rpc.mock.calls[0]![1]);
  expect(f.adapter.dispatch).not.toHaveBeenCalled(); expect(f.adapter.lookup).not.toHaveBeenCalled();
});
it('does not retry after a synchronous transport has consumed the original read deadline', async () => {
  const f = fixture(); let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  f.rpc.mockImplementation(async () => { elapsed = 10_001; return { data: null, error: { code: 'ECONNRESET' } }; });
  await expect(f.api.readRun(f.runId)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
  expect(f.rpc).toHaveBeenCalledTimes(1);
});
it('accepts a terminal finalize readback without another write', async () => {
  const f = fixture(); f.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014' } });
  f.rpc.mockResolvedValue({ data: { ...f.view, state: 'refunded', closed: true }, error: null });
  expect(await f.api.finalizeRun(f.runId)).toMatchObject({ state: 'refunded' });
  expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize', 'bill2_read']);
});
it('does not reenter finalize when readback fails', async () => {
  const f = fixture(); f.rpc.mockResolvedValue({ data: null, error: { code: '57014' } });
  await expect(f.api.finalizeRun(f.runId)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
  expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize', 'bill2_read', 'bill2_read']);
});
it.each(['refusal', 'v1', 'identity', 'conflict'])('does not reenter an unsafe finalize readback: %s', async mode => {
  const f = fixture();
  f.rpc.mockResolvedValueOnce({ data: null, error: { code: mode === 'refusal' ? '42501' : '57014' } });
  f.rpc.mockResolvedValue({ data: { ...f.view, ...(mode === 'v1' ? { contractVersion: 'bill2.v1' } : {}),
    ...(mode === 'identity' ? { id: randomUUID() } : {}), conflict: mode === 'conflict' }, error: null });
  await expect(f.api.finalizeRun(f.runId)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
  expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize', 'bill2_read']);
});
it('bounds finalize reentry and inspects the second ambiguous result', async () => {
  const f = fixture(); f.rpc.mockImplementation(async name => name === 'bill2_finalize'
    ? { data: null, error: { code: '57014' } } : { data: f.view, error: null });
  await expect(f.api.finalizeRun(f.runId)).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
  expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['bill2_finalize', 'bill2_read', 'bill2_finalize', 'bill2_read']);
});
