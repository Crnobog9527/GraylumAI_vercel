/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { createAccountErasureHost } from './host';

const actor = '00000000-0000-4000-8000-000000000001';
const request = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const path = actor + '/a.png';
function fixture() {
  let present = true, authPresent = true, claimed = false;
  const row = { profile_id: actor, request_id: request, stage: 'closed', last_error_code: null as string | null };
  const result = { data: [row], count: 1, error: null as unknown };
  const from = vi.fn((table: string) => {
    const value = table === 'account_erasure_requests' ? result : { data: [], count: 0, error: null };
    const query = { select: () => query, eq: () => query, limit: () => query, order: () => query,
      abortSignal: () => Promise.resolve(value) };
    return query;
  });
  const events: string[] = [];
  const rpc = vi.fn(async (name: string) => {
    events.push(name);
    let data: unknown = { processed: 0, remaining: 0, manualReview: 0, nextRowId: null };
    if (name === 'account_erasure_work_batch') data = {
      requestId: request, stage: 'closed', runs: [], nextRunId: null, financialPending: 0, manualReview: 0,
    };
    if (name === 'account_erasure_scrub_content') data = { artifact_generations: 0 };
    if (name === 'account_erasure_scrub_runtime') data = { runtime_sessions: 0 };
    if (name === 'account_erasure_storage_ready') data = { ready: true };
    if (name === 'account_erasure_local_cleanup') data = { remaining: 0, manualReview: 0, errors: [] };
    if (name === 'account_erasure_auth_begin') {
      data = { requestId: request, claimed: !claimed, started: true, ready: true, alreadyDeleted: false };
      claimed = true;
    }
    if (name === 'account_erasure_auth_result') data = { stage: 'completed' };
    return { data, error: null };
  });
  const storage = {
    listPrefix: vi.fn(async () => ({ paths: present ? [path] : [], nextAfterPath: null })),
    getState: vi.fn(async () => { events.push('storage-read'); return present ? 'present' : 'absent'; }),
    remove: vi.fn(async () => { events.push('storage-remove'); present = false; }),
  };
  const auth = {
    getState: vi.fn(async (): Promise<'present' | 'absent' | 'unknown'> => authPresent ? 'present' : 'absent'),
    remove: vi.fn(async () => { authPresent = false; }),
  };
  const input = { profileId: actor, requestId: request, client: { from, rpc } as never, storage, auth,
    verifyRetainedHistory: vi.fn(async () => {}), verifyQuiescence: vi.fn(async () => {}) };
  return { input, row, result, rpc, from, events, storage, auth,
    loseStorageReply: () => { present = false; throw new Error('synthetic unknown'); },
    setAuthAbsent: () => { authPresent = false; } };
}
it('composes the existing processor with exact service request and independent proofs', async () => {
  const f = fixture();
  expect(await createAccountErasureHost(f.input).run()).toMatchObject({ stage: 'completed', retry: false });
  expect(f.storage.remove).toHaveBeenCalledOnce(); expect(f.auth.remove).toHaveBeenCalledOnce();
  expect(f.events.indexOf('storage-read')).toBeLessThan(f.events.indexOf('storage-remove'));
  expect(f.rpc).toHaveBeenCalledWith('account_erasure_auth_result', {
    p_profile_id: actor, p_request_id: request, p_absent: true,
  });
  expect(f.rpc.mock.calls.some(([name]) => name === 'account_erasure_note_error')).toBe(false);
});
it.each(['profile', 'request', 'completed', 'denied', 'count', 'shape'] as const)('rejects admission: %s', async kind => {
  const f = fixture();
  if (kind === 'profile') f.row.profile_id = other;
  if (kind === 'request') f.row.request_id = other;
  if (kind === 'completed') f.row.stage = 'completed';
  if (kind === 'denied') f.result.error = { code: '42501' };
  if (kind === 'count') f.result.count = 0;
  if (kind === 'shape') f.result.data = [];
  expect((await createAccountErasureHost(f.input).run()).remaining).toBe(1);
  expect(f.rpc).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  expect(f.auth.remove).not.toHaveBeenCalled();
});
it.each(['verifyRetainedHistory', 'verifyQuiescence'] as const)('does not infer missing proof %s from empty rows', async proof => {
  const f = fixture();
  const host = createAccountErasureHost({ ...f.input, [proof]: undefined });
  expect((await host.run()).stage).not.toBe('completed'); expect(f.rpc).not.toHaveBeenCalled();
  expect(f.storage.listPrefix).not.toHaveBeenCalled();
});
it('binds the processor first inventory to the caller original request, before any write', async () => {
  const f = fixture();
  f.rpc.mockResolvedValueOnce({ data: { requestId: other }, error: null });
  expect((await createAccountErasureHost(f.input).run()).stage).not.toBe('completed');
  expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.auth.remove).not.toHaveBeenCalled();
});
it('preserves Auth-ban error priority without overwriting durable diagnostics', async () => {
  const f = fixture(); f.row.last_error_code = 'AUTH_BAN_FAILED';
  const result = await createAccountErasureHost({ ...f.input, verifyRetainedHistory: undefined }).run();
  expect(result.errorCodes[0]).toBe('AUTH_BAN_FAILED'); expect(f.rpc).not.toHaveBeenCalled();
});
it('holds the local latch after proof timeout until the ignored-abort operation settles', async () => {
  const f = fixture(); let release!: () => void;
  const proof = new Promise<void>(resolve => { release = resolve; });
  const host = createAccountErasureHost({ ...f.input, operationTimeoutMs: 5, verifyRetainedHistory: () => proof });
  expect((await host.run()).errorCodes).toContain('ERASURE_HOST_TIMEOUT');
  expect((await host.run()).errorCodes).toContain('ERASURE_HOST_BUSY');
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.rpc).not.toHaveBeenCalled();
  expect((await host.run()).stage).toBe('completed');
});
it('reads original Storage state after lost success without a second removal', async () => {
  const f = fixture(); f.storage.remove.mockImplementationOnce(async () => f.loseStorageReply());
  const host = createAccountErasureHost(f.input);
  expect((await host.run()).stage).not.toBe('completed'); expect(f.auth.remove).not.toHaveBeenCalled();
  expect((await host.run()).stage).toBe('completed'); expect(f.storage.remove).toHaveBeenCalledOnce();
});
it('resumes a durable Auth intent by observation, never another deletion', async () => {
  const f = fixture(); f.auth.remove.mockRejectedValueOnce(new Error('unknown'));
  const host = createAccountErasureHost(f.input);
  expect((await host.run()).errorCodes).toContain('ERASURE_AUTH_PENDING');
  expect((await host.run()).errorCodes).toContain('ERASURE_AUTH_PENDING');
  expect(f.auth.remove).toHaveBeenCalledOnce();
  f.setAuthAbsent(); expect((await host.run()).stage).toBe('completed');
  expect(f.auth.remove).toHaveBeenCalledOnce();
});
it('seals a timed-out Storage pass and rejects re-entry while its I/O is outstanding', async () => {
  const f = fixture(); let release!: () => void;
  f.storage.getState.mockImplementationOnce(() => new Promise<'present' | 'absent'>(resolve => { release = () => resolve('present'); }));
  const host = createAccountErasureHost({ ...f.input, operationTimeoutMs: 10 });
  expect((await host.run()).stage).not.toBe('completed');
  expect((await host.run()).errorCodes).toContain('ERASURE_HOST_BUSY');
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.storage.remove).not.toHaveBeenCalled(); expect(f.auth.remove).not.toHaveBeenCalled();
  expect((await host.run()).stage).toBe('completed');
});

