/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { finishScheduledJobRun, startScheduledJobRun } from '@repo/api/src/services/scheduledJobRuns';
import { loadPostForMeDeps } from '@repo/api/src/services/publishMonitor/secrets';
import {
  entitlementWindow, runSocialMonitorJob, tikhubEntitlements,
} from '@repo/api/src/services/publishMonitor/socialMonitorJob';
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
  // A missing key means no Post for Me client; a configured but invalid key, or a Vault that cannot be read, is a
  // failure monitoring must see. Either way the work that needs no Post for Me key still runs: retention, held credits
  // (billed TikHub runs a killed process left open must not stay frozen until the key is repaired) and TikHub reads.
  let deps: Awaited<ReturnType<typeof loadPostForMeDeps>> = null;
  let keyError: string | null = null;
  try { deps = await loadPostForMeDeps(client); } catch (error) {
    keyError = error instanceof Error && error.message === 'POSTFORME_KEY_INVALID'
      ? 'POSTFORME_KEY_INVALID' : 'PLATFORM_SECRET_UNAVAILABLE';
  }
  try {
    const report = await runSocialMonitorJob(client, deps, Date.now() + 240_000, entitlementWindow(client), Date.now,
      { env: process.env, entitlement: tikhubEntitlements(client) });
    if (keyError) report.failures.push('postforme_key');
    const success = report.failures.length === 0;
    await finish(success ? 'success' : 'error', { ...report, ...(keyError ? { postForMeKeyError: keyError } : {}) },
      keyError ?? (success ? null : `FAILED_STEPS:${report.failures.join(',')}`));
    return NextResponse.json({ success, ...report }, { status: success ? 200 : 500 });
  } catch {
    await finish('error', {}, 'SOCIAL_MONITOR_FAILED').catch(() => undefined);
    return NextResponse.json({ error: 'Social monitor job failed' }, { status: 500 });
  }
}
