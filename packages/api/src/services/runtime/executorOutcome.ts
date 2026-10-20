/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Early executor results for an execution that is already cancelled or asked to cancel (moved out of execute.ts). */

/** Reasons a finished (cancelled) round reports to the client; each one says "not charged" or explains the stop. */
const REPORTED_REASONS = ['provider_history', 'preflight', 'platform_review', 'positioning_required'];

export function cancelledOutcome(unavailableReason: string | null | undefined) {
  return { state: 'cancelled' as const,
    ...(REPORTED_REASONS.includes(unavailableReason ?? '') ? { unavailable: unavailableReason } : {}) };
}

type Rpc = <T>(name: string, value: Record<string, unknown>) => Promise<T>;
/** A cancel was requested: settle the known receipts once and return the saved output, never redispatch. */
export async function finishCancelRequested(billing: { recoverReceipts(runId: string): Promise<unknown> }, rpc: Rpc,
  args: { p_execution_id: string }, execution: { runId: string; result?: { body: string; summary?: string } | null }) {
  await billing.recoverReceipts(execution.runId);
  const recovered = await rpc<{ state: string }>('runtime_financial_recovery', { ...args, p_finish: true });
  return { state: recovered.state as 'completed' | 'cancelled' | 'cost_pending',
    ...(execution.result ? { body: execution.result.body,
      ...(execution.result.summary !== undefined ? { summary: execution.result.summary } : {}) } : {}) };
}

/** A blocked or refused round cancels (settling known charges once). A cancellation failure propagates: it is never
 * rewritten as pending or retried here. */
export async function cancelRound(rpc: Rpc, args: { p_execution_id: string }) {
  const stopped = await rpc<{ state: 'cancelled' | 'cost_pending' }>('runtime_cancel', args);
  return { state: stopped.state };
}

/** An exhausted replay has no authority to send any missing response. Only a definite
 * missing/incompatible result is a platform failure; database/Auth/capacity faults remain recoverable.
 * SQL still verifies the owner epoch, original run, known costs and existing cancellation/erasure fences. */
export async function finishExhaustedReplay(rpc: Rpc, args: { p_execution_id: string },
  execution: { live: boolean; remainingCalls?: number; state: string }, code: string) {
  if (execution.live || execution.remainingCalls !== 0 || !['running', 'interrupted'].includes(execution.state)
    || !['RUNTIME_RESPONSE_PENDING', 'RUNTIME_RESPONSE_CONFLICT', 'RUNTIME_RESPONSE_INVALID',
      'RUNTIME_TERMINAL_REPLY', 'RUNTIME_CALL_LIMIT_REACHED'].includes(code)) return undefined;
  try {
    const result = await rpc<{ state: string }>('runtime_execution', {
      ...args, p_action: 'fail_platform', p_result: { unavailable_reason: 'preflight' },
    });
    if (result.state === 'cancelled') return { state: 'cancelled' as const, unavailable: 'preflight' as const };
    if (result.state === 'cost_pending') return { state: 'cost_pending' as const };
  } catch { /* Never fall through to ordinary cancellation and lose the pending compensation. */ }
  return { state: 'pending' as const };
}