it('tracks a metadata query that ignores abort until the actual query settles', async () => {
  const f = fixture();
  const original = f.from.getMockImplementation()!;
  const value = { data: [], count: 0, error: null };
  let release!: (result: typeof value) => void;
  const pending = new Promise<typeof value>(resolve => { release = resolve; });
  let reads = 0;
  f.from.mockImplementation(table => {
    const query = original(table);
    if (table === 'tickets') query.abortSignal = () => { reads++; return reads === 1 ? pending : Promise.resolve(value); };
    return query;
  });
  const host = createAccountErasureHost({ ...f.input, operationTimeoutMs: 10 });
  expect((await host.run()).stage).not.toBe('completed');
  expect((await host.run()).errorCodes).toContain('ERASURE_HOST_BUSY');
  expect(reads).toBe(1); expect(f.storage.remove).not.toHaveBeenCalled(); expect(f.auth.remove).not.toHaveBeenCalled();
  release(value); await new Promise(resolve => setTimeout(resolve, 0));
  expect((await host.run()).stage).toBe('completed');
});

it('clears unrelated content while deferred storage history is unproven', async () => {
  const f = fixture();
  const host = createAccountErasureHost({ ...f.input, deferStorageProof: true,
    verifyRetainedHistory: async () => { throw new Error('unknown history'); } });
  expect((await host.run()).errorCodes).toContain('ERASURE_STORAGE_PENDING');
  expect(f.rpc).toHaveBeenCalledWith('account_erasure_scrub_content', { p_profile_id: actor });
  expect(f.rpc).toHaveBeenCalledWith('account_erasure_local_cleanup', { p_profile_id: actor, p_storage_verified: false });
  expect(f.auth.remove).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  expect(host.isIdle()).toBe(true);
});
