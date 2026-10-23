/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runAutomaticFinancialRecovery } from '@repo/api/src/services/runtime/automaticRecovery';
import { deliverStopLossAlerts } from '@repo/api/src/services/runtime/stopLossNotify';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'runtime-recovery');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  const db = createClient(url, key);
  let response: NextResponse;
  try {
    const summary = await runAutomaticFinancialRecovery(db);
    // An unconfirmed or time-deferred automatic stale-round refund keeps the job failing (alerting) until a later run settles it.
    const success = summary.failed === 0 && (summary.staleRounds?.failed ?? 0) === 0
      && (summary.staleRounds?.deferred ?? 0) === 0;
    response = NextResponse.json({ success, ...summary }, { status: success ? 200 : 500 });
  } catch {
    response = NextResponse.json({ error: 'Runtime recovery failed' }, { status: 500 });
  }
  // RUNTIME-PROD slice C rides on this minute cron: mails new stop-loss alerts after recovery. It never
  // throws and does not change the recovery status; delivery failures are kept on the alert rows.
  await deliverStopLossAlerts(db);
  return response;
}
