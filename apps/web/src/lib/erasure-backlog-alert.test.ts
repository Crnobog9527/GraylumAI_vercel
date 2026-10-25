/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), flush: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
import {
  ERASURE_BACKLOG_ERROR_MS, ERASURE_BACKLOG_FATAL_MS, LIBRARY_BACKLOG_ALERT_MS,
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
    extra: { pending: 3, overdue: 1, oldestHours: 25 },
  });
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
    fingerprint: ['LIBRARY_CLEANUP_BACKLOG'], extra: { pending: 3, overdue: 1, oldestHours: 25 } });
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

it('checks the library backlog through its RPC with a timeout, and logs a fixed code on failure', async () => {
  const abortSignal = vi.fn().mockResolvedValue({ data: { pending: 2, overdue: 1, oldestDeletedAt: ago(25 * 3_600_000) }, error: null });
  const rpc = vi.fn(() => ({ abortSignal }));
  expect(await checkLibraryBacklog({ rpc } as never, now)).toBe('fatal');
  expect(rpc).toHaveBeenCalledWith('library_cleanup_backlog', { a: null });
  expect(console.warn).toHaveBeenCalledWith('[erasure-alert] LIBRARY_CLEANUP_BACKLOG fatal');
  abortSignal.mockResolvedValue({ data: null, error: { message: 'private detail' } });
  expect(await checkLibraryBacklog({ rpc } as never, now)).toBeNull();
  expect(console.warn).toHaveBeenLastCalledWith('[erasure-alert] LIBRARY_CLEANUP_BACKLOG_UNAVAILABLE');
});

it('flushes Sentry with a bound and never throws', async () => {
  sentry.flush.mockResolvedValue(true);
  await flushAlerts();
  expect(sentry.flush).toHaveBeenCalledWith(2000);
  sentry.flush.mockRejectedValue(new Error('network'));
  await expect(flushAlerts()).resolves.toBeUndefined();
});
