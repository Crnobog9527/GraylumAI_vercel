/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runAccountErasureExecutor } from '@repo/api/src/services/accountErasure/executor';
import { sweepErasedConversations } from '@repo/api/src/services/accountErasure/content';
import { validateCronRequest } from '@/lib/cron-auth';
import { checkErasureBacklog, flushAlerts } from '@/lib/erasure-backlog-alert';

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
    // The 24-hour promise is watched first, so this run's own length or failure cannot skip the alert.
    await checkErasureBacklog(client);
    // maxDuration 60s. Deleted conversations whose background cleanup did not finish (DATA-ERASURE
    // 0231) go first, inside a hard 12-second budget, so an account-erasure backlog can never starve
    // them. Account erasure then keeps its original 45-second deadline from the start of the run; its
    // follow-up calls are individually bounded (about 13 s worst case), which ends before 60 s.
    // Busy rows are retried within the sweep; anything still pending, failed or unreached fails the run.
    const started = Date.now();
    // A failing sweep must not skip account erasure in this run; it still fails the run below.
    const conversations = await sweepErasedConversations(client, started + 12_000).catch(() => null);
    const summary = await runAccountErasureExecutor(client, started + 45_000);
    if (!conversations) throw new Error('CONTENT_ERASURE_SWEEP_FAILED');
    const success = summary.failed === 0 && summary.pending === 0
      && conversations.pending === 0 && conversations.failed === 0 && !conversations.more;
    return NextResponse.json({ success, ...summary, conversations }, { status: success ? 200 : 500 });
  } catch {
    return NextResponse.json({ error: 'Account erasure failed' }, { status: 500 });
  } finally {
    await flushAlerts();
  }
}
