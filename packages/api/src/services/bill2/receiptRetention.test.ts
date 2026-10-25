/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RECEIPT_RETENTION_BATCH, RECEIPT_RETENTION_JOB_KEY, scrubExpiredReceiptOutput } from './receiptRetention';

function client(batches: Array<{ data: unknown; error?: unknown }>) {
  const rpc = vi.fn(async () => { const next = batches.shift() ?? { data: { scrubbed: 0, more: false } }; return { data: next.data, error: next.error ?? null }; });
  const runs: Array<Record<string, unknown>> = [];
  const from = vi.fn(() => ({
    insert: (row: Record<string, unknown>) => { runs.push(row); return { select: () => ({ single: async () => ({ data: { id: 'run' }, error: null }) }) }; },
    update: (row: Record<string, unknown>) => { runs.push(row); return { eq: async () => ({ error: null }) }; },
  }));
  return { db: { rpc, from } as unknown as SupabaseClient, rpc, runs };
}

it('scrubs batches until the backlog is empty and records the run', async () => {
  const { db, rpc, runs } = client([{ data: { scrubbed: 200, more: true } }, { data: { scrubbed: 7, more: false } }]);
  expect(await scrubExpiredReceiptOutput(db)).toEqual({ success: true, scrubbed: 207, batches: 2, complete: true });
  expect(rpc).toHaveBeenCalledWith('bill2_receipts_scrub_raw', { p_limit: RECEIPT_RETENTION_BATCH });
  expect(runs[0]).toMatchObject({ job_key: RECEIPT_RETENTION_JOB_KEY, trigger_source: 'cron' });
  expect(runs[1]).toMatchObject({ status: 'success', summary: { scrubbed: 207, batches: 2, complete: true }, error: null });
});

it('stops at the time limit without failing; the rest waits for tomorrow', async () => {
  let t = 0;
  const { db, rpc } = client([{ data: { scrubbed: 200, more: true } }, { data: { scrubbed: 200, more: true } }]);
  const result = await scrubExpiredReceiptOutput(db, { timeLimitMs: 15, now: () => (t += 10) });
  expect(result).toEqual({ success: true, scrubbed: 200, batches: 1, complete: false });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it.each([[{ data: null, error: { message: 'private detail' } }], [{ data: { scrubbed: -1, more: false } }], [{ data: { scrubbed: 1, more: false, rawBody: 'x' } }]])(
  'reports a failed or malformed batch as a failed run %#', async response => {
    const { db, runs } = client([response]);
    expect(await scrubExpiredReceiptOutput(db)).toEqual({ success: false, scrubbed: 0, batches: 0, complete: false });
    expect(runs[1]).toMatchObject({ status: 'error', error: 'RECEIPT_RETENTION_FAILED' });
    expect(JSON.stringify(runs)).not.toContain('private detail');
  });
