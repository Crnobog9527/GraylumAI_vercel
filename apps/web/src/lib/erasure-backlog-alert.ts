/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';

// DATA-ERASURE: the privacy policy promises deletion within 24 hours. These alerts fire while there is still time to
// act, from the crons that do the work (every 5 minutes), so Sentry keeps one issue per code until the backlog clears.
// Only counts and hours leave the cron; no account, document or request id. sentry-scrub.ts keeps exactly these
// integer extras (and the fixed fingerprint) for these two codes and drops everything else.
const HOUR = 3_600_000;
// A library deletion waits for the upload guard (3 h 5 min after the upload began) before its object can be proven
// absent; six hours past that means cleanup is not keeping up.
export const LIBRARY_BACKLOG_ALERT_MS = 3 * HOUR + 5 * 60_000 + 6 * HOUR;
export const ERASURE_BACKLOG_ERROR_MS = 12 * HOUR;
export const ERASURE_BACKLOG_FATAL_MS = 20 * HOUR;

type Level = 'error' | 'fatal';
function raise(code: string, level: Level, extra: Record<string, number | string | null>) {
  captureMessage(code, { level, fingerprint: [code], tags: { category: 'data_erasure', code }, extra });
}
const ageMs = (iso: string | null, now: number) => (iso ? now - Date.parse(iso) : 0);

export function reportLibraryBacklog(
  backlog: { pending?: number; overdue?: number; oldestDeletedAt?: string | null },
  now = Date.now(),
) {
  const overdue = backlog.overdue ?? 0;
  const oldestAgeMs = ageMs(backlog.oldestDeletedAt ?? null, now);
  if (overdue === 0 && oldestAgeMs <= LIBRARY_BACKLOG_ALERT_MS) return null;
  const level: Level = overdue > 0 ? 'fatal' : 'error';
  raise('LIBRARY_CLEANUP_BACKLOG', level, {
    pending: backlog.pending ?? 0, overdue, oldestHours: Math.floor(oldestAgeMs / HOUR),
  });
  return level;
}

export type ErasureBacklog = { open: number; overError: number; overFatal: number; oldestConfirmedAt: string | null };
/** Account erasures confirmed but not completed, counted in the database (no row-limit page can hide an old one). */
export async function readErasureBacklog(client: SupabaseClient, now = Date.now()): Promise<ErasureBacklog> {
  const open = () => client.from('account_erasure_requests');
  const count = (olderThanMs?: number) => {
    const query = open().select('confirmed_at', { count: 'exact', head: true }).neq('stage', 'completed');
    return olderThanMs === undefined ? query : query.lt('confirmed_at', new Date(now - olderThanMs).toISOString());
  };
  const [all, overError, overFatal, oldest] = await Promise.all([
    count(), count(ERASURE_BACKLOG_ERROR_MS), count(ERASURE_BACKLOG_FATAL_MS),
    open().select('confirmed_at').neq('stage', 'completed').order('confirmed_at', { ascending: true }).limit(1),
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
