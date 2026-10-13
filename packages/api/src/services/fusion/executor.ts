/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { authoritativeBilling } from '../bill2/service';
import type { TransportObservation } from '../bill2/fixtureAdapter';
import { OPENROUTER_RESPONSE_TIMEOUT_MS } from '../bill2/openRouterPolicy';
import { openRouterStream } from '../bill2/openRouterStream';
import { decodeOpenRouterStreamObservation } from '../bill2/openRouterEvidence';
import type { RuntimeBudget } from '../runtime/budget';
import { requireNewWork, type RuntimeCallGate } from '../runtime/newWorkGate';
import type { AdmittedFusionRun } from './admission';

type Billing = ReturnType<typeof authoritativeBilling>;
/** Host verdicts written after the body is saved (0234/0235). no_delivery is the host's for a confirmed failure. */
export type FusionBodyVerdict = 'usable' | 'format_invalid' | 'revision_invalid';
export type FusionClaimedCall = { runId: string; id: string; state: string; fresh: boolean };
export type FusionCallOutcome =
  | { state: 'judged'; verdict: FusionBodyVerdict | 'no_delivery'; text?: string }
  | { state: 'pending'; reason: 'not_dispatched' | 'not_started' | 'receipt_pending' | 'response_unreadable' | 'closed' };

/** Text of a completed, streamed chat response; null when it cannot be read back exactly. */
export function fusionResponseText(observation: TransportObservation | undefined, model: string): string | null {
  if (!observation || !observation.complete || observation.httpStatus < 200 || observation.httpStatus >= 300) return null;
  let text: string;
  // The same bounded, hash-checked decoding the receipt projection uses.
  try { text = decodeOpenRouterStreamObservation(observation).toString('utf8'); } catch { return null; }
  const stream = openRouterStream(model);
  try { stream.push(text); } catch { return null; }
  const result = stream.result();
  const content = result.sdkResponse?.choices?.[0]?.message?.content;
  return !result.error && typeof content === 'string' && content.length ? content : null;
}

/** One Fusion call at a time: each call has its own request and 300-second deadline (FUSION-REVIEW §2.1).
 * Rate limit and time budget are checked before every claim and dispatch, as for ordinary calls. */
export function fusionExecutor(deps: { billing: Billing; admin: SupabaseClient; actorId: string;
  callGate: RuntimeCallGate; budget: RuntimeBudget }) {
  const { billing, admin, actorId } = deps;
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await admin.rpc(name, { p_actor_id: actorId, ...args });
    if (result.error) throw new Error(typeof result.error.message === 'string' && /^FUSION_[A-Z_]+$/.test(result.error.message)
      ? result.error.message : 'FUSION_DATABASE_UNAVAILABLE');
    return result.data as T;
  }
  /** Settle and close one run. Settlement waits for the verdict; the run closes once its one call settled. */
  async function settle(runId: string) {
    const state = await billing.finalizeRun(runId);
    if (!state.closed && ['settled', 'refunded'].includes(state.state)) await billing.requestCancel(runId);
    return billing.finalizeRun(runId);
  }
  return {
    /** Every call in the batch passes the call rate limit before any hold is taken. */
    async claim(groupId: string, stepKey: string, attempt: number, runs: AdmittedFusionRun[]) {
      requireNewWork(await deps.callGate(actorId, runs.length, 'bill2.v2'));
      return billing.claimFusionGroup(groupId, stepKey, attempt, runs.map(run => ({ runId: run.runId, payload: run.call })));
    },
    /** Dispatch, save, judge and settle one call. judge sees the exact saved text (PR-4 validates it). */
    async run(run: AdmittedFusionRun, claimed: FusionClaimedCall, judge: (text: string) => FusionBodyVerdict,
      onChunk?: (chunk: string) => void): Promise<FusionCallOutcome> {
      deps.budget.modelCallTimeout(OPENROUTER_RESPONSE_TIMEOUT_MS);
      // A replayed claim carries no token: rotate one for a call that was never dispatched.
      if (!claimed.fresh && !(await billing.rotatePrepared(run.runId, claimed.id, run.call))) {
        return { state: 'pending', reason: 'not_dispatched' };
      }
      const dispatch = await billing.dispatchOnce(claimed.id, run.body, onChunk);
      if (dispatch.transportNotStarted) return { state: 'pending', reason: 'not_started' };
      if (!dispatch.dispatched) return { state: 'pending', reason: 'not_dispatched' };
      if (dispatch.accountClosed || dispatch.contentDeleted) return { state: 'pending', reason: 'closed' };
      if (dispatch.pendingReceipt) {
        // Bounded once more; recovery looks the receipt up later. The call keeps its hold meanwhile.
        try { await billing.recordReceipt(dispatch.pendingReceipt.runId, dispatch.pendingReceipt.callId, dispatch.pendingReceipt.evidence); }
        catch { return { state: 'pending', reason: 'receipt_pending' }; }
      }
      if (dispatch.providerRejected) {
        await rpc('fusion_call_verdict', { p_call_id: claimed.id, p_verdict: 'no_delivery' });
        await settle(run.runId);
        return { state: 'judged', verdict: 'no_delivery' };
      }
      const text = fusionResponseText(dispatch.observation, run.call.model);
      // Unreadable or incomplete: no body is saved; recovery settles it at the deadline as no_delivery.
      if (!text) return { state: 'pending', reason: 'response_unreadable' };
      await rpc('fusion_call_output_save', { p_call_id: claimed.id, p_body: text });
      const verdict = judge(text);
      await rpc('fusion_call_verdict', { p_call_id: claimed.id, p_verdict: verdict });
      await settle(run.runId);
      return { state: 'judged', verdict, text };
    },
    /** User stop: cancel each run; undispatched calls are released, dispatched ones settle at known cost. */
    async stop(runIds: string[]) {
      for (const runId of runIds) { await billing.requestCancel(runId); await billing.finalizeRun(runId); }
    },
    readOutput: (callId: string) => rpc<{ callId: string; body: string; bodyHash: string; savedAt: string } | null>(
      'fusion_call_output_read', { p_call_id: callId }),
  };
}
