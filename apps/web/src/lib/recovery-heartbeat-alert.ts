/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { captureMessage } from '@sentry/nextjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { alertOwnerAfterResponse } from '@/lib/owner-alert';

// POST-LAUNCH-MONITORING S9: the every-minute runtime-recovery cron is what closes interrupted turns and returns their frozen
// credits. When it stops being scheduled, or every run fails, nothing else notices: the frozen credits just stay frozen.
// This check runs from another cron (library-cleanup, every 5 minutes), never from the job it watches, and reads only the
// run records the job already writes (scheduled_job_runs). Two fixed codes, integers only; sentry-scrub.ts keeps exactly
// these extras. The Owner hears once per code every six hours while it lasts (ops_backlog).
const MINUTE = 60_000;
/** The job runs every minute; ten minutes without a new run record means it is not being run. */
export const RECOVERY_STALE_MS = 10 * MINUTE;
/** Three finished runs in a row that did not succeed: a run that fails once is retried a minute later and is not news. */
export const RECOVERY_FAILING_RUNS = 3;
const JOB_KEY = 'runtime_recovery';
const READ_TIMEOUT_MS = 2_000;

type Run = { status?: string | null; started_at?: string | null; finished_at?: string | null };
export type RecoveryHeartbeat = 'RUNTIME_RECOVERY_RUN_STALE' | 'RUNTIME_RECOVERY_RUN_FAILING';

function raise(code: RecoveryHeartbeat, extra: Record<string, number>) {
  captureMessage(code, { level: 'error', fingerprint: [code], tags: { category: 'runtime_recovery', code }, extra });
  console.warn(`[recovery-alert] ${code} error`);
  alertOwnerAfterResponse('ops_backlog', { code, level: 'error' });
}

/** `runs`: the job's latest run records, newest first. Stale wins: when nothing runs, the old failures are not the news. */
export function reportRecoveryHeartbeat(runs: Run[], now = Date.now()): RecoveryHeartbeat | null {
  const latest = runs[0]?.started_at ? Date.parse(runs[0].started_at) : NaN;
  if (!Number.isFinite(latest) || now - latest > RECOVERY_STALE_MS) {
    // No record at all is reported as stale too: a database this code runs on has had the job scheduled since its first deploy.
    raise('RUNTIME_RECOVERY_RUN_STALE', Number.isFinite(latest) ? { minutesSinceLastRun: Math.floor((now - latest) / MINUTE) } : {});
    return 'RUNTIME_RECOVERY_RUN_STALE';
  }
  const finished = runs.filter(run => run.finished_at).slice(0, RECOVERY_FAILING_RUNS);
  if (finished.length === RECOVERY_FAILING_RUNS && finished.every(run => run.status !== 'success')) {
    raise('RUNTIME_RECOVERY_RUN_FAILING', { failingRuns: finished.length });
    return 'RUNTIME_RECOVERY_RUN_FAILING';
  }
  return null;
}

/** Never throws and never waits long: the cron that calls it has its own work. An unreadable history is logged, not alerted. */
export async function checkRecoveryHeartbeat(client: SupabaseClient, now = Date.now()): Promise<RecoveryHeartbeat | null> {
  try {
    // One more than the failing-run count: the newest record is usually the run in flight, which has no result yet.
    const { data, error } = await client.from('scheduled_job_runs').select('status, started_at, finished_at')
      .eq('job_key', JOB_KEY).order('started_at', { ascending: false }).limit(RECOVERY_FAILING_RUNS + 1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error || !Array.isArray(data)) throw new Error('RUNTIME_RECOVERY_RUNS_UNAVAILABLE');
    return reportRecoveryHeartbeat(data as Run[], now);
  } catch {
    console.warn('[recovery-alert] RUNTIME_RECOVERY_RUNS_UNAVAILABLE');
    return null;
  }
}
