/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { withViewVersionBump } from '@repo/api/src/services/runtimeViewVersion';
import { runAutomaticFinancialRecovery } from '@repo/api/src/services/runtime/automaticRecovery';
import { deliverStopLossAlerts } from '@repo/api/src/services/runtime/stopLossNotify';
import { startScheduledJobRun, finishScheduledJobRun } from '@repo/api/src/services/scheduledJobRuns';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
const STOP_LOSS_DELIVERY_CAP_MS = 12_000;
const RUNTIME_RECOVERY_JOB_KEY = 'runtime_recovery';
// The route limit is 60 s = stop-loss cap 12 s + recovery 45 s; the two run-record writes share the rest.
const RUN_RECORD_CAP_MS = 1_500;
/** A run-record write that has not answered in time is given up (null), never waited for. */
const capped = <T>(write: Promise<T>) => Promise.race([write.catch(() => null),
  new Promise<null>(resolve => setTimeout(() => resolve(null), RUN_RECORD_CAP_MS))]);

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'runtime-recovery');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  // DB-100 C5: writes here bump conversation view versions (runtimeViewVersion.ts).
  const db = createClient(url, key, { global: { fetch: withViewVersionBump(fetch) } });
  // RUNTIME-PROD slice C: mail new stop-loss alerts first, bounded to leave the recovery its own budget
  // (route limit 60s = this cap + recovery 45s). It never throws and does not affect recovery status;
  // delivery failures are kept on the alert rows.
  await Promise.race([deliverStopLossAlerts(db), new Promise(resolve => setTimeout(resolve, STOP_LOSS_DELIVERY_CAP_MS))]);
  // Line D1: every run leaves counts in scheduled_job_runs. A failed record never blocks the recovery itself.
  const runId = await capped(startScheduledJobRun({ supabase: db, jobKey: RUNTIME_RECOVERY_JOB_KEY, triggerSource: 'cron' }));
  const finish = (status: 'success' | 'error', summary: Record<string, unknown>, error?: string) => runId
    ? capped(finishScheduledJobRun({ supabase: db, runId, status, summary, error })) : undefined;
  let response: NextResponse;
  try {
    const summary = await runAutomaticFinancialRecovery(db);
    // An unconfirmed or time-deferred automatic stale-round refund keeps the job failing (alerting) until a later run settles it.
    const success = summary.failed === 0 && (summary.staleRounds?.failed ?? 0) === 0
      && (summary.staleRounds?.deferred ?? 0) === 0;
    await finish(success ? 'success' : 'error', summary);
    response = NextResponse.json({ success, ...summary }, { status: success ? 200 : 500 });
  } catch {
    await finish('error', {}, 'RUNTIME_RECOVERY_FAILED');
    response = NextResponse.json({ error: 'Runtime recovery failed' }, { status: 500 });
  }
  return response;
}
