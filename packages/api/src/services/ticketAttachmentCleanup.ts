/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TICKET_ATTACHMENT_BUCKET } from '../lib/ticketAttachments';
import { finishScheduledJobRun, startScheduledJobRun } from './scheduledJobRuns';

const BATCH = 100;
const MAX_BATCHES = 5;

/**
 * Removes ticket attachments older than 24 hours that no ticket or reply refers to (ticket_attachment_orphans).
 * Deletion goes through the Storage API only. Object names are never persisted or returned, only counts.
 */
export async function runTicketAttachmentCleanup(client: SupabaseClient, budgetMs = 40_000) {
  const started = Date.now();
  const runId = await startScheduledJobRun({ supabase: client, jobKey: 'ticket_attachments_cleanup', triggerSource: 'cron' });
  let removed = 0;
  let failed = 0;
  let more = false;
  try {
    for (let batch = 0; batch < MAX_BATCHES && Date.now() - started < budgetMs; batch++) {
      const orphans = await client.rpc('ticket_attachment_orphans', { p_limit: BATCH });
      if (orphans.error || !Array.isArray(orphans.data)) throw new Error('TICKET_ORPHANS_UNAVAILABLE');
      const names = orphans.data.filter((name): name is string => typeof name === 'string');
      if (names.length === 0) break;
      const result = await client.storage.from(TICKET_ATTACHMENT_BUCKET).remove(names);
      const count = result.error || !Array.isArray(result.data) ? 0 : result.data.length;
      removed += count;
      failed += names.length - count;
      more = names.length === BATCH;
      // A batch that removed nothing would return the same names again; stop until the next run.
      if (count === 0 || !more) break;
    }
    const summary = { removed, failed, more };
    await finishScheduledJobRun({ supabase: client, runId, status: failed ? 'error' : 'success', summary });
    return summary;
  } catch {
    await finishScheduledJobRun({ supabase: client, runId, status: 'error', summary: { removed, failed },
      error: 'TICKET_ATTACHMENTS_CLEANUP_FAILED' });
    throw new Error('TICKET_ATTACHMENTS_CLEANUP_FAILED');
  }
}
