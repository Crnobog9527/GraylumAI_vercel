/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { erasureFinancialBudget } from '../accountErasure/financialRecovery';
import { recoverPendingFinancials } from './automaticRecovery';
import type { BillingTransport } from '../bill2/service';
const mocks = vi.hoisted(() => ({ recover: vi.fn(), billing: vi.fn() }));
vi.mock('../bill2/service', async original => ({ ...await original<typeof import('../bill2/service')>(), authoritativeBilling: mocks.billing }));
const actor = '10000000-0000-4000-8000-000000000001';
const execution = '10000000-0000-4000-8000-000000000002';
const item = { actorId: actor, executionId: execution,
  runId: '10000000-0000-4000-8000-000000000003', recoveryPolicy: { synthetic: true }, finishAllowed: true };
beforeEach(() => {
  mocks.recover.mockReset().mockResolvedValue({ state: 'cancelled' });
  mocks.billing.mockReset().mockReturnValue({ recoverReceipts: mocks.recover });
});
function fixture(items: unknown = [item]) {
  const rpc = vi.fn(async (name: string) => ({ data: name === 'runtime_pending_financial_batch' ? items : { state: 'cancelled' }, error: null }));
  const transport = { lookup: vi.fn(), dispatch: vi.fn() } as unknown as BillingTransport;
  const adapter = vi.fn(() => transport);
  return { rpc, adapter, input: { database: { rpc }, budget: erasureFinancialBudget(8_000), actorId: actor, adapter } };
}
it('recovers only the authenticated actor inventory before returning, using a lookup-only host', async () => {
  const f = fixture();
  expect(await recoverPendingFinancials(f.input)).toEqual({ selected: 1, processed: 1, settled: 1, pending: 0, failed: 0 });
  expect(f.rpc).toHaveBeenCalledWith('runtime_pending_financial_batch', { p_actor_id: actor, p_limit: 20 });
  expect(mocks.recover).toHaveBeenCalledWith(item.runId, { timeoutMs: 2_000 });
  const options = mocks.billing.mock.calls[0]![0];
  expect(await options.actor()).toBe(actor);
  await expect(options.adapter.dispatch()).rejects.toThrow('RUNTIME_DISPATCH_DISABLED');
});
it('rejects a cross-actor inventory before constructing any transport', async () => {
  const f = fixture([{ ...item, actorId: execution }]);
  expect((await recoverPendingFinancials(f.input)).failed).toBe(1);
  expect(f.adapter).not.toHaveBeenCalled();
  expect(mocks.recover).not.toHaveBeenCalled();
});
it('continues the bounded batch after lookup failure and keeps unresolved results pending', async () => {
  const f = fixture([item, { ...item, executionId: item.runId }]);
  mocks.recover.mockRejectedValueOnce(new Error('synthetic network failure')).mockResolvedValueOnce({ state: 'cost_pending' });
  f.rpc.mockImplementation(async name => ({ data: name === 'runtime_pending_financial_batch' ? [item, item] : { state: 'cost_pending' }, error: null }));
  expect(await recoverPendingFinancials(f.input)).toEqual({ selected: 2, processed: 1, settled: 0, pending: 1, failed: 1 });
});
it('does not claim a recovery with insufficient remaining request budget', async () => {
  const f = fixture();
  f.input.budget = erasureFinancialBudget(2_000);
  expect((await recoverPendingFinancials(f.input)).processed).toBe(0);
  expect(mocks.recover).not.toHaveBeenCalled();
});
it('global cron selection uses service inventory and respects each original actor', async () => {
  const f = fixture();
  await recoverPendingFinancials({ ...f.input, actorId: undefined });
  expect(f.rpc).toHaveBeenCalledWith('runtime_pending_financial_batch', { p_actor_id: null, p_limit: 20 });
  expect(await mocks.billing.mock.calls[0]![0].actor()).toBe(actor);
});
it('storage failure never reports settlement', async () => {
  const f = fixture(); f.rpc.mockRejectedValue(new Error('synthetic'));
  expect(await recoverPendingFinancials(f.input)).toEqual({ selected: 0, processed: 0, settled: 0, pending: 0, failed: 1 });
});

it('queries unknown live calls without closing or cancelling their execution', async () => {
  const f = fixture([{ ...item, finishAllowed: false }]);
  expect((await recoverPendingFinancials(f.input)).pending).toBe(1);
  expect(mocks.recover).toHaveBeenCalledTimes(1);
  expect(f.rpc).not.toHaveBeenCalledWith('runtime_financial_recovery', expect.anything());
});
