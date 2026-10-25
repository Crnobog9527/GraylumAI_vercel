/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { finishScheduledJobRun, startScheduledJobRun } from '../scheduledJobRuns';

/**
 * ARCH-FIX G2 (Owner 2026-10-25: raw output 30 days, billing fields 3 years). Daily, inside billing-reconcile:
 * receipts older than 30 days on finished runs lose only their raw provider output (0390). Billing fields,
 * hashes and ids stay. Each batch is one short transaction; whatever is left is picked up the next day.
 */
export const RECEIPT_RETENTION_JOB_KEY = 'receipt_raw_retention';
export const RECEIPT_RETENTION_BATCH = 200;
const batch = z.object({ scrubbed: z.number().int().nonnegative(), more: z.boolean() }).strict();
export type ReceiptRetentionResult = { success: boolean; scrubbed: number; batches: number; complete: boolean };

export async function scrubExpiredReceiptOutput(supabase: SupabaseClient,
  options: { timeLimitMs?: number; now?: () => number } = {}): Promise<ReceiptRetentionResult> {
  const now = options.now ?? Date.now, deadline = now() + (options.timeLimitMs ?? 20_000);
  const runId = await startScheduledJobRun({ supabase, jobKey: RECEIPT_RETENTION_JOB_KEY, triggerSource: 'cron' });
  let scrubbed = 0, batches = 0, complete = false, failure: string | null = null;
  try {
    while (now() < deadline) {
      const response = await supabase.rpc('bill2_receipts_scrub_raw', { p_limit: RECEIPT_RETENTION_BATCH });
      const parsed = batch.safeParse(response.data);
      if (response.error || !parsed.success) { failure = 'RECEIPT_RETENTION_FAILED'; break; }
      scrubbed += parsed.data.scrubbed; batches++;
      if (!parsed.data.more) { complete = true; break; }
    }
  } catch { failure = 'RECEIPT_RETENTION_FAILED'; }
  // A backlog left for tomorrow is not a failure; an RPC error is.
  await finishScheduledJobRun({ supabase, runId, status: failure ? 'error' : 'success',
    summary: { scrubbed, batches, complete }, error: failure });
  return { success: !failure, scrubbed, batches, complete };
}
