/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runLibraryCleanup } from '@repo/api/src/services/library/cleanup';
import { cleanOrphanPhotos } from '@repo/api/src/services/chatPhotos/photos';
import { validateCronRequest } from '@/lib/cron-auth';
import { checkLibraryBacklog, flushAlerts } from '@/lib/erasure-backlog-alert';
import { checkRecoveryHeartbeat } from '@/lib/recovery-heartbeat-alert';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: Request) {
  const unauthorized = validateCronRequest(request, 'library_cleanup');
  if (unauthorized) return unauthorized;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
  });
  try {
    // The 24-hour promise is watched first, so this run's own length or failure cannot skip the alert. The same goes for the
    // every-minute recovery job's heartbeat, which is watched from here because a stopped job cannot report itself.
    await Promise.all([checkLibraryBacklog(client), checkRecoveryHeartbeat(client)]);
    // Chat photos of deleted conversations (Owner 2026-11-13: kept with their messages, deleted with the conversation): the backstop
    // of the deletion. It never throws, so it runs next to the library cleanup and a failure of either still lets the other finish.
    const [result, photos] = await Promise.all([runLibraryCleanup(client), cleanOrphanPhotos(client)]);
    // Cursor is operational metadata, not returned to HTTP clients.
    const success = result.failed === 0 && result.unknownPaths === 0 && result.storageGuard === true && photos.failed === 0;
    return NextResponse.json({ success, checked: result.checked, released: result.released, pending: result.pending,
      photosRemoved: photos.removed }, { status: success ? 200 : 500 });
  } catch { return NextResponse.json({ error: 'Library cleanup failed' }, { status: 500 }); } finally { await flushAlerts(); }
}
