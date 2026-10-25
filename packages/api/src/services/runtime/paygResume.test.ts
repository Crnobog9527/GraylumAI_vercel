/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { beginPaygExecution, type RuntimeExecution } from './paygResume';
import { StagingAccessError } from './stagingErrors';
const id = '10000000-0000-4000-8000-000000000001';
function fixture(state = 'waiting_credits', staging = false) {
  const execution = { executionId: id, state, cursor: 3, epoch: 2, remainingCalls: 1,
    primaryResult: { body: 'saved reply' }, billing: { contractVersion: 'bill2.v2',
      mode: staging ? 'staging_test' : 'isolated', callPolicy: [], limits: { maxCalls: 1 } } } as unknown as RuntimeExecution;
  const read = vi.fn(async (action: string) => action === 'payg_resume'
    ? { ...execution, live: true, state: 'running', epoch: 3 } : execution);
  const callGate = vi.fn(async () => ({ ok: true as const }));
  return { executionId: id, execution, read, actor: async () => id, callGate,
    resume: { executionId: id, cursor: 3, epoch: 2 } };
}
describe('explicit original-execution resume', () => {
  it.each([
    ['a plain read', undefined, {}],
    ['a refused call gate', { executionId: id, cursor: 3, epoch: 2 }, { callGate: async () => ({ ok: false as const, reason: 'paused' as const, retryAfter: 60 }) }],
  ] as const)('LIB-4b: the execution is observed before %s returns its wait and saved body', async (_name, resume, patch) => {
    const f = fixture(), seen: string[] = [];
    const result = await beginPaygExecution({ ...f, ...patch, resume, observe: execution => { seen.push(execution.state); } });
    expect(result.wait).toMatchObject({ body: 'saved reply' });
    expect(seen).toEqual(['waiting_credits']);
  });
  it.each(['waiting_credits', 'waiting_resume'])('reading %s never grants execution', async state => {
    const f = fixture(state);
    const result = await beginPaygExecution({ ...f, resume: undefined });
    expect(result.wait).toMatchObject({ state, cursor: 3, epoch: 2, remainingCalls: 1, body: 'saved reply' });
    expect(f.callGate).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledExactlyOnceWith('begin');
  });
  it('counts only remaining calls and passes the exact CAS token', async () => {
    const f = fixture('waiting_resume');
    const result = await beginPaygExecution(f);
    expect(f.callGate).toHaveBeenCalledExactlyOnceWith(id, 1, 'bill2.v2');
    expect(f.read).toHaveBeenLastCalledWith('payg_resume', { cursor: 3, epoch: 2 });
    expect(result).toMatchObject({ resumedGate: true, execution: { live: true, epoch: 3 } });
  });
  it.each(['call_limited', 'paused', 'limit_unavailable'] as const)('keeps the durable wait on %s', async reason => {
    const f = fixture('waiting_resume');
    const result = await beginPaygExecution({ ...f, callGate: async () => ({ ok: false, reason, retryAfter: 60 }) });
    expect(result.wait).toMatchObject({ state: 'waiting_resume', unavailable: reason, epoch: 2 });
    expect(f.read).toHaveBeenCalledExactlyOnceWith('read');
  });
  it('fails closed when the calls service throws without changing the epoch', async () => {
    const f = fixture('waiting_resume');
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
  // staging 2026-10-24: the window this round was frozen to was switched off while its organizer waited.
  it('a refused frozen window or model marks the wait as never resumable; a price check failure does not', async () => {
    const f = fixture('waiting_resume', true);
    f.read.mockImplementation(async (action: string) => {
      if (action === 'payg_resume') throw new StagingAccessError('RUNTIME_PRICE_CONFIGURATION_PENDING');
      return f.execution;
    });
    expect((await beginPaygExecution({ ...f, resumePricing: async () => {} })).wait)
      .toMatchObject({ state: 'waiting_resume', body: 'saved reply', resumeClosed: true });
    const priced = fixture('waiting_resume', true);
    const wait = (await beginPaygExecution({ ...priced, resumePricing: async () => { throw Error('RUNTIME_PRICE_SNAPSHOT_STALE'); } })).wait;
    expect(wait).toMatchObject({ unavailable: 'RUNTIME_PRICE_CONFIGURATION_PENDING' });
    expect(wait).not.toHaveProperty('resumeClosed');
  });
  it('requires staging price validation and never resumes ordinary running or v1 executions', async () => {
    expect((await beginPaygExecution(fixture('waiting_resume', true))).wait?.unavailable).toBe('RUNTIME_PRICE_UNCONFIRMED');
    await expect(beginPaygExecution(fixture('running'))).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
  });
});
it('rechecks limits without consuming a second slot when resuming the same waiting-credit claim', async () => {
  const f = fixture('waiting_credits');
  const result = await beginPaygExecution(f);
  expect(f.callGate).toHaveBeenCalledExactlyOnceWith(id, 1, 'bill2.v2', false, false);
  expect(result).toMatchObject({ resumedGate: true, execution: { live: true, epoch: 3 } });
});
it('rechecks a post-claim waiting-resume without consuming a second slot', async () => {
  const f = fixture('waiting_resume');
  f.execution.gatePassed = true;
  const result = await beginPaygExecution(f);
  expect(f.callGate).toHaveBeenCalledExactlyOnceWith(id, 1, 'bill2.v2', false, false);
  expect(result).toMatchObject({ resumedGate: true, execution: { live: true, epoch: 3 } });
});
it('reserves on waiting-resume when the checkpoint says its first call gate was not passed', async () => {
  const f = fixture('waiting_resume');
  f.execution.gatePassed = false;
  const result = await beginPaygExecution(f);
  expect(f.callGate).toHaveBeenCalledExactlyOnceWith(id, 1, 'bill2.v2');
  expect(result.resumedGate).toBe(true);
});
it('still reserves a later call when prior claims exist, but skips the round-pause switch', async () => {
  const f = fixture('waiting_resume');
  f.execution.billing.limits.maxCalls = 2;
  f.execution.remainingCalls = 1;
  f.execution.gatePassed = false;
  await beginPaygExecution(f);
  expect(f.callGate).toHaveBeenCalledExactlyOnceWith(id, 1, 'bill2.v2', true, false);
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

it('uses the existing cursor/epoch CAS to close a settled exhausted wait without calls or prices',async()=>{
 const f=fixture('waiting_resume',true);f.execution.remainingCalls=0;
 const closed={...f.execution,state:'cancelled',cancelRequested:true};
 f.read.mockImplementation(async action=>action==='payg_resume'?closed:f.execution);
 const actor=vi.fn(async()=>id),resumePricing=vi.fn();
 expect(await beginPaygExecution({...f,actor,resumePricing})).toEqual({execution:closed,resumedGate:false});
 expect(actor).toHaveBeenCalledTimes(1);
 expect(f.read).toHaveBeenLastCalledWith('payg_resume',{cursor:3,epoch:2});
 expect(f.callGate).not.toHaveBeenCalled();expect(resumePricing).not.toHaveBeenCalled();
});
it('does not close exhausted waiting on stale ownership or unresolved SQL settlement',async()=>{
 const f=fixture('waiting_resume');f.execution.remainingCalls=0;
 await expect(beginPaygExecution({...f,resume:{...f.resume,epoch:1}})).rejects.toThrow('RUNTIME_RESUME_CONFLICT');
 expect(f.read).toHaveBeenCalledExactlyOnceWith('read');
 f.read.mockImplementation(async action=>{if(action==='payg_resume')throw Error('RUNTIME_CHECKPOINT_PENDING');return f.execution;});
 await expect(beginPaygExecution(f)).rejects.toThrow('RUNTIME_CHECKPOINT_PENDING');
 expect(f.callGate).not.toHaveBeenCalled();
});
