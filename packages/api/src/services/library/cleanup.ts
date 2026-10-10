/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { libraryRpc } from './rpc';
import { canonicalPath } from './content';
import { libraryStorage, type LibraryStorage } from './storage';
import { startScheduledJobRun, finishScheduledJobRun } from '../scheduledJobRuns';

type Reservation = {
  actor_id: string; document_id: string; original_path: string; text_path: string | null;
  cleanup: boolean; closed: boolean; status: string; original_guard_until: string; text_guard_until: string | null;
};
export async function cleanupLibrary(client: SupabaseClient, options: {
  actorId?: string; documentId?: string; limit?: number; storage?: LibraryStorage; budgetMs?: number;
} = {}) {
  const storage = options.storage ?? libraryStorage(client);
  const started = Date.now();
  const rows = await libraryRpc<Reservation[]>(client, 'library_cleanup_candidates', {
    a: options.actorId ?? null, n: options.limit ?? 50, did: options.documentId ?? null,
  });
  let checked = 0; let released = 0; let failed = 0;
  for (const row of rows) {
    if (Date.now() - started > (options.budgetMs ?? 35_000)) break;
    checked++;
    try {
      await libraryRpc(client, 'library_cleanup_touch', { a: row.actor_id, did: row.document_id });
      const expired = Date.now() > Math.max(Date.parse(row.original_guard_until),
        row.text_guard_until ? Date.parse(row.text_guard_until) : 0);
      if (row.closed || row.status === 'uploading' && expired) {
        await libraryRpc(client, 'library_delete', { a: row.actor_id, did: row.document_id, closed: true });
        row.cleanup = true;
      }
      let absent = false;
      if (row.cleanup) {
        absent = true;
        for (const path of [row.original_path, row.text_path].filter((p): p is string => p !== null)) {
          // Read before retrying a durable deletion; after an uncertain outcome the next sweep does the same.
          if (!await storage.absent(path)) await storage.remove(path);
          absent = await storage.absent(path) && absent;
        }
      }
      if (await libraryRpc<boolean>(client, 'library_cleanup_observe', {
        a: row.actor_id, did: row.document_id, absent,
      })) released++;
    } catch { failed++; }
  }
  const backlog = await libraryRpc<{ pending: number; overdue: number; oldestDeletedAt: string | null }>(
    client, 'library_cleanup_backlog', { a: options.actorId ?? null },
  );
  return { checked, released, failed, ...backlog, budgetExhausted: checked < rows.length };
}

export async function runLibraryCleanup(client: SupabaseClient) {
  const started = Date.now();
  const runId = await startScheduledJobRun({ supabase: client, jobKey: 'library_cleanup', triggerSource: 'cron' });
  try {
    const result = await cleanupLibrary(client);
    // Persist only the storage continuation, never signed URLs, names or content.
    const previous = await client.from('scheduled_job_runs').select('summary').eq('job_key', 'library_cleanup')
      .neq('id', runId).not('finished_at', 'is', null).order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (previous.error) throw new Error('LIBRARY_UNAVAILABLE');
    const cursor = previous.data?.summary?.scanCursor;
    const storage = libraryStorage(client);
    const page = await storage.scan('', typeof cursor === 'string' ? cursor : undefined);
    let orphans = 0; let unknownPaths = 0;
    let scanned = 0;
    for (const path of page.paths) {
      if (Date.now() - started > 45_000) break;
      scanned++;
      if (!canonicalPath(path)) { unknownPaths++; continue; }
      const claimed = await libraryRpc<boolean>(client, 'library_path_claimed', { path });
      if (!claimed) {
        if (!await storage.absent(path)) await storage.remove(path);
        if (!await storage.absent(path)) throw new Error('LIBRARY_STORAGE_UNAVAILABLE');
        orphans++;
      }
    }
    const summary = { ...result, orphans, unknownPaths, scanCursor: scanned === page.paths.length ? page.cursor : (cursor ?? null) };
    await finishScheduledJobRun({ supabase: client, runId, status: result.failed || unknownPaths ? 'error' : 'success', summary });
    return summary;
  } catch {
    await finishScheduledJobRun({ supabase: client, runId, status: 'error', error: 'LIBRARY_CLEANUP_FAILED' });
    throw new Error('LIBRARY_CLEANUP_FAILED');
  }
}
