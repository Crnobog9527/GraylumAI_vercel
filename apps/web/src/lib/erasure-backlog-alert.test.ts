/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => sentry);
import {
  ERASURE_BACKLOG_ERROR_MS, ERASURE_BACKLOG_FATAL_MS, LIBRARY_BACKLOG_ALERT_MS,
  readErasureBacklog, reportErasureBacklog, reportLibraryBacklog,
} from './erasure-backlog-alert';
import { scrubText } from './sentry-scrub';

const now = Date.parse('2026-10-24T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
beforeEach(() => vi.resetAllMocks());

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

it('reads only unfinished erasures and counts the 12 h and 20 h marks', async () => {
  const neq = vi.fn().mockResolvedValue({ data: [
    { confirmed_at: ago(ERASURE_BACKLOG_FATAL_MS + 60_000) }, { confirmed_at: ago(ERASURE_BACKLOG_ERROR_MS + 60_000) },
    { confirmed_at: ago(60_000) },
  ], error: null });
  const select = vi.fn(() => ({ neq }));
  const from = vi.fn(() => ({ select }));
  const backlog = await readErasureBacklog({ from } as never, now);
  expect(from).toHaveBeenCalledWith('account_erasure_requests');
  expect(select).toHaveBeenCalledWith('confirmed_at');
  expect(neq).toHaveBeenCalledWith('stage', 'completed');
  expect(backlog).toEqual({ open: 3, overError: 2, overFatal: 1, oldestConfirmedAt: ago(ERASURE_BACKLOG_FATAL_MS + 60_000) });
  expect(reportErasureBacklog(backlog, now)).toBe('fatal');
  expect(sentry.captureMessage).toHaveBeenCalledWith('ERASURE_BACKLOG', expect.objectContaining({
    level: 'fatal', extra: { open: 3, over12h: 2, over20h: 1, oldestHours: 20 },
  }));
});

it('alerts erasures at 12 hours as error and stays quiet before that', () => {
  expect(reportErasureBacklog({ open: 4, overError: 0, overFatal: 0, oldestConfirmedAt: ago(3_600_000) }, now)).toBeNull();
  expect(reportErasureBacklog({ open: 1, overError: 1, overFatal: 0, oldestConfirmedAt: ago(13 * 3_600_000) }, now)).toBe('error');
});

it('fails closed when the backlog cannot be read', async () => {
  const neq = vi.fn().mockResolvedValue({ data: null, error: { message: 'private detail' } });
  await expect(readErasureBacklog({ from: () => ({ select: () => ({ neq }) }) } as never, now))
    .rejects.toThrow('ERASURE_BACKLOG_UNAVAILABLE');
});

it('both codes pass the Sentry scrubber as their fixed message', () => {
  for (const code of ['LIBRARY_CLEANUP_BACKLOG', 'ERASURE_BACKLOG']) expect(scrubText(code)).toBe(code);
});
