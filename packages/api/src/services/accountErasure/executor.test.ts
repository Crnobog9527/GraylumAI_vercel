/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn(), idle: vi.fn(), drain: vi.fn() }));
vi.mock('./host', () => ({ createAccountErasureHost: mocks.create }));
vi.mock('./authAdapter', () => ({ createErasureAuthAdapter: vi.fn() }));
vi.mock('./storageTransport', () => ({ createErasureStorageTransport: vi.fn() }));
import { runAccountErasureExecutor } from './executor';
const actor = '00000000-0000-4000-8000-000000000001';
const request = '00000000-0000-4000-8000-000000000002';
function client() {
  let selected = false;
  const rpc = vi.fn((name: string) => {
    let data: unknown = { recorded: true };
    if (name === 'account_erasure_executor_claim') {
      data = selected ? { claimed: false } : { claimed: true, profileId: actor, requestId: request };
      selected = true;
    }
    if (name === 'account_erasure_executor_pending') data = 1;
    const promise = Promise.resolve({ data, error: null });
    return Object.assign(promise, { abortSignal: () => promise });
  });
  const observed = vi.fn().mockResolvedValue({ data: [], count: 0, error: null });
  const query = { select: vi.fn(), eq: vi.fn(), limit: vi.fn(), abortSignal: observed };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.limit.mockReturnValue(query);
  return { rpc, from: vi.fn().mockReturnValue(query), observed, query };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockReturnValue({ run: mocks.run, isIdle: mocks.idle, waitForIdle: mocks.drain });
  mocks.idle.mockReturnValue(true);
  mocks.drain.mockResolvedValue(false);
  mocks.run.mockResolvedValue({ stage: 'erasing', retry: true, remaining: 1, manualReview: 0,
    errorCodes: ['ERASURE_CONTENT_PENDING'] });
});
it('persists a barrier retry and uses the original request and claimed token', async () => {
  const database = client();
  const summary = await runAccountErasureExecutor(database as never);
  expect(summary).toEqual({ processed: 1, completed: 0, pending: 1, failed: 0 });
  const calls = database.rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
  const claim = calls.find(([name]) => name === 'account_erasure_executor_claim')![1];
  expect(calls.find(([name]) => name === 'account_erasure_executor_finish')![1]).toEqual({
    p_profile_id: actor, p_request_id: request, p_token: claim.p_token,
    p_codes: ['ERASURE_CONTENT_PENDING'], p_release: true,
  });
});
it('does not release a claim when underlying I/O is still in flight', async () => {
  const database = client(); mocks.idle.mockReturnValue(false);
  await runAccountErasureExecutor(database as never);
  expect(database.rpc).toHaveBeenCalledWith('account_erasure_executor_finish', expect.objectContaining({
    p_release: false, p_codes: ['ERASURE_CONTENT_PENDING', 'ERASURE_EXECUTOR_IO_PENDING'],
  }));
});
it('does not retry an ambiguous claim or expose its diagnostic', async () => {
  const database = client();
  database.rpc.mockImplementationOnce(() => {
    const promise = Promise.resolve({ data: null, error: { message: 'private database detail' } });
    return Object.assign(promise, { abortSignal: () => promise }) as never;
  });
  expect(await runAccountErasureExecutor(database as never)).toEqual({ processed: 0, completed: 0, pending: 1, failed: 1 });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(database.rpc.mock.calls.filter(([name]) => name === 'account_erasure_executor_claim')).toHaveLength(1);
});
it('does not report success when recording the original claim fails', async () => {
  const database = client(); const original = database.rpc.getMockImplementation()!;
  database.rpc.mockImplementation(name => {
    if (name !== 'account_erasure_executor_finish') return original(name);
    const promise = Promise.resolve({ data: { recorded: false }, error: null });
    return Object.assign(promise, { abortSignal: () => promise });
  });
  expect((await runAccountErasureExecutor(database as never)).failed).toBe(1);
  expect(mocks.run).toHaveBeenCalledOnce();
});
it('requires both historical proof and upload quiescence from service SQL', async () => {
  const database = client(); await runAccountErasureExecutor(database as never);
  const proof = mocks.create.mock.calls[0][0].verifyRetainedHistory;
  for (const data of [{ historyComplete: false, quiescent: true }, { historyComplete: true, quiescent: false }]) {
    database.rpc.mockImplementationOnce(() => {
      const promise = Promise.resolve({ data, error: null });
      return Object.assign(promise, { abortSignal: () => promise });
    });
    await expect(proof(actor, new AbortController().signal)).rejects.toThrow('ERASURE_STORAGE_UNPROVEN');
  }
});

it('releases the original claim after slow I/O actually drains within the cron budget', async () => {
  const database = client(); mocks.idle.mockReturnValue(false); mocks.drain.mockResolvedValue(true);
  await runAccountErasureExecutor(database as never);
  expect(mocks.drain).toHaveBeenCalledOnce();
  expect(database.rpc).toHaveBeenCalledWith('account_erasure_executor_finish', expect.objectContaining({ p_release: true }));
});

it('reconciles a committed claim after losing its response with the original token', async () => {
  const database = client(); const original = database.rpc.getMockImplementation()!;
  database.rpc.mockImplementationOnce(name => {
    original(name);
    const promise = Promise.resolve({ data: null, error: { message: 'synthetic lost response' } });
    return Object.assign(promise, { abortSignal: () => promise }) as never;
  });
  database.observed.mockResolvedValue({ data: [{ profile_id: actor, request_id: request }], count: 1, error: null });
  const result = await runAccountErasureExecutor(database as never);
  expect(result.failed).toBe(0); expect(mocks.run).toHaveBeenCalledOnce();
  const calls = database.rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
  const token = calls.find(([name]) => name === 'account_erasure_executor_claim')![1].p_token;
  expect(database.query.eq).toHaveBeenCalledWith('executor_token', token);
  expect(calls.find(([name]) => name === 'account_erasure_executor_finish')![1].p_token).toBe(token);
});
