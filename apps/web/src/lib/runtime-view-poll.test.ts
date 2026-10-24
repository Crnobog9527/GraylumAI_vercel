/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_VIEW_IDLE_POLL_MS,
  markRuntimeViewBusy,
  markRuntimeViewStreaming,
  progressingExecution,
  runtimeViewPollInterval,
  runtimeViewPollOptions,
} from './runtime-view-poll';

const running = { activeExecution: 'e1', executions: [{ executionId: 'e1', state: 'running' }] };
const query = (data: unknown) => ({ state: { data } });

describe('runtime.view polling', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('polls rarely when no turn is in progress', () => {
    expect(runtimeViewPollInterval(undefined, false, 0)).toBe(RUNTIME_VIEW_IDLE_POLL_MS);
    expect(runtimeViewPollInterval({ activeExecution: null, executions: [] }, false, 0)).toBe(60_000);
    // A paused turn (credits, resume, cost pending) only changes on the user's own action.
    for (const state of ['waiting_credits', 'waiting_resume', 'cost_pending', 'interrupted', 'completed']) {
      expect(runtimeViewPollInterval({ activeExecution: 'e1', executions: [{ executionId: 'e1', state }] }, false, 0)).toBe(60_000);
    }
  });

  it('polls quickly while the server advances a turn and backs off', () => {
    expect(progressingExecution(running)).toBe('e1');
    expect(progressingExecution({ activeExecution: 'e1', executions: [] })).toBe('e1');
    expect(runtimeViewPollInterval(running, false, 0)).toBe(5000);
    expect(runtimeViewPollInterval(running, false, 29_999)).toBe(5000);
    expect(runtimeViewPollInterval(running, false, 30_000)).toBe(8000);
    expect(runtimeViewPollInterval(running, false, 120_000)).toBe(12_000);
    expect(runtimeViewPollInterval(running, false, 3_600_000)).toBe(12_000);
  });

  it('polls quickly while the page is sending, before the execution is visible', () => {
    expect(runtimeViewPollInterval(undefined, true, 0)).toBe(5000);
  });

  it('restarts the backoff for a new execution and stops polling quickly once idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const busy = { current: false };
    const options = runtimeViewPollOptions({ current: null }, busy);
    const interval = options.refetchInterval;
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchOnWindowFocus).toBe('always');
    expect(interval(query(running))).toBe(5000);
    vi.setSystemTime(130_000);
    expect(interval(query(running))).toBe(12_000);
    const next = { activeExecution: 'e2', executions: [{ executionId: 'e2', state: 'prepared' }] };
    expect(interval(query(next))).toBe(5000);
    expect(interval(query({ activeExecution: null, executions: [] }))).toBe(60_000);
    busy.current = true;
    expect(interval(query({ activeExecution: null, executions: [] }))).toBe(5000);
  });

  it('re-reads at once when an idle page starts sending, not on every busy render', () => {
    const busy = { current: false };
    const refetch = vi.fn();
    markRuntimeViewBusy(busy, true, refetch);
    expect(busy.current).toBe(true);
    expect(refetch).toHaveBeenCalledTimes(1);
    markRuntimeViewBusy(busy, true, refetch);
    markRuntimeViewBusy(busy, false, refetch);
    expect(busy.current).toBe(false);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does not poll while this page streams, and re-reads once when the stream closes', () => {
    const streaming = { current: false };
    const interval = runtimeViewPollOptions({ current: null }, { current: true }, streaming).refetchInterval;
    expect(interval(query(running))).toBe(5000);
    streaming.current = true;
    expect(interval(query(running))).toBe(false);
    expect(interval(query(undefined))).toBe(false);
    const refetch = vi.fn();
    markRuntimeViewStreaming(streaming, true, refetch);
    expect(refetch).not.toHaveBeenCalled();
    markRuntimeViewStreaming(streaming, false, refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
    markRuntimeViewStreaming(streaming, false, refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
    // A turn the server still advances (stream broke) falls back to the quick poll.
    expect(interval(query(running))).toBe(5000);
  });
});
