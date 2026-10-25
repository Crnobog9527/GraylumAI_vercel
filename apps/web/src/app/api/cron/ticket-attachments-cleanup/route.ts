/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runTicketAttachmentCleanup } from '@repo/api/src/services/ticketAttachmentCleanup';
import { validateCronRequest } from '@/lib/cron-auth';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'ticket_attachments_cleanup');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  try {
    const result = await runTicketAttachmentCleanup(createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) },
    }));
    return NextResponse.json({ success: result.failed === 0, ...result }, { status: result.failed ? 500 : 200 });
  } catch { return NextResponse.json({ error: 'Ticket attachment cleanup failed' }, { status: 500 }); }
}
