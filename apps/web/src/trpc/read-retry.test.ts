/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { isTransientReadError, READ_RETRIES, readRetry, readRetryDelay } from './read-retry';

const failed = (httpStatus: number, code = 'INTERNAL_SERVER_ERROR') => ({ data: { httpStatus, code } });

describe('read retry policy', () => {
  it('asks again after a server failure or a failure with no response at all', () => {
    expect(isTransientReadError(failed(503, 'SERVICE_UNAVAILABLE'))).toBe(true);
    expect(isTransientReadError(failed(500))).toBe(true);
    expect(isTransientReadError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isTransientReadError({ data: null })).toBe(true);
  });

  it('never asks again after a refusal that asking again cannot change', () => {
    for (const status of [400, 403, 404, 412, 422]) expect(isTransientReadError(failed(status, 'FORBIDDEN')), String(status)).toBe(false);
    expect(isTransientReadError(failed(429, 'TOO_MANY_REQUESTS'))).toBe(false);
    expect(isTransientReadError(failed(401, 'UNAUTHORIZED'))).toBe(false);
  });

  it('asks again at most twice', () => {
    expect(READ_RETRIES).toBe(2);
    expect([0, 1, 2, 3].map(count => readRetry(count, failed(503)))).toEqual([true, true, false, false]);
    expect(readRetry(0, failed(404, 'NOT_FOUND'))).toBe(false);
  });

  it('waits a second, then two, and never more than four', () => {
    expect([0, 1, 2, 3, 9].map(readRetryDelay)).toEqual([1000, 2000, 4000, 4000, 4000]);
  });
});
