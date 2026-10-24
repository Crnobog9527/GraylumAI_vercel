/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { BillingRpc } from '../bill2/service';
import { logger } from '../../lib/logger';
import type { RuntimeBudget } from './budget';
import type { AutomaticRecoverySummary } from './automaticRecovery';

export const OWNER_LOST_WINDOW_MS = 24 * 3600 * 1000;
export const OWNER_LOST_BATCH_SIZE = 20;
const STEP_MS = 2_000;

const report = z.object({ rounds: z.array(z.object({
  executionId: z.string().uuid(), actorId: z.string().uuid(), runId: z.string().uuid(),
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
export async function recoverOwnerLostReplies(input: { database: BillingRpc; budget: RuntimeBudget; now?: number }):
  Promise<AutomaticRecoverySummary> {
  const summary = { selected: 0, processed: 0, settled: 0, pending: 0, failed: 0 };
  try { input.budget.assertCanStart(STEP_MS); } catch { return summary; }
  const now = input.now ?? Date.now();
  try {
    // A cutoff of now: the report's own lease and in-flight checks decide whether the owner is gone.
    const response = await input.database.rpc('runtime_stale_charged_rounds', { p_cutoff: new Date(now).toISOString(),
      p_limit: 100, p_created_since: new Date(now - OWNER_LOST_WINDOW_MS).toISOString() });
    if (response.error) throw new Error('RUNTIME_OWNER_LOST_INVENTORY_FAILED');
    const items = report.parse(response.data).rounds.filter(round => round.evidence.savedReplyChars > 0
      && ['running', 'interrupted'].includes(round.evidence.executionState)).slice(0, OWNER_LOST_BATCH_SIZE);
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
