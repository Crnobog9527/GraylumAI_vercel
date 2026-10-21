/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../lib/logger';
import { getPlatformSecret, PLATFORM_SECRET_READ_TIMEOUT_MS, resetPlatformSecretCacheForTests } from './reader';

vi.mock('../../lib/logger', () => ({ logger: { error: vi.fn() } }));
const CANARY = 'or-fake-private-canary-DO-NOT-LOG';
function client(read: (signal: AbortSignal, attempt: number) => unknown) {
  const rpc = vi.fn(() => ({
    abortSignal: (signal: AbortSignal) => read(signal, rpc.mock.calls.length),
  }));
  return { db: { rpc } as never, rpc };
}
function timeoutReply(signal: AbortSignal) {
  return new Promise(resolve => signal.addEventListener('abort', () => resolve({
    data: null, error: { code: '', message: `TimeoutError: ${CANARY}` },
  }), { once: true }));
}

beforeEach(() => {
  resetPlatformSecretCacheForTests();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fakeTimeoutClock() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), ms);
    return controller.signal;
  });
}

describe('bounded platform secret read recovery', () => {
  it('waits three seconds per attempt', () => {
    expect(PLATFORM_SECRET_READ_TIMEOUT_MS).toBe(3000);
  });

  it('retries an actually expired read once and returns the successful fresh value', async () => {
    fakeTimeoutClock();
    const f = client((signal, attempt) => attempt === 1 ? timeoutReply(signal) : { data: CANARY, error: null });
    const result = getPlatformSecret(f.db, 'openrouter', { fresh: true }).catch(error => error);
    await vi.advanceTimersByTimeAsync(2999);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ value: CANARY, source: 'admin' });
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('security', 'platform_secret_read_failed', expect.objectContaining({
      slot: 'openrouter', errorType: 'timeout', attempt: 1, elapsedMs: expect.any(Number), retrying: true,
    }));
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(CANARY);
  });

  it('fails closed after the second timeout without a third RPC or a cached fallback', async () => {
    fakeTimeoutClock();
    const seed = client(() => ({ data: CANARY, error: null }));
    await getPlatformSecret(seed.db, 'openrouter');
    const f = client(signal => timeoutReply(signal));
    const failed = getPlatformSecret(f.db, 'openrouter', { fresh: true }).catch(error => error);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await failed).toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenLastCalledWith('security', 'platform_secret_read_failed', expect.objectContaining({
      errorType: 'timeout', attempt: 2, elapsedMs: expect.any(Number), retrying: false,
    }));
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(CANARY);
  });

  it.each([
    new TypeError('fetch failed', { cause: Object.assign(new Error(CANARY), { code: 'ECONNRESET' }) }),
    { data: null, error: { code: '', message: 'TypeError: fetch failed', details: CANARY } },
    { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
  ])('retries only the recognized transient transport/timeout failure %#', async failure => {
    const f = client((_signal, attempt) => {
      if (attempt > 1) return { data: CANARY, error: null };
      if (failure instanceof Error) throw failure;
      return failure;
    });
    expect(await getPlatformSecret(f.db, 'openrouter', { fresh: true })).toEqual({ value: CANARY, source: 'admin' });
    expect(f.rpc).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(CANARY);
  });

  it.each([
    { data: null, error: { code: '42501', message: CANARY } },
    { data: null, error: { code: '57014', message: 'canceling statement due to user request' } },
    { data: null, error: { code: '', message: CANARY } },
    { data: 42, error: null },
    new DOMException(CANARY, 'AbortError'),
    new Error(CANARY),
  ])('does not retry permission, caller cancellation, bad shape or unknown failures %#', async failure => {
    const f = client(() => {
      if (failure instanceof Error) throw failure;
      return failure;
    });
    await expect(getPlatformSecret(f.db, 'openrouter', { fresh: true }))
      .rejects.toMatchObject({ code: 'PLATFORM_SECRET_UNAVAILABLE' });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('security', 'platform_secret_read_failed', expect.objectContaining({
      errorType: expect.any(String), elapsedMs: expect.any(Number), retrying: false,
    }));
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(CANARY);
  });

  it('does not retry an empty slot or turn it into an unavailable error', async () => {
    const f = client(() => ({ data: null, error: null }));
    await expect(getPlatformSecret(f.db, 'openrouter', { fresh: true }))
      .rejects.toMatchObject({ code: 'PLATFORM_SECRET_NOT_CONFIGURED' });
    expect(f.rpc).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
