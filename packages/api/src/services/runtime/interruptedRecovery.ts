/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { z } from 'zod';
import type { BillingRpc } from '../bill2/service';
import { logger } from '../../lib/logger';
import type { RuntimeBudget } from './budget';
import type { AutomaticRecoverySummary } from './automaticRecovery';

const itemsSchema = z.array(z.object({
  executionId: z.string().uuid(), actorId: z.string().uuid(), runId: z.string().uuid(), epoch: z.number().int().positive(),
})).max(20);

/** SQL owns timeout, known-cost and Session checks, including a fresh locked check before releasing the original owner.
 * This host has no SDK, provider transport, credential or direct-table authority. */
export async function recoverInterruptedExecutions(input: {
  database: BillingRpc; budget: RuntimeBudget; actorId?: string;
  /** Time reserved per request; an admission repair (repairActorRounds) works in smaller steps. */
  stepMs?: number;
}): Promise<AutomaticRecoverySummary> {
  const summary = { selected: 0, processed: 0, settled: 0, pending: 0, failed: 0 };
  const step = input.stepMs ?? 2_000;
  try { input.budget.assertCanStart(step); } catch { return summary; }
  try {
    const response = await input.database.rpc('runtime_interrupted_recovery', {
      p_actor_id: input.actorId ?? null, p_limit: 20,
    });
    if (response.error) throw new Error('RUNTIME_INTERRUPTED_INVENTORY_FAILED');
    const items = itemsSchema.parse(response.data);
    if (input.actorId && items.some(item => item.actorId !== input.actorId))
      throw new Error('RUNTIME_RECOVERY_ACTOR_DENIED');
    summary.selected = items.length;
    for (const item of items) {
      try { input.budget.assertCanStart(step); } catch { summary.pending += items.length - summary.processed - summary.failed; break; }
      try {
        const ended = await input.database.rpc('runtime_interrupted_recovery', {
          p_actor_id: item.actorId, p_execution_id: item.executionId, p_epoch: item.epoch,
        });
        if (ended.error) throw new Error('RUNTIME_INTERRUPTED_FINISH_FAILED');
        const result = z.object({ state: z.enum(['completed', 'cancelled', 'cost_pending', 'skipped', 'released']) }).parse(ended.data);
        summary.processed++;
        if (['cost_pending', 'skipped', 'released'].includes(result.state)) summary.pending++;
        else summary.settled++;
        logger.info('api', 'runtime_interrupted_recovery', {
          executionId: item.executionId, runId: item.runId, epoch: item.epoch, state: result.state,
        });
      } catch {
        summary.failed++;
        logger.error('api', 'runtime_interrupted_recovery_failed', { executionId: item.executionId });
      }
    }
  } catch {
    summary.failed++;
    logger.error('api', 'runtime_interrupted_inventory_failed');
  }
  return summary;
}
