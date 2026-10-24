/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { BillingRpc } from '../bill2/service';
import { logger } from '../../lib/logger';
import type { RuntimeBudget } from './budget';
import type { AutomaticRecoverySummary } from './automaticRecovery';

export const OWNER_LOST_WINDOW_MS = 24 * 3600 * 1000;
export const OWNER_LOST_BATCH_SIZE = 20;
export const OWNER_LOST_PAGE_SIZE = 100;
/** Report pages read per run: up to 500 open charged rounds from the last 24 hours. */
export const OWNER_LOST_MAX_PAGES = 5;
const STEP_MS = 2_000;

const report = z.object({ rounds: z.array(z.object({
  executionId: z.string().uuid(), actorId: z.string().uuid(), runId: z.string().uuid(), since: z.string(),
  evidence: z.object({ executionState: z.string(), savedReplyChars: z.number().int().nonnegative() }).passthrough(),
}).passthrough()).max(500) }).passthrough();
const read = z.object({ state: z.string() }).passthrough();

/**
 * A charged PAYG round whose request died after the reply was saved (staging 2026-10-24: the organizer's
 * billing claim timed out, the error path's database read timed out too, and the round stayed running with
 * the reply paid for, hidden, and every new message refused). Once the owner's dispatch lease has expired,
 * runtime_execution `read` already turns such a round into a resumable wait: the saved reply is shown and
 * the next message or "继续" finishes it. Until now only the user's own retry made that read.
 *
 * This scheduled step makes the same read for rounds that the stale-round report lists as open, charged,
 * unpaused and quiet, still running or interrupted, and holding a saved reply. SQL keeps every condition
 * (expired lease, no call in flight, actor, scope, erasure). Rounds without a saved reply are untouched:
 * interruption release and the 24-hour refund (staleChargedRounds.ts) still own them.
 */
export async function recoverOwnerLostReplies(input: { database: BillingRpc; budget: RuntimeBudget; now?: number;
  random?: () => number }):
  Promise<AutomaticRecoverySummary> {
  const summary = { selected: 0, processed: 0, settled: 0, pending: 0, failed: 0 };
  try { input.budget.assertCanStart(STEP_MS); } catch { return summary; }
  const now = input.now ?? Date.now();
  try {
    // A cutoff of now: the report's own lease and in-flight checks decide whether the owner is gone.
    // The report is ordered by creation time; pages advance by it, so rounds without a saved reply cannot fill the view.
    const eligible = new Map<string, z.infer<typeof report>['rounds'][number]>();
    let since = new Date(now - OWNER_LOST_WINDOW_MS).toISOString();
    for (let page = 0; page < OWNER_LOST_MAX_PAGES; page++) {
      if (page > 0) { try { input.budget.assertCanStart(STEP_MS); } catch { break; } }
      const response = await input.database.rpc('runtime_stale_charged_rounds', { p_cutoff: new Date(now).toISOString(),
        p_limit: OWNER_LOST_PAGE_SIZE, p_created_since: since });
      if (response.error) throw new Error('RUNTIME_OWNER_LOST_INVENTORY_FAILED');
      const { rounds } = report.parse(response.data);
      for (const round of rounds) if (round.evidence.savedReplyChars > 0
        && ['running', 'interrupted'].includes(round.evidence.executionState)) eligible.set(round.executionId, round);
      const last = rounds.at(-1)?.since;
      // The next page starts at the last creation time (inclusive; repeats are deduplicated by execution).
      if (rounds.length < OWNER_LOST_PAGE_SIZE || !last || last === since) break;
      since = last;
    }
    // A random batch: rounds whose read keeps being refused cannot hold the same slots every run.
    const random = input.random ?? Math.random;
    const items = [...eligible.values()].map(item => ({ item, key: random() })).sort((a, b) => a.key - b.key)
      .slice(0, OWNER_LOST_BATCH_SIZE).map(({ item }) => item);
    summary.selected = items.length;
    for (const item of items) {
      try { input.budget.assertCanStart(STEP_MS); } catch { summary.pending += items.length - summary.processed - summary.failed; break; }
      try {
        const result = await input.database.rpc('runtime_execution', {
          p_actor_id: item.actorId, p_execution_id: item.executionId, p_action: 'read',
        });
        if (result.error) throw new Error('RUNTIME_OWNER_LOST_READ_FAILED');
        const { state } = read.parse(result.data);
        summary.processed++;
        summary.pending++; // A resumable wait is not settled: the user's next request finishes it.
        logger.info('api', 'runtime_owner_lost_recovery', { executionId: item.executionId, runId: item.runId, state });
      } catch {
        // A refused read (an expired test window, a revoked scope) leaves the round to the 24-hour refund,
        // so it stays pending rather than failing every later scheduled run.
        summary.pending++;
        logger.warn('api', 'runtime_owner_lost_recovery_failed', { executionId: item.executionId, runId: item.runId });
      }
    }
  } catch {
    summary.failed++;
    logger.error('api', 'runtime_owner_lost_inventory_failed');
  }
  return summary;
}
