/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { finishScheduledJobRun, startScheduledJobRun } from '@repo/api/src/services/scheduledJobRuns';
import { loadPostForMeDeps } from '@repo/api/src/services/publishMonitor/secrets';
import { runSocialMonitorJob } from '@repo/api/src/services/publishMonitor/socialMonitorJob';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
// Vercel Hobby allows 300 seconds; the job stops starting new work at 240 seconds (plan §8).
export const maxDuration = 300;
const SOCIAL_MONITOR_JOB = 'social_monitor';

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'social-monitor');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  // Every run is recorded (plan §8: scheduled_job_runs keeps the run result, never used as a work queue).
  let runId: string;
  try {
    runId = await startScheduledJobRun({ supabase: client, jobKey: SOCIAL_MONITOR_JOB, triggerSource: 'cron' });
  } catch {
    return NextResponse.json({ error: 'Social monitor job failed' }, { status: 500 });
  }
  // A failed final write fails the response too, so a "running" record never sits behind a reported success.
  const finish = (status: 'success' | 'error', summary: Record<string, unknown>, error: string | null = null) =>
    finishScheduledJobRun({ supabase: client, runId, status, summary, error });
  const deps = await loadPostForMeDeps().catch(() => null);
  // No Post for Me key in this environment: nothing to clean at the provider yet.
  try {
    if (!deps) {
      await finish('success', { skipped: 'POSTFORME_NOT_CONFIGURED' });
      return NextResponse.json({ success: true, skipped: 'POSTFORME_NOT_CONFIGURED' });
    }
    const report = await runSocialMonitorJob(client, deps, Date.now() + 240_000);
    const success = report.failures.length === 0;
    await finish(success ? 'success' : 'error', report, success ? null : `FAILED_STEPS:${report.failures.join(',')}`);
    return NextResponse.json({ success, ...report }, { status: success ? 200 : 500 });
  } catch {
    await finish('error', {}, 'SOCIAL_MONITOR_FAILED').catch(() => undefined);
    return NextResponse.json({ error: 'Social monitor job failed' }, { status: 500 });
  }
}
