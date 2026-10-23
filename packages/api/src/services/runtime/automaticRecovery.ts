/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import {stoppedCompletion} from './stoppedCompletion';
import {denyNewCalls} from './newWorkGate';
import { z } from 'zod';
import { authoritativeBilling, type BillingRpc, type BillingTransport } from '../bill2/service';
import { boundedFinancialDatabase, erasureFinancialBudget } from '../accountErasure/financialRecovery';
import type { RuntimeBudget } from './budget';
import { stagingTransport } from './stagingTransport';
import type { StagingPolicy } from './stagingPolicy';
import { autoCompensateStaleRounds, type StaleRoundAutoClose } from './staleChargedRounds';
import { recoverInterruptedExecutions } from './interruptedRecovery';
import { logger } from '../../lib/logger';

export const AUTOMATIC_RECOVERY_LOOKUP_MS = 2_000;
export const ADMISSION_RECOVERY_MS = 8_000;
// 45s so stop-loss delivery (bounded to ~12s in the cron route) fits in the 60s route limit.
export const CRON_RECOVERY_MS = 45_000;
export const RECOVERY_BATCH_SIZE = 20;
/** Time reserved for one stale-round refund (one report read or one compensation transaction). */
export const STALE_ROUND_STEP_MS = 2_000;
const inventorySchema = z.array(z.object({
  actorId: z.string().uuid(), executionId: z.string().uuid(), runId: z.string().uuid(),
  recoveryPolicy: z.unknown(), finishAllowed: z.boolean(), userStop: z.boolean().optional(),
})).max(RECOVERY_BATCH_SIZE);
export type AutomaticRecoverySummary = {
  selected: number; processed: number; settled: number; pending: number; failed: number;
};

/** Only service-owned inventory supplies identities. A failed lookup preserves its
 * original hold. Every mutation still passes the existing SQL claim and ledger. */
export async function recoverPendingFinancials(input: {
  database: BillingRpc; budget: RuntimeBudget; actorId?: string;
  adapter: (policy: unknown) => BillingTransport;
}): Promise<AutomaticRecoverySummary> {
  const summary: AutomaticRecoverySummary = { selected: 0, processed: 0, settled: 0, pending: 0, failed: 0 };
  try {
    const response = await input.database.rpc('runtime_pending_financial_batch', {
      p_actor_id: input.actorId ?? null, p_limit: RECOVERY_BATCH_SIZE,
    });
    if (response.error) throw new Error('RUNTIME_RECOVERY_INVENTORY_FAILED');
    const items = inventorySchema.parse(response.data);
    if (input.actorId && items.some(item => item.actorId !== input.actorId))
      throw new Error('RUNTIME_RECOVERY_ACTOR_DENIED');
    summary.selected = items.length;
    for (const item of items) {
      try { input.budget.assertCanStart(AUTOMATIC_RECOVERY_LOOKUP_MS); } catch { break; }
      try {
        const transport = input.adapter(item.recoveryPolicy);
        const adapter: BillingTransport = {
          dispatch: async () => { throw new Error('RUNTIME_DISPATCH_DISABLED'); },
          lookup: (...args) => transport.lookup(...args),
        };
        const billing = authoritativeBilling({ admin: input.database, actor: async () => item.actorId,
          budget: input.budget, adapter });
        if (!item.userStop) await billing.recoverReceipts(item.runId, { timeoutMs: AUTOMATIC_RECOVERY_LOOKUP_MS });
        // Unknown calls can belong to an interrupted or still-live execution.
        // Query their existing generation safely without cancelling ongoing work.
        let state = 'cost_pending';
        if (item.userStop) {
          const result = await stoppedCompletion({database:input.database, actor:async()=>item.actorId,
            budget:input.budget, callGate:denyNewCalls, adapter}, billing, AUTOMATIC_RECOVERY_LOOKUP_MS)(item.executionId);
          state = result?.state ?? 'cost_pending';
        } else if (item.finishAllowed) {
          const finished = await input.database.rpc('runtime_financial_recovery', {
            p_actor_id: item.actorId, p_execution_id: item.executionId, p_finish: true,
          });
          if (finished.error) throw new Error('RUNTIME_RECOVERY_FINISH_FAILED');
          state = (finished.data as { state: string }).state;
        }
        summary.processed++;
        if (state === 'completed' || state === 'cancelled') summary.settled++;
        else summary.pending++;
        logger.info('api', 'runtime_financial_recovery_result', {
          executionId: item.executionId, runId: item.runId, userStop: Boolean(item.userStop), state,
        });
      } catch {
        summary.failed++;
        logger.error('api', 'runtime_financial_recovery_failed', { executionId: item.executionId, runId: item.runId });
      }
    }
  } catch { summary.failed++; }
  return summary;
}

/** Frozen provider/account/model bindings authorize GET recovery in either
 * deployment. No current test-window setting grants new generation authority.
 * The scheduled job (no actor) then closes rounds still open and quiet after 24 hours and refunds
 * them by the daily reconciliation's rule (Owner 2026-10-12 supplement); a user's admission never does.
 * Recovery runs first: a call it settles counts as activity, so that round waits another 24 hours. */
export async function runAutomaticFinancialRecovery(admin: SupabaseClient, actorId?: string):
  Promise<AutomaticRecoverySummary & { staleRounds?: StaleRoundAutoClose }> {
  const budget = erasureFinancialBudget(actorId ? ADMISSION_RECOVERY_MS : CRON_RECOVERY_MS);
  const database = boundedFinancialDatabase(admin, budget);
  const summary = await recoverPendingFinancials({ database, budget, actorId,
    adapter: policy => stagingTransport(admin, policy as StagingPolicy, budget),
  });
  const interrupted = await recoverInterruptedExecutions({ database, budget, actorId });
  for (const key of ['selected', 'processed', 'settled', 'pending', 'failed'] as const) summary[key] += interrupted[key];
  logger.info('api', 'runtime_automatic_recovery', { ...summary, interrupted, actorScoped: Boolean(actorId) });
  if (actorId) return summary;
  const canStart = () => { try { budget.assertCanStart(STALE_ROUND_STEP_MS); return true; } catch { return false; } };
  // No time left even to read the report: not knowing is a failure, so a recovery backlog cannot starve refunds silently.
  return { ...summary, staleRounds: canStart() ? await autoCompensateStaleRounds(database, { canStart })
    : { found: 0, compensated: 0, alreadyCompensated: 0, skipped: 0, failed: 1, credits: 0, manualReview: 0, deferred: 0 } };
}
