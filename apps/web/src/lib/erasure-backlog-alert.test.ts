/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), flush: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
import {
  ERASURE_BACKLOG_ERROR_MS, ERASURE_BACKLOG_FATAL_MS, LIBRARY_BACKLOG_ALERT_MS,
  LIBRARY_BACKLOG_ERROR_PENDING, LIBRARY_BACKLOG_FATAL_PENDING, LIBRARY_FAILING_RUNS,
  checkErasureBacklog, checkLibraryBacklog, flushAlerts, readErasureBacklog, reportErasureBacklog, reportLibraryBacklog,
} from './erasure-backlog-alert';
import { scrubErrorEvent, scrubText } from './sentry-scrub';

const now = Date.parse('2026-10-24T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); });

it('stays quiet while library deletions are inside the upload guard plus six hours', () => {
  expect(reportLibraryBacklog({ pending: 500, overdue: 0, oldestDeletedAt: ago(LIBRARY_BACKLOG_ALERT_MS - 60_000) }, now)).toBeNull();
  expect(reportLibraryBacklog({ pending: 0, overdue: 0, oldestDeletedAt: null }, now)).toBeNull();
  expect(sentry.captureMessage).not.toHaveBeenCalled();
});

it('raises the library backlog with counts only, fatal once a deletion is past 24 hours', () => {
  expect(reportLibraryBacklog({ pending: 3, overdue: 0, oldestDeletedAt: ago(LIBRARY_BACKLOG_ALERT_MS + 60_000) }, now)).toBe('error');
  expect(reportLibraryBacklog({ pending: 3, overdue: 1, oldestDeletedAt: ago(25 * 3_600_000) }, now)).toBe('fatal');
  expect(sentry.captureMessage).toHaveBeenLastCalledWith('LIBRARY_CLEANUP_BACKLOG', {
    level: 'fatal', fingerprint: ['LIBRARY_CLEANUP_BACKLOG'],
    tags: { category: 'data_erasure', code: 'LIBRARY_CLEANUP_BACKLOG' },
    extra: { pending: 3, overdue: 1, oldestHours: 25, failingRuns: 0 },
  });
});

it('raises the library backlog on the pending count alone, at exactly 3000 and 5000', () => {
  const fresh = ago(60_000);
  expect(LIBRARY_BACKLOG_ERROR_PENDING).toBe(3000);
  expect(LIBRARY_BACKLOG_FATAL_PENDING).toBe(5000);
  expect(reportLibraryBacklog({ pending: 2999, overdue: 0, oldestDeletedAt: fresh }, now)).toBeNull();
  expect(reportLibraryBacklog({ pending: 3000, overdue: 0, oldestDeletedAt: fresh }, now)).toBe('error');
  expect(reportLibraryBacklog({ pending: 4999, overdue: 0, oldestDeletedAt: fresh }, now)).toBe('error');
  expect(reportLibraryBacklog({ pending: 5000, overdue: 0, oldestDeletedAt: fresh }, now)).toBe('fatal');
  expect(sentry.captureMessage).toHaveBeenLastCalledWith('LIBRARY_CLEANUP_BACKLOG', expect.objectContaining({
    level: 'fatal', extra: { pending: 5000, overdue: 0, oldestHours: 0, failingRuns: 0 },
  }));
});

it('raises the library backlog after six failing cleanup runs in a row, even with nothing pending', () => {
  expect(LIBRARY_FAILING_RUNS).toBe(6);
  expect(reportLibraryBacklog({ pending: 0, overdue: 0, oldestDeletedAt: null, failingRuns: 5 }, now)).toBeNull();
  expect(reportLibraryBacklog({ pending: 0, overdue: 0, oldestDeletedAt: null, failingRuns: 6 }, now)).toBe('error');
  expect(reportLibraryBacklog({ pending: 5000, overdue: 0, oldestDeletedAt: null, failingRuns: 6 }, now)).toBe('fatal');
});

// A fake PostgREST builder that applies the filters the code sends, so counts come from the "database" side.
function fakeBacklogClient(times: string[], fail = false) {
  const calls: unknown[][] = [];
  const builder = (head: boolean) => {
    let rows = [...times];
    const query = {
      neq: (column: string, value: string) => { calls.push(['neq', column, value]); return query; },
      lt: (column: string, value: string) => { calls.push(['lt', column, value]); rows = rows.filter(t => t < value); return query; },
      order: (column: string, options: object) => { calls.push(['order', column, options]); rows.sort(); return query; },
      limit: (n: number) => { calls.push(['limit', n]); rows = rows.slice(0, n); return query; },
      abortSignal: (signal: AbortSignal) => { calls.push(['abortSignal', signal instanceof AbortSignal]); return query; },
      then: (resolve: (value: unknown) => void) => resolve(fail ? { data: null, count: null, error: { message: 'private detail' } }
        : head ? { data: null, count: rows.length, error: null } : { data: rows.map(t => ({ confirmed_at: t })), error: null }),
    };
    return query;
  };
  const client = { from: (table: string) => {
    calls.push(['from', table]);
    return { select: (column: string, options?: { head?: boolean }) => { calls.push(['select', column, options]); return builder(Boolean(options?.head)); } };
  } };
  return { calls, client: client as never };
}

it('counts unfinished erasures in the database, beyond any one page, with the oldest first', async () => {
  const recent = Array.from({ length: 1499 }, (_, i) => ago(60_000 + i));
  const { calls, client } = fakeBacklogClient([...recent, ago(ERASURE_BACKLOG_FATAL_MS + 60_000)]);
  const backlog = await readErasureBacklog(client, now);
  expect(backlog).toEqual({ open: 1500, overError: 1, overFatal: 1, oldestConfirmedAt: ago(ERASURE_BACKLOG_FATAL_MS + 60_000) });
  expect(calls).toContainEqual(['from', 'account_erasure_requests']);
  expect(calls.filter(call => call[0] === 'neq').every(call => call[1] === 'stage' && call[2] === 'completed')).toBe(true);
  expect(calls).toContainEqual(['select', 'confirmed_at', { count: 'exact', head: true }]);
  expect(calls).toContainEqual(['lt', 'confirmed_at', ago(ERASURE_BACKLOG_ERROR_MS)]);
  expect(calls).toContainEqual(['lt', 'confirmed_at', ago(ERASURE_BACKLOG_FATAL_MS)]);
  expect(calls).toContainEqual(['order', 'confirmed_at', { ascending: true }]);
  expect(reportErasureBacklog(backlog, now)).toBe('fatal');
  expect(sentry.captureMessage).toHaveBeenCalledWith('ERASURE_BACKLOG', expect.objectContaining({
    level: 'fatal', extra: { open: 1500, over12h: 1, over20h: 1, oldestHours: 20 },
  }));
});

it('alerts erasures at 12 hours as error and stays quiet before that', () => {
  expect(reportErasureBacklog({ open: 4, overError: 0, overFatal: 0, oldestConfirmedAt: ago(3_600_000) }, now)).toBeNull();
  expect(reportErasureBacklog({ open: 1, overError: 1, overFatal: 0, oldestConfirmedAt: ago(13 * 3_600_000) }, now)).toBe('error');
});

it('fails closed when the backlog cannot be read', async () => {
  await expect(readErasureBacklog(fakeBacklogClient([], true).client, now)).rejects.toThrow('ERASURE_BACKLOG_UNAVAILABLE');
});

it('both codes pass the Sentry scrubber as their fixed message', () => {
  for (const code of ['LIBRARY_CLEANUP_BACKLOG', 'ERASURE_BACKLOG']) expect(scrubText(code)).toBe(code);
});

it('the counts and fixed fingerprint survive the Sentry scrubber, nothing else does', () => {
  reportLibraryBacklog({ pending: 3, overdue: 1, oldestDeletedAt: ago(25 * 3_600_000) }, now);
  reportErasureBacklog({ open: 2, overError: 1, overFatal: 1, oldestConfirmedAt: ago(21 * 3_600_000) }, now);
  const [[libCode, lib], [erasureCode, erasure]] = sentry.captureMessage.mock.calls;
  const scrubbed = (code: string, hint: { level: string; fingerprint: string[]; extra: object }) => scrubErrorEvent({
    message: code, level: hint.level, fingerprint: hint.fingerprint, tags: { category: 'data_erasure', code },
    extra: { ...hint.extra, documentId: 'a1b2c3d4-0000-4000-8000-000000000000', note: 'private text' },
  } as never);
  expect(scrubbed(libCode, lib)).toMatchObject({ message: 'LIBRARY_CLEANUP_BACKLOG', level: 'fatal',
    fingerprint: ['LIBRARY_CLEANUP_BACKLOG'], extra: { pending: 3, overdue: 1, oldestHours: 25, failingRuns: 0 } });
  expect(scrubbed(erasureCode, erasure).extra).toEqual({ open: 2, over12h: 1, over20h: 1, oldestHours: 21 });
  const other = scrubErrorEvent({ message: 'PAY_SOMETHING', extra: { pending: 3 }, fingerprint: ['x'] } as never);
  expect(other.extra).toBeUndefined(); expect(other.fingerprint).toBeUndefined();
  const odd = scrubErrorEvent({ message: 'ERASURE_BACKLOG', extra: { open: -1, over12h: 1.5, over20h: '2', oldestHours: 3 } } as never);
  expect(odd.extra).toEqual({ oldestHours: 3 });
});

it('every backlog read is bounded by a timeout signal', async () => {
  const { calls, client } = fakeBacklogClient([ago(60_000)]);
  await readErasureBacklog(client, now);
  expect(calls.filter(call => call[0] === 'abortSignal')).toEqual(Array(4).fill(['abortSignal', true]));
});

it('checking logs a fixed line when an alert fires, and a fixed code when the read fails', async () => {
  const { client } = fakeBacklogClient([ago(ERASURE_BACKLOG_ERROR_MS + 60_000)]);
  expect(await checkErasureBacklog(client, now)).toBe('error');
  expect(console.warn).toHaveBeenCalledWith('[erasure-alert] ERASURE_BACKLOG error');
  expect(await checkErasureBacklog(fakeBacklogClient([], true).client, now)).toBeNull();
  expect(console.warn).toHaveBeenLastCalledWith('[erasure-alert] ERASURE_BACKLOG_UNAVAILABLE');
});

// Library cleanup run history, newest first: { status } rows as scheduled_job_runs returns them.
function fakeLibraryClient(backlog: object | null, statuses: string[] | null) {
  const calls: unknown[][] = [];
  const abortSignal = vi.fn().mockResolvedValue(backlog ? { data: backlog, error: null } : { data: null, error: { message: 'private detail' } });
  const runs = {
    eq: (column: string, value: string) => { calls.push(['eq', column, value]); return runs; },
    not: (column: string, op: string, value: null) => { calls.push(['not', column, op, value]); return runs; },
    order: (column: string, options: object) => { calls.push(['order', column, options]); return runs; },
    limit: (n: number) => { calls.push(['limit', n]); return runs; },
    abortSignal: (signal: AbortSignal) => {
      calls.push(['abortSignal', signal instanceof AbortSignal]);
      return Promise.resolve(statuses ? { data: statuses.map(status => ({ status })), error: null }
        : { data: null, error: { message: 'private detail' } });
    },
  };
  const client = {
    rpc: vi.fn(() => ({ abortSignal })),
    from: (table: string) => { calls.push(['from', table]); return { select: (column: string) => { calls.push(['select', column]); return runs; } }; },
  };
  return { calls, client };
}

it('checks the library backlog through its RPC with a timeout, and logs a fixed code on failure', async () => {
  const ok = fakeLibraryClient({ pending: 2, overdue: 1, oldestDeletedAt: ago(25 * 3_600_000) }, ['success']);
  expect(await checkLibraryBacklog(ok.client as never, now)).toBe('fatal');
  expect(ok.client.rpc).toHaveBeenCalledWith('library_cleanup_backlog', { a: null });
  expect(console.warn).toHaveBeenCalledWith('[erasure-alert] LIBRARY_CLEANUP_BACKLOG fatal');
  expect(await checkLibraryBacklog(fakeLibraryClient(null, ['success']).client as never, now)).toBeNull();
  expect(console.warn).toHaveBeenLastCalledWith('[erasure-alert] LIBRARY_CLEANUP_BACKLOG_UNAVAILABLE');
});

it('counts failing library cleanup runs newest first, stopping at the first success', async () => {
  const quiet = { pending: 0, overdue: 0, oldestDeletedAt: null };
  const failing = fakeLibraryClient(quiet, Array(6).fill('error'));
  expect(await checkLibraryBacklog(failing.client as never, now)).toBe('error');
  expect(failing.calls).toEqual(expect.arrayContaining([['from', 'scheduled_job_runs'], ['select', 'status'],
    ['eq', 'job_key', 'library_cleanup'], ['not', 'finished_at', 'is', null],
    ['order', 'started_at', { ascending: false }], ['limit', 6], ['abortSignal', true]]));
  expect(sentry.captureMessage).toHaveBeenLastCalledWith('LIBRARY_CLEANUP_BACKLOG', expect.objectContaining({
    level: 'error', extra: { pending: 0, overdue: 0, oldestHours: 0, failingRuns: 6 },
  }));
  sentry.captureMessage.mockClear();
  // Five recent failures after a success is still recovering, not an outage.
  const recovering = fakeLibraryClient(quiet, ['error', 'error', 'error', 'error', 'error', 'success']);
  expect(await checkLibraryBacklog(recovering.client as never, now)).toBeNull();
  // Fewer than six finished runs (a fresh deployment) cannot reach the threshold.
  expect(await checkLibraryBacklog(fakeLibraryClient(quiet, ['error', 'error']).client as never, now)).toBeNull();
  expect(sentry.captureMessage).not.toHaveBeenCalled();
});

it('a failed run-history read never hides the backlog alert', async () => {
  const { client } = fakeLibraryClient({ pending: 5000, overdue: 0, oldestDeletedAt: ago(60_000) }, null);
  expect(await checkLibraryBacklog(client as never, now)).toBe('fatal');
  expect(console.warn).toHaveBeenCalledWith('[erasure-alert] LIBRARY_CLEANUP_RUNS_UNAVAILABLE');
});

it('flushes Sentry with a bound and never throws', async () => {
  sentry.flush.mockResolvedValue(true);
  await flushAlerts();
  expect(sentry.flush).toHaveBeenCalledWith(2000);
  sentry.flush.mockRejectedValue(new Error('network'));
  await expect(flushAlerts()).resolves.toBeUndefined();
});
