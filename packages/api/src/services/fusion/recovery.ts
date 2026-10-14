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
type Summary = { success: boolean; scanned: number; cancelled: number; recovered: number; scrubbed: number; failed: number;
  /** Left for the next run when the time limit was reached. */
  deferred: number };
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
  budget?: RuntimeBudget; now?: () => number; timeLimitMs?: number } = {}): Promise<Summary> {
  const summary: Summary = { success: true, scanned: 0, cancelled: 0, recovered: 0, scrubbed: 0, failed: 0, deferred: 0 };
  const now = options.now ?? Date.now;
  const limit = options.limit ?? 50;
  // The cron route has 60 seconds in total and runs other reconciliations alongside (#954 review).
  const stopAt = now() + (options.timeLimitMs ?? 40_000);
  // Listing is cheap: collect the pages first. Pages advance past calls that cannot progress yet (0235).
  const rows: Array<z.infer<typeof row>> = [];
  let cursor: { p_after_created: string; p_after_id: string } | undefined;
  // Keep paging to the end (bounded by the time limit and a safety cap), so expired undispatched calls
  // behind a long backlog of slow dispatched ones are still collected and released first (#954 review).
  for (let page = 0; page < (options.pages ?? 200) && now() < stopAt; page++) {
    const listed = await admin.rpc('fusion_pending_financial_batch', { p_limit: limit, ...cursor });
    const parsed = listed.error ? undefined : z.array(row).safeParse(listed.data);
    if (!parsed?.success) return { ...summary, success: false };
    rows.push(...parsed.data);
    if (parsed.data.length < limit) break;
    const last = parsed.data[parsed.data.length - 1]!;
    cursor = { p_after_created: last.created_at, p_after_id: last.call_id };
  }
  // Releasing holds of calls never dispatched is quick and must not wait behind slow receipt lookups.
  const ordered = [...rows.filter(item => !item.dispatched), ...rows.filter(item => item.dispatched)];
  await recoverPage(admin, ordered, summary, now, stopAt, options.budget);
  // After the financial wrap-up: reviews still in progress with every call settled and no movement for an
  // hour become paused (not an end state; 0236). Ended reviews are never touched.
  // Bounded like every other step: skipped when the deadline is near, and given at most 5 seconds.
  if (now() + 5_000 <= stopAt) {
    const paused = await admin.rpc('fusion_review_pause_idle', { p_idle: '1 hour' })
      .abortSignal(AbortSignal.timeout(Math.min(5_000, stopAt - now())));
    if (paused.error) summary.success = false;
  }
  return summary;
}

async function recoverPage(admin: SupabaseClient, rows: Array<z.infer<typeof row>>, summary: Summary, now: () => number,
  stopAt: number, shared?: RuntimeBudget) {
  for (const [index, item] of rows.entries()) {
    // Keep 5 seconds for the slowest single step (one lookup, settle and scrub), plus a separate 5-second
    // window for the idle-pause step that follows, so a lasting backlog never crowds it out.
    if (now() + 10_000 > stopAt) { summary.deferred += rows.length - index; break; }
    summary.scanned++;
    // Every RPC and lookup of this row is bounded by the step's own deadline, not a fresh 285 s (#954 review).
    const budget = shared ?? createRuntimeBudget(now, Math.max(1, stopAt - now()));
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
