/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { logger } from '../../lib/logger';
import type { PaygPosition, PaygWait } from './paygRuntime';

type Rpc = <T>(name: string, value: Record<string, unknown>) => Promise<T>;

/**
 * A claim the database could not answer never dispatched. After an earlier call of this round the
 * round waits at this call (payg_wait also retires a claim that did commit), so the reply already
 * paid for is kept and shown instead of a server error (staging 2026-10-24).
 */
export function waitsOnClaimFailure(payg: boolean, sequence: number, error: unknown) {
  return payg && sequence > 1 && error instanceof Error && error.message === 'BILL2_DATABASE_UNAVAILABLE';
}

/** A database fault while checking for a user stop must not skip the failure cleanup that follows. */
export async function stopCheckOrNull<T>(executionId: string, check: () => Promise<T>) {
  try { return await check(); } catch {
    logger.warn('api', 'runtime_failure_stop_check_failed', { executionId });
    return null;
  }
}

/**
 * Records the wait. When the database cannot record it, the round is left interrupted for
 * recovery (ownerLostRecovery.ts) and the request answers pending: never a 500 that leaves
 * the round running.
 */
export async function recordPaygWait(rpc: Rpc, args: { p_execution_id: string }, waitPoint: Record<string, unknown>):
  Promise<PaygWait | { state: 'pending' }> {
  const saved = await rpc<PaygPosition & { state: PaygWait['state']; primaryResult?: { body: string } }>(
    'runtime_execution', { ...args, p_action: 'payg_wait', p_result: waitPoint }).catch(() => null);
  if (!saved) {
    logger.warn('api', 'runtime_payg_wait_failed', { executionId: args.p_execution_id });
    await rpc('runtime_execution', { ...args, p_action: 'interrupt' }).catch(() => undefined);
    return { state: 'pending' };
  }
  return { state: saved.state, code: saved.state === 'waiting_credits' ? 'RUNTIME_WAITING_CREDITS' : 'RUNTIME_WAITING_RESUME',
    executionId: args.p_execution_id, cursor: saved.cursor, epoch: saved.epoch, remainingCalls: saved.remainingCalls,
    ...(saved.primaryResult ? { body: saved.primaryResult.body } : {}) };
}
