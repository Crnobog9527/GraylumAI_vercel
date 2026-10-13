/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runAccountErasureExecutor } from '@repo/api/src/services/accountErasure/executor';
import { sweepErasedConversations } from '@repo/api/src/services/accountErasure/content';
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
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const summary = await runAccountErasureExecutor(client);
    // Deleted conversations whose background cleanup did not finish (DATA-ERASURE 0231).
    // A busy conversation stays pending for the next run and does not fail this one.
    const conversations = await sweepErasedConversations(client);
    const success = summary.failed === 0 && summary.pending === 0;
    return NextResponse.json({ success, ...summary, conversations }, { status: success ? 200 : 500 });
  } catch {
    return NextResponse.json({ error: 'Account erasure failed' }, { status: 500 });
  }
}
