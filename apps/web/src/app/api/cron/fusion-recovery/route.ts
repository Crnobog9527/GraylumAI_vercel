/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { recoverFusionFinancials } from '@repo/api/src/services/fusion/recovery';
import { recoverFusionTurns } from '@repo/api/src/services/turn/fusionRecovery';
import { createCronServiceClient, validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
/** A dispatched call is recovered this long after its dispatch deadline (the call itself ends within 300 s of dispatch). */
const DISPATCHED_GRACE_MS = 10 * 60_000;

/** MAINT-P3b: the daily billing-reconcile settles Fusion (review and compare) calls once a day. A compare column whose settlement
 * failed holds its credits and the user's one compare slot until then, so the same step also runs here, every ten minutes.
 * It is the same idempotent step (claims and settlements are row-locked), so it can overlap the daily run. */
export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'fusion-recovery');
  if (unauthorized) return unauthorized;
  const client = createCronServiceClient();
  if (!client) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  try {
    const summary = await recoverFusionFinancials(client, { dispatchedGraceMs: DISPATCHED_GRACE_MS });
    // CORE-PATH-V2 V2-7b: reviews and compares on the turn path (24-hour end, deleted reviews, records of closed turns).
    const turns = await recoverFusionTurns(client);
    return NextResponse.json({ ...summary, turns }, { status: summary.success && turns.success ? 200 : 500 });
  } catch { return NextResponse.json({ error: 'Fusion recovery failed' }, { status: 500 }); }
}
