/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREDITS_SUMMARY_MAX_RETRIES, CREDITS_SUMMARY_QUERY_OPTIONS as options, creditsSummaryRetry, creditsSummaryRetryDelay,
} from './creditsSummaryQuery';

describe('credit summary retry policy', () => {
  it('backs off exponentially and caps the wait', () => {
    expect([0, 1, 2, 3, 4, 10].map(creditsSummaryRetryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('stops after a bounded number of retries and never retries a missing login', () => {
    expect(creditsSummaryRetry(0, new Error('boom'))).toBe(true);
    expect(creditsSummaryRetry(CREDITS_SUMMARY_MAX_RETRIES - 1, new Error('boom'))).toBe(true);
    expect(creditsSummaryRetry(CREDITS_SUMMARY_MAX_RETRIES, new Error('boom'))).toBe(false);
    expect(creditsSummaryRetry(0, { data: { code: 'UNAUTHORIZED' } })).toBe(false);
  });
});

describe('credit summary that keeps failing (TanStack Query)', () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it('makes 1 + 2 attempts with 1 s and 2 s waits, then ends in an error', async () => {
    const queryFn = vi.fn(async () => { throw new Error('summary down'); });
    const first = new QueryObserver(client, { queryKey: ['summary'], queryFn, ...options });
    const stop = first.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(queryFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(queryFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(queryFn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).toHaveBeenCalledTimes(1 + CREDITS_SUMMARY_MAX_RETRIES);
    expect(first.getCurrentResult()).toMatchObject({ isError: true, isFetching: false });

    // Another card mounting after the failure shows the error instead of starting a new round.
    const second = new QueryObserver(client, { queryKey: ['summary'], queryFn, ...options });
    const stopSecond = second.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(second.getCurrentResult().isError).toBe(true);

    // The "重试" button reads again on request.
    void first.refetch();
    await vi.advanceTimersByTimeAsync(0);
    expect(queryFn).toHaveBeenCalledTimes(4);
    stop();
    stopSecond();
  });
});
