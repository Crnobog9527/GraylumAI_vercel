/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ captureMessage: vi.fn(), alert: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage }));
vi.mock('@/lib/owner-alert', () => ({ alertOwnerAfterResponse: m.alert }));
import {
  RECOVERY_FAILING_RUNS, RECOVERY_STALE_MS, checkRecoveryHeartbeat, reportRecoveryHeartbeat,
} from './recovery-heartbeat-alert';
import { scrubErrorEvent, scrubText } from './sentry-scrub';

const now = Date.parse('2026-11-18T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const MINUTE = 60_000;
const run = (minutesAgo: number, status: string | null, finished = true) =>
  ({ status, started_at: ago(minutesAgo * MINUTE), finished_at: finished ? ago(minutesAgo * MINUTE - 20_000) : null });
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });

it('stays quiet while the job runs every minute and succeeds', () => {
  expect(reportRecoveryHeartbeat([run(0, 'running', false), run(1, 'success'), run(2, 'success'), run(3, 'success')], now)).toBeNull();
  // One failed run, or two, is retried a minute later and is not news.
  expect(reportRecoveryHeartbeat([run(0, 'running', false), run(1, 'error'), run(2, 'error'), run(3, 'success')], now)).toBeNull();
  // Exactly at the limit is still on time.
  expect(reportRecoveryHeartbeat([{ status: 'success', started_at: ago(RECOVERY_STALE_MS), finished_at: ago(RECOVERY_STALE_MS - 1000) }], now)).toBeNull();
  expect(m.captureMessage).not.toHaveBeenCalled();
  expect(m.alert).not.toHaveBeenCalled();
});

it('reports a job that has not started a run for more than ten minutes, to Sentry and to the Owner', () => {
  expect(RECOVERY_STALE_MS).toBe(10 * MINUTE);
  expect(reportRecoveryHeartbeat([run(25, 'success'), run(26, 'success')], now)).toBe('RUNTIME_RECOVERY_RUN_STALE');
  expect(m.captureMessage).toHaveBeenCalledExactlyOnceWith('RUNTIME_RECOVERY_RUN_STALE', {
    level: 'error', fingerprint: ['RUNTIME_RECOVERY_RUN_STALE'],
    tags: { category: 'runtime_recovery', code: 'RUNTIME_RECOVERY_RUN_STALE' }, extra: { minutesSinceLastRun: 25 },
  });
  expect(m.alert).toHaveBeenCalledExactlyOnceWith('ops_backlog', { code: 'RUNTIME_RECOVERY_RUN_STALE', level: 'error' });
  expect(console.warn).toHaveBeenCalledWith('[recovery-alert] RUNTIME_RECOVERY_RUN_STALE error');
});

it('reports a job with no run record at all, and a run that started long ago and never finished', () => {
  expect(reportRecoveryHeartbeat([], now)).toBe('RUNTIME_RECOVERY_RUN_STALE');
  expect(m.captureMessage).toHaveBeenLastCalledWith('RUNTIME_RECOVERY_RUN_STALE', expect.objectContaining({ extra: {} }));
  expect(reportRecoveryHeartbeat([run(40, 'running', false)], now)).toBe('RUNTIME_RECOVERY_RUN_STALE');
});

it('reports three finished runs in a row that did not succeed, ignoring the run in flight', () => {
  expect(RECOVERY_FAILING_RUNS).toBe(3);
  const failing = [run(0, 'running', false), run(1, 'error'), run(2, 'error'), run(3, 'error')];
  expect(reportRecoveryHeartbeat(failing, now)).toBe('RUNTIME_RECOVERY_RUN_FAILING');
  expect(m.captureMessage).toHaveBeenCalledExactlyOnceWith('RUNTIME_RECOVERY_RUN_FAILING', expect.objectContaining({
    level: 'error', fingerprint: ['RUNTIME_RECOVERY_RUN_FAILING'], extra: { failingRuns: 3 },
  }));
  expect(m.alert).toHaveBeenCalledExactlyOnceWith('ops_backlog', { code: 'RUNTIME_RECOVERY_RUN_FAILING', level: 'error' });
  // A stopped job is reported as stopped, not as failing: one message, not two.
  vi.clearAllMocks();
  expect(reportRecoveryHeartbeat([run(30, 'error'), run(31, 'error'), run(32, 'error')], now)).toBe('RUNTIME_RECOVERY_RUN_STALE');
  expect(m.alert).toHaveBeenCalledTimes(1);
});

function fakeRunsClient(rows: unknown, error: unknown = null) {
  const calls: unknown[][] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal']) {
    builder[method] = (...args: unknown[]) => { calls.push([method, ...(method === 'abortSignal' ? [args[0] instanceof AbortSignal] : args)]); return builder; };
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(resolve);
  return { calls, client: { from: (table: string) => { calls.push(['from', table]); return builder; } } as never };
}

it('reads only the recovery job’s newest run records, bounded by a timeout', async () => {
  const { calls, client } = fakeRunsClient([run(0, 'running', false), run(1, 'success')]);
  await expect(checkRecoveryHeartbeat(client, now)).resolves.toBeNull();
  expect(calls).toEqual([
    ['from', 'scheduled_job_runs'], ['select', 'status, started_at, finished_at'], ['eq', 'job_key', 'runtime_recovery'],
    ['order', 'started_at', { ascending: false }], ['limit', RECOVERY_FAILING_RUNS + 1], ['abortSignal', true],
  ]);
});

it('never throws and never alerts when the run history cannot be read', async () => {
  await expect(checkRecoveryHeartbeat(fakeRunsClient(null, { code: '57014' }).client, now)).resolves.toBeNull();
  await expect(checkRecoveryHeartbeat({ from: () => { throw new Error('private'); } } as never, now)).resolves.toBeNull();
  expect(console.warn).toHaveBeenLastCalledWith('[recovery-alert] RUNTIME_RECOVERY_RUNS_UNAVAILABLE');
  expect(m.captureMessage).not.toHaveBeenCalled();
  expect(m.alert).not.toHaveBeenCalled();
});

it('both codes and their one integer survive the Sentry scrubber, nothing else does', () => {
  for (const code of ['RUNTIME_RECOVERY_RUN_STALE', 'RUNTIME_RECOVERY_RUN_FAILING']) expect(scrubText(code)).toBe(code);
  const scrubbed = (message: string, extra: object) => scrubErrorEvent({ message, level: 'error', extra: { ...extra, turnId: 42, note: 'private' } } as never);
  expect(scrubbed('RUNTIME_RECOVERY_RUN_STALE', { minutesSinceLastRun: 25 })).toMatchObject({
    message: 'RUNTIME_RECOVERY_RUN_STALE', fingerprint: ['RUNTIME_RECOVERY_RUN_STALE'], extra: { minutesSinceLastRun: 25 } });
  expect(scrubbed('RUNTIME_RECOVERY_RUN_FAILING', { failingRuns: 3 }).extra).toEqual({ failingRuns: 3 });
});
