/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { recoverFusionTurns } from '@repo/api/src/services/turn/fusionRecovery';
import { createCronServiceClient, validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;
/** CORE-PATH-V2 V2-7b: every ten minutes, reviews and compares on the turn path end or refund what is due (24-hour end, deleted
 * reviews, records of closed turns). The BILL2 step that served the old path is gone (V2-12 B4/B5). Idempotent and row-locked. */
export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'fusion-recovery');
  if (unauthorized) return unauthorized;
  const client = createCronServiceClient();
  if (!client) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  try {
    const turns = await recoverFusionTurns(client);
    return NextResponse.json({ turns }, { status: turns.success ? 200 : 500 });
  } catch { return NextResponse.json({ error: 'Fusion recovery failed' }, { status: 500 }); }
}
