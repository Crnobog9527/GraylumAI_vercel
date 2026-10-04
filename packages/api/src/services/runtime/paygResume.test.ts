/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { beginPaygExecution, type RuntimeExecution } from './paygResume';
const id = '10000000-0000-4000-8000-000000000001';
function fixture(state = 'waiting_credits', staging = false) {
  const execution = { executionId: id, state, cursor: 3, epoch: 2, remainingCalls: 1,
    primaryResult: { body: 'saved reply' }, billing: { contractVersion: 'bill2.v2',
      mode: staging ? 'staging_test' : 'isolated', callPolicy: [] } } as unknown as RuntimeExecution;
  const read = vi.fn(async (action: string) => action === 'payg_resume'
    ? { ...execution, live: true, state: 'running', epoch: 3 } : execution);
  const callGate = vi.fn(async () => ({ ok: true as const }));
  return { executionId: id, execution, read, actor: async () => id, callGate,
    resume: { executionId: id, cursor: 3, epoch: 2 } };
}
describe('explicit original-execution resume', () => {
  it.each(['waiting_credits', 'waiting_resume'])('reading %s never grants execution', async state => {
    const f = fixture(state);
    const result = await beginPaygExecution({ ...f, resume: undefined });
    expect(result.wait).toMatchObject({ state, cursor: 3, epoch: 2, remainingCalls: 1, body: 'saved reply' });
    expect(f.callGate).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledExactlyOnceWith('begin');
  });
  it('counts only remaining calls and passes the exact CAS token', async () => {
    const f = fixture();
    const result = await beginPaygExecution(f);
    expect(f.callGate).toHaveBeenCalledExactlyOnceWith(id, 1);
    expect(f.read).toHaveBeenLastCalledWith('payg_resume', { cursor: 3, epoch: 2 });
    expect(result).toMatchObject({ resumedGate: true, execution: { live: true, epoch: 3 } });
  });
  it.each(['call_limited', 'paused', 'limit_unavailable'] as const)('keeps the durable wait on %s', async reason => {
    const f = fixture();
    const result = await beginPaygExecution({ ...f, callGate: async () => ({ ok: false, reason, retryAfter: 60 }) });
    expect(result.wait).toMatchObject({ state: 'waiting_credits', unavailable: reason, epoch: 2 });
    expect(f.read).toHaveBeenCalledExactlyOnceWith('read');
  });
  it('fails closed when the calls service throws without changing the epoch', async () => {
    const f = fixture();
    expect((await beginPaygExecution({ ...f, callGate: async () => { throw Error('offline'); } })).wait)
      .toMatchObject({ unavailable: 'limit_unavailable' });
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale cursor before rate consumption or resume mutation', async () => {
    const f = fixture();
    await expect(beginPaygExecution({ ...f, resume: { ...f.resume, cursor: 2 } })).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
    expect(f.callGate).not.toHaveBeenCalled();
  });
  it('rechecks staging prices before CAS; a price increase preserves waiting', async () => {
    const f = fixture('waiting_resume', true);
    const resumePricing = vi.fn(async () => { throw Error('RUNTIME_PRICE_INCREASED'); });
    expect((await beginPaygExecution({ ...f, resumePricing })).wait)
      .toMatchObject({ state: 'waiting_resume', unavailable: 'RUNTIME_PRICE_CONFIGURATION_PENDING' });
    expect(resumePricing).toHaveBeenCalledWith([]);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('requires staging price validation and never resumes ordinary running or v1 executions', async () => {
    expect((await beginPaygExecution(fixture('waiting_resume', true))).wait?.unavailable).toBe('RUNTIME_PRICE_UNCONFIRMED');
    await expect(beginPaygExecution(fixture('running'))).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
  });
});
it.each(['waiting_credits', 'waiting_resume'])('keeps %s and its CAS token for quota adjustment', async state => {
  const f = fixture(state);
  const rejected = await beginPaygExecution({ ...f, callGate: async () => ({
    ok: false, reason: 'usage_configuration_required', retryAfter: 0,
  }) });
  expect(rejected.wait).toMatchObject({ state, code: 'RUNTIME_USAGE_CONFIGURATION_REQUIRED',
    unavailable: 'usage_configuration_required', cursor: 3, epoch: 2, body: 'saved reply' });
  expect(f.read).toHaveBeenCalledExactlyOnceWith('read');
  expect((await beginPaygExecution(f)).resumedGate).toBe(true);
});
it.each(['prepared', 'running', 'interrupted', 'completed', 'waiting_credits', 'waiting_resume'])
('rejects v1 resume in %s without mutation or calls consumption', async state => {
  const f = fixture(state);
  f.execution.billing.contractVersion = 'bill2.v1';
  await expect(beginPaygExecution(f)).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
  expect(f.read).toHaveBeenCalledExactlyOnceWith('read');
  expect(f.callGate).not.toHaveBeenCalled();
});
