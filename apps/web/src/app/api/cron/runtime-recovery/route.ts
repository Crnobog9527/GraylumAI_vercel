/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runAutomaticFinancialRecovery } from '@repo/api/src/services/runtime/automaticRecovery';
import { deliverStopLossAlerts } from '@repo/api/src/services/runtime/stopLossNotify';
import { startScheduledJobRun, finishScheduledJobRun } from '@repo/api/src/services/scheduledJobRuns';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
const STOP_LOSS_DELIVERY_CAP_MS = 12_000;
const RUNTIME_RECOVERY_JOB_KEY = 'runtime_recovery';

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'runtime-recovery');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  const db = createClient(url, key);
  // RUNTIME-PROD slice C: mail new stop-loss alerts first, bounded to leave the recovery its own budget
  // (route limit 60s = this cap + recovery 45s). It never throws and does not affect recovery status;
  // delivery failures are kept on the alert rows.
  await Promise.race([deliverStopLossAlerts(db), new Promise(resolve => setTimeout(resolve, STOP_LOSS_DELIVERY_CAP_MS))]);
  // Line D1: every run leaves counts in scheduled_job_runs. A failed record never blocks the recovery itself.
  const runId = await startScheduledJobRun({ supabase: db, jobKey: RUNTIME_RECOVERY_JOB_KEY, triggerSource: 'cron' })
    .catch(() => null);
  const finish = (status: 'success' | 'error', summary: Record<string, unknown>, error?: string) => runId
    ? finishScheduledJobRun({ supabase: db, runId, status, summary, error }).catch(() => undefined) : undefined;
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
