/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runAccountErasureExecutor } from '@repo/api/src/services/accountErasure/executor';
import { validateCronRequest } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'account-erasure');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  try {
    const summary = await runAccountErasureExecutor(createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }));
    const success = summary.failed === 0 && summary.pending === 0;
    return NextResponse.json({ success, ...summary }, { status: success ? 200 : 500 });
  } catch {
    return NextResponse.json({ error: 'Account erasure failed' }, { status: 500 });
  }
}
