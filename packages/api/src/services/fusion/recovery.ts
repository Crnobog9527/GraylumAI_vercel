/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authoritativeBilling, type BillingRpc, type BillingTransport } from '../bill2/service';
import { createRuntimeBudget, type RuntimeBudget } from '../runtime/budget';
import { parseStagingPolicy } from '../runtime/stagingPolicy';
import { stagingTransport } from '../runtime/stagingTransport';
import { logger } from '../../lib/logger';

const row = z.object({ actor_id: z.string().uuid(), run_id: z.string().uuid(), call_id: z.string().uuid(),
  dispatched: z.boolean(), dispatch_deadline: z.string().nullable(), recovery: z.unknown().nullable(), created_at: z.string() });
type Summary = { success: boolean; scanned: number; cancelled: number; recovered: number; scrubbed: number; failed: number };
const noTransport: BillingTransport = {
  dispatch: async () => { throw new Error('FUSION_RECOVERY_NO_DISPATCH'); },
  lookup: async () => { throw new Error('FUSION_RECOVERY_LOOKUP_UNAVAILABLE'); },
};

/** Daily reconciliation step for sessionless Fusion calls (FUSION-REVIEW §2.1): a call never dispatched
 * by its dispatch deadline is cancelled (hold released, no charge); a dispatched one gets the existing
 * receipt lookup with its original binding and then settles (verdict rules of 0234/0235 apply, including
 * the recovery deadline). A run whose content was deleted is scrubbed again once it settled, since a
 * deletion can happen while its call is still open (#947 review). Runs one call at a time; failures stay listed. */
export async function recoverFusionFinancials(admin: SupabaseClient, options: { limit?: number; pages?: number;
  budget?: RuntimeBudget; now?: () => number } = {}): Promise<Summary> {
  const summary: Summary = { success: true, scanned: 0, cancelled: 0, recovered: 0, scrubbed: 0, failed: 0 };
  const now = options.now ?? Date.now;
  const limit = options.limit ?? 50;
  // Pages advance past calls that cannot progress yet, so they never hold back newer ones (0235).
  let cursor: { p_after_created: string; p_after_id: string } | undefined;
  for (let page = 0; page < (options.pages ?? 10); page++) {
    const listed = await admin.rpc('fusion_pending_financial_batch', { p_limit: limit, ...cursor });
    const parsed = listed.error ? undefined : z.array(row).safeParse(listed.data);
    if (!parsed?.success) return { ...summary, success: false };
    await recoverPage(admin, parsed.data, summary, now, options.budget);
    if (parsed.data.length < limit) break;
    const last = parsed.data[parsed.data.length - 1]!;
    cursor = { p_after_created: last.created_at, p_after_id: last.call_id };
  }
  return summary;
}

async function recoverPage(admin: SupabaseClient, rows: Array<z.infer<typeof row>>, summary: Summary, now: () => number,
  shared?: RuntimeBudget) {
  for (const item of rows) {
    summary.scanned++;
    const budget = shared ?? createRuntimeBudget();
    try {
      if (!item.dispatched && (!item.dispatch_deadline || Date.parse(item.dispatch_deadline) > now())) continue;
      const adapter = item.recovery ? stagingTransport(admin, parseStagingPolicy(item.recovery), budget) : noTransport;
      const billing = authoritativeBilling({ admin: admin as unknown as BillingRpc, actor: async () => item.actor_id, adapter, budget });
      if (item.dispatched) {
        if (item.recovery) await billing.recoverReceipts(item.run_id, { timeoutMs: 2000, callId: item.call_id });
        summary.recovered++;
      } else {
        await billing.requestCancel(item.run_id);
        summary.cancelled++;
      }
      const state = await billing.finalizeRun(item.run_id);
      if (state.contentDeleted && ['settled', 'refunded'].includes(state.state)) {
        for (const name of ['account_erasure_scrub_calls', 'account_erasure_scrub_run'] as const) {
          const scrub = await admin.rpc(name, { p_profile_id: item.actor_id, p_run_id: item.run_id });
          if (scrub.error) throw new Error('FUSION_RECOVERY_SCRUB_FAILED');
        }
        const receipts = await admin.rpc('account_erasure_scrub_receipts', { p_profile_id: item.actor_id, p_run_id: item.run_id, p_limit: 100 });
        if (receipts.error) throw new Error('FUSION_RECOVERY_SCRUB_FAILED');
        summary.scrubbed++;
      }
    } catch (error) {
      summary.failed++;
      summary.success = false;
      logger.warn('billing', 'fusion_financial_recovery_pending', { code: error instanceof Error ? error.message : 'unknown' });
    }
  }
}
