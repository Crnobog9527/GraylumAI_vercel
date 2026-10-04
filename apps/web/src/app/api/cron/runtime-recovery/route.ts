/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runAutomaticFinancialRecovery } from '@repo/api/src/services/runtime/automaticRecovery';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'runtime-recovery');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  try {
    const summary = await runAutomaticFinancialRecovery(createClient(url, key));
    return NextResponse.json({ success: summary.failed === 0, ...summary },
      { status: summary.failed === 0 ? 200 : 500 });
  } catch {
    return NextResponse.json({ error: 'Runtime recovery failed' }, { status: 500 });
  }
}
