/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { processAccountErasure } from './processor';
import type { BillingRpc } from '../bill2/service';

const actor = '00000000-0000-4000-8000-000000000001';
const request = '00000000-0000-4000-8000-000000000002';
const run = '00000000-0000-4000-8000-000000000003';
const execution = '00000000-0000-4000-8000-000000000004';
const other = '00000000-0000-4000-8000-000000000005';
const empty = { processed: 0, remaining: 0 };
type Override = (args: Record<string, unknown>) => unknown | Promise<unknown>;
function setup(overrides: Record<string, Override> = {}) {
  let active = 0;
  let maxActive = 0;
  const events: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    active++; maxActive = Math.max(maxActive, active); events.push(name);
    try {
      await Promise.resolve();
      let data: unknown;
      if (overrides[name]) data = await overrides[name](args);
      else if (name === 'account_erasure_work_batch') data = {
        requestId: request, stage: 'closed', runs: [run], nextRunId: null, financialPending: 0, manualReview: 0,
      };
      else if (['bill2_cancel', 'bill2_finalize', 'bill2_read'].includes(name)) data = { id: run, state: 'settled', executionId: execution };
      else if (name === 'runtime_financial_recovery') data = { runId: run, executionId: execution, state: 'completed' };
      else if (name === 'account_erasure_scrub_content') data = { artifact_generations: 1, artifact_generations_skipped: 0 };
      else if (name === 'account_erasure_scrub_runtime') data = { runtime_sessions: 1, runtime_sessions_skipped: 0 };
      else if (name === 'account_erasure_storage_ready') data = { ready: true };
      else if (name === 'account_erasure_scrub_ledger' || name === 'account_erasure_scrub_payment') {
        data = { ...empty, manualReview: 0, nextRowId: null };
      } else if (name === 'account_erasure_local_cleanup') data = { remaining: 0, manualReview: 0, errors: [] };
      else if (name === 'account_erasure_auth_begin') data = {
        ready: true, alreadyDeleted: false, started: true, claimed: true, requestId: request,
      };
      else if (name === 'account_erasure_auth_result') data = { stage: 'completed' };
      else data = empty;
      return { data, error: null };
    } finally { active--; }
  });
  let absent = false;
  const storageAdapter = { cleanSubject: vi.fn(async () => ({ complete: true, remaining: 0, manualReview: 0 })) };
  const authAdapter = {
    getState: vi.fn(async (): Promise<'present' | 'absent' | 'unknown'> => absent ? 'absent' : 'present'),
    remove: vi.fn(async () => { events.push('AUTH_REMOVE'); absent = true; }),
  };
  const input = { profileId: actor, database: { rpc } as BillingRpc, storageAdapter, authAdapter };
  return { input, rpc, authAdapter, storageAdapter, events, maxActive: () => maxActive };
}

