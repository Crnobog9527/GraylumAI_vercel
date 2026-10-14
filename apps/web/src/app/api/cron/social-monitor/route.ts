/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadPostForMeDeps } from '@repo/api/src/services/publishMonitor/secrets';
import { runSocialMonitorJob } from '@repo/api/src/services/publishMonitor/socialMonitorJob';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
// Vercel Hobby allows 300 seconds; the job stops starting new work at 240 seconds (plan §8).
export const maxDuration = 300;

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'social-monitor');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  const deps = await loadPostForMeDeps().catch(() => null);
  // No Post for Me key in this environment: nothing to clean at the provider yet.
  if (!deps) return NextResponse.json({ success: true, skipped: 'POSTFORME_NOT_CONFIGURED' });
  try {
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const report = await runSocialMonitorJob(client, deps, Date.now() + 240_000);
    const success = report.failures.length === 0;
    return NextResponse.json({ success, ...report }, { status: success ? 200 : 500 });
  } catch {
    return NextResponse.json({ error: 'Social monitor job failed' }, { status: 500 });
  }
}
