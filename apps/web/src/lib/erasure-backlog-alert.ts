/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage, flush } from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

// DATA-ERASURE: the privacy policy promises deletion within 24 hours. These alerts fire while there is still time to
// act, from the crons that do the work (every 5 minutes), so Sentry keeps one issue per code until the backlog clears.
// Only counts and hours leave the cron; no account, document or request id. sentry-scrub.ts keeps exactly these
// integer extras (and the fixed fingerprint) for these two codes and drops everything else.
const HOUR = 3_600_000;
// A library deletion waits for the upload guard (3 h 5 min after the upload began) before its object can be proven
// absent; six hours past that means cleanup is not keeping up.
export const LIBRARY_BACKLOG_ALERT_MS = 3 * HOUR + 5 * 60_000 + 6 * HOUR;
// REL-1 core 7 (6) drill (#1420): the worst case is about 3 h 5 min + pending / 600 hours at 100 rows per 5-minute run
// (about 8 h at 3000, 11.5 h at 5000). The age alert only fires at hour 9 of a burst; these counts fire as soon as the
// burst lands. The margin is kept for Storage outages: in the drill an 8-hour outage plus 10% failures took the same
// backlog from 13 h to 23 h. Six failing runs in a row (30 minutes) is such an outage.
export const LIBRARY_BACKLOG_ERROR_PENDING = 3000;
export const LIBRARY_BACKLOG_FATAL_PENDING = 5000;
export const LIBRARY_FAILING_RUNS = 6;
export const ERASURE_BACKLOG_ERROR_MS = 12 * HOUR;
export const ERASURE_BACKLOG_FATAL_MS = 20 * HOUR;

type Level = 'error' | 'fatal';
const READ_TIMEOUT_MS = 2_000;
function raise(code: string, level: Level, extra: Record<string, number | string | null>) {
  captureMessage(code, { level, fingerprint: [code], tags: { category: 'data_erasure', code }, extra });
  // A fixed line in the function log shows the alert fired even before Sentry is checked.
  console.warn(`[erasure-alert] ${code} ${level}`);
}
const ageMs = (iso: string | null, now: number) => (iso ? now - Date.parse(iso) : 0);

export function reportLibraryBacklog(
  backlog: { pending?: number; overdue?: number; oldestDeletedAt?: string | null; failingRuns?: number },
  now = Date.now(),
) {
  const pending = backlog.pending ?? 0;
  const overdue = backlog.overdue ?? 0;
  const failingRuns = backlog.failingRuns ?? 0;
  const oldestAgeMs = ageMs(backlog.oldestDeletedAt ?? null, now);
  const fatal = overdue > 0 || pending >= LIBRARY_BACKLOG_FATAL_PENDING;
  if (!fatal && oldestAgeMs <= LIBRARY_BACKLOG_ALERT_MS && pending < LIBRARY_BACKLOG_ERROR_PENDING
    && failingRuns < LIBRARY_FAILING_RUNS) return null;
  const level: Level = fatal ? 'fatal' : 'error';
  raise('LIBRARY_CLEANUP_BACKLOG', level, {
    pending, overdue, oldestHours: Math.floor(oldestAgeMs / HOUR), failingRuns,
  });
  return level;
}

/** Finished library cleanup runs in a row, newest first, that did not succeed (at most LIBRARY_FAILING_RUNS). */
async function readFailingRuns(client: SupabaseClient, signal: AbortSignal) {
  const { data, error } = await client.from('scheduled_job_runs').select('status').eq('job_key', 'library_cleanup')
    .not('finished_at', 'is', null).order('started_at', { ascending: false }).limit(LIBRARY_FAILING_RUNS)
    .abortSignal(signal);
  if (error || !Array.isArray(data)) throw new Error('LIBRARY_CLEANUP_RUNS_UNAVAILABLE');
  const firstSuccess = (data as { status?: string }[]).findIndex(run => run.status === 'success');
  return firstSuccess === -1 ? data.length : firstSuccess;
}

export type ErasureBacklog = { open: number; overError: number; overFatal: number; oldestConfirmedAt: string | null };
/** Account erasures confirmed but not completed, counted in the database (no row-limit page can hide an old one). */
export async function readErasureBacklog(client: SupabaseClient, now = Date.now()): Promise<ErasureBacklog> {
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const open = () => client.from('account_erasure_requests');
  const count = (olderThanMs?: number) => {
    const query = open().select('confirmed_at', { count: 'exact', head: true }).neq('stage', 'completed');
    return (olderThanMs === undefined ? query : query.lt('confirmed_at', new Date(now - olderThanMs).toISOString()))
      .abortSignal(signal);
  };
  const [all, overError, overFatal, oldest] = await Promise.all([
    count(), count(ERASURE_BACKLOG_ERROR_MS), count(ERASURE_BACKLOG_FATAL_MS),
    open().select('confirmed_at').neq('stage', 'completed').order('confirmed_at', { ascending: true }).limit(1)
      .abortSignal(signal),
  ]);
  if ([all, overError, overFatal, oldest].some(result => result.error)
    || [all, overError, overFatal].some(result => typeof result.count !== 'number')) {
    throw new Error('ERASURE_BACKLOG_UNAVAILABLE');
  }
  const first = (oldest.data ?? [])[0] as { confirmed_at?: string } | undefined;
  return {
    open: all.count as number, overError: overError.count as number, overFatal: overFatal.count as number,
    oldestConfirmedAt: first?.confirmed_at ? String(first.confirmed_at) : null,
  };
}

export function reportErasureBacklog(backlog: ErasureBacklog, now = Date.now()) {
  if (backlog.overError === 0) return null;
  const level: Level = backlog.overFatal > 0 ? 'fatal' : 'error';
  raise('ERASURE_BACKLOG', level, {
    open: backlog.open, over12h: backlog.overError, over20h: backlog.overFatal,
    oldestHours: Math.floor(ageMs(backlog.oldestConfirmedAt, now) / HOUR),
  });
  return level;
}

// The crons check the backlog first, before their own work, so the run's length or failure cannot skip it,
// and flush before replying so the event leaves the function. A failed read is logged with a fixed code.
export async function checkErasureBacklog(client: SupabaseClient, now = Date.now()) {
  try { return reportErasureBacklog(await readErasureBacklog(client, now), now); } catch {
    console.warn('[erasure-alert] ERASURE_BACKLOG_UNAVAILABLE');
    return null;
  }
}

export async function checkLibraryBacklog(client: SupabaseClient, now = Date.now()) {
  try {
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    // A failed run-history read must not hide the backlog itself: log it and count no failing runs.
    const [{ data, error }, failingRuns] = await Promise.all([
      client.rpc('library_cleanup_backlog', { a: null }).abortSignal(signal),
      readFailingRuns(client, signal).catch(() => {
        console.warn('[erasure-alert] LIBRARY_CLEANUP_RUNS_UNAVAILABLE');
        return 0;
      }),
    ]);
    if (error || !data) throw new Error('LIBRARY_BACKLOG_UNAVAILABLE');
    return reportLibraryBacklog({
      ...(data as { pending?: number; overdue?: number; oldestDeletedAt?: string | null }), failingRuns,
    }, now);
  } catch {
    console.warn('[erasure-alert] LIBRARY_CLEANUP_BACKLOG_UNAVAILABLE');
    return null;
  }
}

export async function flushAlerts() {
  try { await flush(READ_TIMEOUT_MS); } catch { /* delivery is best effort; the log line already records the alert */ }
}