describe('unwired account erasure processor', () => {
  it('uses original identities, independent RPCs, financial recovery and persisted intent before deletion', async () => {
    const f = setup();
    expect(await processAccountErasure(f.input)).toEqual({ stage: 'completed', retry: false, remaining: 0, manualReview: 0, errorCodes: [] });
    expect(f.maxActive()).toBe(1);
    expect(f.events.indexOf('account_erasure_auth_begin')).toBeLessThan(f.events.indexOf('AUTH_REMOVE'));
    expect(f.events.indexOf('runtime_financial_recovery')).toBeLessThan(f.events.indexOf('account_erasure_scrub_runtime'));
    expect(f.rpc).toHaveBeenCalledWith('account_erasure_auth_result', { p_profile_id: actor, p_request_id: request, p_absent: true });
    expect(f.authAdapter.remove).toHaveBeenCalledExactlyOnceWith(actor);
    expect(f.events.some(n => /prepare|dispatch|claim/.test(n))).toBe(false);
  });
  it.each([
    { retry: true, reason: 'transactions_pending' },
    { artifact_generations: 0, artifact_generations_skipped: 1 },
  ])('does not delete while B1 is incomplete: %j', async value => {
    const f = setup({ account_erasure_scrub_content: () => value });
    const result = await processAccountErasure(f.input);
    expect(result.retry).toBe(true); expect(result.remaining).toBeGreaterThan(0);
    expect(f.storageAdapter.cleanSubject).toHaveBeenCalledOnce(); expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('keeps unknown financial results pending without a provider request', async () => {
    const f = setup({
      account_erasure_work_batch: () => ({ requestId: request, stage: 'billing_pending', runs: [run],
        nextRunId: null, financialPending: 1, manualReview: 0 }),
      bill2_finalize: () => ({ id: run, state: 'cost_pending' }),
    });
    const result = await processAccountErasure(f.input);
    expect(result.stage).toBe('billing_pending'); expect(f.events).not.toContain('account_erasure_detach_runtime');
    expect(f.authAdapter.remove).not.toHaveBeenCalled(); expect(f.storageAdapter.cleanSubject).toHaveBeenCalledOnce();
  });
  it('does not treat a locked row or cursor tail as completion', async () => {
    const f = setup({ account_erasure_scrub_ledger: args => args.p_table !== 'token_stats'
      ? { ...empty, manualReview: 0, nextRowId: null }
      : { processed: args.p_after_id ? 0 : 1, remaining: 1, manualReview: 0, nextRowId: args.p_after_id ? null : other } });
    expect((await processAccountErasure(f.input)).remaining).toBe(1);
    expect(f.rpc).toHaveBeenCalledWith('account_erasure_scrub_ledger',
      { p_profile_id: actor, p_table: 'token_stats', p_limit: 100, p_after_id: other });
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it.each([{}, { runtime_sessions: -1 }, { surprise: 0 }, { retry: true, reason: 'raw private text' }])(
    'rejects malformed B1 shape %j', async shape => {
      const f = setup({ account_erasure_scrub_runtime: () => shape });
      expect((await processAccountErasure(f.input)).errorCodes).toContain('ERASURE_INVALID_RESULT');
      expect(f.authAdapter.remove).not.toHaveBeenCalled();
    });
  it('does not delete on a private-subobject manual review despite all rows being processed', async () => {
    const f = setup({ account_erasure_scrub_payment: () => ({ processed: 1, remaining: 1, manualReview: 1, nextRowId: null }) });
    const result = await processAccountErasure(f.input); expect(result.manualReview).toBeGreaterThan(0);
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('passes false verification to local cleanup for incomplete Storage', async () => {
    const f = setup(); f.storageAdapter.cleanSubject.mockResolvedValue({ complete: false, remaining: 2, manualReview: 1 });
    const result = await processAccountErasure(f.input); expect(result.errorCodes).toContain('ERASURE_STORAGE_PENDING');
    expect(f.rpc).toHaveBeenCalledWith('account_erasure_local_cleanup', { p_profile_id: actor, p_storage_verified: false });
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('unresolved upload or transaction barrier prevents Storage, while independent local cleanup continues', async () => {
    const f = setup({ account_erasure_storage_ready: () => ({ ready: false }) });
    const result = await processAccountErasure(f.input);
    expect(result.errorCodes).toContain('ERASURE_STORAGE_PENDING'); expect(result.retry).toBe(true);
    expect(f.storageAdapter.cleanSubject).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith('account_erasure_local_cleanup', { p_profile_id: actor, p_storage_verified: false });
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('Storage admission transport uncertainty stops Storage and all following database mutations', async () => {
    const f = setup({ account_erasure_storage_ready: () => { throw new Error('connection lost'); } });
    const result = await processAccountErasure(f.input);
    expect(result.errorCodes).toContain('ERASURE_RPC_UNCERTAIN');
    expect(f.storageAdapter.cleanSubject).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe('account_erasure_storage_ready');
    expect(f.events).not.toContain('account_erasure_local_cleanup'); expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it.each([{}, { ready: 'true' }, { ready: true, remainingUploads: 1 }])('invalid Storage admission cannot authorize deletion', async admission => {
    const f = setup({ account_erasure_storage_ready: () => admission });
    expect((await processAccountErasure(f.input)).errorCodes).toContain('ERASURE_INVALID_RESULT');
    expect(f.storageAdapter.cleanSubject).not.toHaveBeenCalled(); expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('reads the original identity after a removal error and commits only verified absence', async () => {
    const f = setup(); f.authAdapter.getState.mockResolvedValueOnce('present').mockResolvedValueOnce('absent');
    f.authAdapter.remove.mockRejectedValue(new Error('private timeout details'));
    expect((await processAccountErasure(f.input)).stage).toBe('completed');
    expect(f.authAdapter.getState.mock.calls).toEqual([[actor], [actor]]);
  });
  it('resumes an interrupted intent without repeating remove', async () => {
    const f = setup({ account_erasure_auth_begin: () => ({ ready: true, alreadyDeleted: false,
      started: true, claimed: false, requestId: request }) });
    for (const state of ['unknown', 'present', 'absent'] as const) {
      f.authAdapter.getState.mockResolvedValue(state);
      const result = await processAccountErasure(f.input);
      expect(result.stage === 'completed').toBe(state === 'absent');
    }
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('timeout does not issue a second removal and verifies absence', async () => {
    const f = setup(); f.authAdapter.remove.mockImplementation(() => new Promise(() => {}));
    f.authAdapter.getState.mockResolvedValueOnce('present').mockResolvedValueOnce('unknown');
    const result = await processAccountErasure({ ...f.input, budget: { operationTimeoutMs: 2 } });
    expect(result.errorCodes).toContain('ERASURE_AUTH_PENDING'); expect(f.authAdapter.remove).toHaveBeenCalledOnce();
  });
  it('stops before Auth when its final SQL prerequisite is no longer ready', async () => {
    const f = setup({ account_erasure_auth_begin: () => ({ ready: false, alreadyDeleted: false,
      started: false, claimed: false, requestId: request }) });
    expect((await processAccountErasure(f.input)).errorCodes).toContain('ERASURE_AUTH_NOT_READY');
    expect(f.authAdapter.getState).not.toHaveBeenCalled(); expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('rejects request and financial identity changes without exposing raw exceptions', async () => {
    const f = setup({ bill2_finalize: () => ({ id: other, state: 'settled' }) });
    expect((await processAccountErasure(f.input)).errorCodes).toContain('ERASURE_IDENTITY_CHANGED');
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
    const g = setup({ account_erasure_local_cleanup: () => { throw new Error('private@example.test private payload'); } });
    expect(JSON.stringify(await processAccountErasure(g.input))).not.toMatch(/private/);
  });
  it.each([{ maxPages: 0 }, { maxPages: 5 }, { operationTimeoutMs: 0 }, { deadline: Infinity }])(
    'rejects invalid bounds before all I/O: %j', async budget => {
      const f = setup(); expect((await processAccountErasure({ ...f.input, budget })).errorCodes).toContain('ERASURE_INVALID_INPUT');
      expect(f.rpc).not.toHaveBeenCalled();
    });
  it('rejects invalid UUID and expired deadline before database or adapters', async () => {
    const f = setup(); await processAccountErasure({ ...f.input, profileId: 'untrusted' }); expect(f.rpc).not.toHaveBeenCalled();
    expect((await processAccountErasure({ ...f.input, budget: { now: () => 10, deadline: 9 } })).errorCodes)
      .toContain('ERASURE_BUDGET_EXHAUSTED');
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('bounds inventory pagination and refuses duplicate cursors', async () => {
    const f = setup({ account_erasure_work_batch: () => ({ requestId: request, stage: 'closed', runs: [run],
      nextRunId: run, financialPending: 0, manualReview: 0 }) });
    expect((await processAccountErasure({ ...f.input, budget: { maxPages: 1 } })).errorCodes).toContain('ERASURE_PAGE_LIMIT');
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('never starts another RPC after a transaction timeout with uncertain completion', async () => {
    const f = setup({ bill2_cancel: () => new Promise(() => {}) });
    const result = await processAccountErasure({ ...f.input, budget: { operationTimeoutMs: 2 } });
    expect(result.errorCodes).toContain('ERASURE_OPERATION_TIMEOUT');
    expect(f.events).toEqual(['account_erasure_work_batch', 'bill2_cancel']);
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('a rejected transport may have committed and stops all subsequent RPCs and Auth', async () => {
    const f = setup({ bill2_finalize: () => { throw new Error('socket dropped after commit: PRIVATE'); } });
    const result = await processAccountErasure(f.input);
    expect(result.errorCodes).toContain('ERASURE_RPC_UNCERTAIN');
    expect(f.events).toEqual(['account_erasure_work_batch', 'bill2_cancel', 'bill2_finalize']);
    expect(f.authAdapter.remove).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('an explicit RPC error cannot be hidden by an otherwise clean inventory', async () => {
    const f = setup(); f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'SECRET_BODY', code: 'XX000' } } as never);
    const result = await processAccountErasure(f.input);
    expect(result.errorCodes).toEqual(['ERASURE_RPC_WORK_BATCH_XX000', 'ERASURE_RPC_FAILED']); expect(JSON.stringify(result)).not.toContain('SECRET_BODY');
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('records the exact safeupdate failure and stops all subsequent database and external I/O', async () => {
    const f = setup();
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (name, args) => name === 'account_erasure_scrub_content'
      ? { data: null, error: { code: '21000', message: 'DELETE requires a WHERE clause PRIVATE', details: 'SECRET' } } as never
      : original(name, args));
    const result = await processAccountErasure(f.input);
    expect(result.errorCodes).toContain('ERASURE_RPC_SCRUB_CONTENT_21000');
    expect(result.errorCodes).toContain('ERASURE_RPC_FAILED');
    const names = f.rpc.mock.calls.map(([name]) => name);
    expect(names.at(-1)).toBe('account_erasure_scrub_content');
    expect(f.storageAdapter.cleanSubject).not.toHaveBeenCalled();
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET|DELETE/);
  });
  it('rejects request drift and contradictory Auth claims before adapter calls', async () => {
    for (const begin of [
      { ready: true, alreadyDeleted: false, started: true, claimed: true, requestId: other },
      { ready: true, alreadyDeleted: true, started: true, claimed: true, requestId: request },
    ]) {
      const f = setup({ account_erasure_auth_begin: () => begin });
      expect((await processAccountErasure(f.input)).errorCodes).toContain('ERASURE_IDENTITY_CHANGED');
      expect(f.authAdapter.getState).not.toHaveBeenCalled();
    }
  });
  it('accepts explicit no-binding detach and still requires final SQL completion', async () => {
    const f = setup({ account_erasure_detach_runtime: () => ({ detached: true }),
      account_erasure_auth_result: () => ({ stage: 'billing_pending' }) });
    const result = await processAccountErasure(f.input);
    expect(result.stage).toBe('billing_pending'); expect(result.retry).toBe(true); expect(result.remaining).toBe(1);
  });
  it('busy runtime binding denies Auth without blocking unrelated Storage cleanup', async () => {
    const f = setup({ account_erasure_detach_runtime: () => ({ processed: 0, remaining: 1, reason: 'binding_busy' }) });
    expect((await processAccountErasure(f.input)).errorCodes).toContain('ERASURE_CONTENT_PENDING');
    expect(f.storageAdapter.cleanSubject).toHaveBeenCalledOnce(); expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
  it('unfinished financial evidence cannot be overridden by an empty final inventory', async () => {
    const f = setup({ bill2_finalize: () => ({ id: run, state: 'unknown' }) });
    const result = await processAccountErasure(f.input);
    expect(result.stage).toBe('billing_pending'); expect(result.remaining).toBeGreaterThan(0);
    expect(f.authAdapter.remove).not.toHaveBeenCalled();
  });
});
