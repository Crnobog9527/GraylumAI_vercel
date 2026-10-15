/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-3b: the BILL2 steps of one third-party search / social-data subcall on a PAYG v2 run (0255).
// claim (hold this call's bound) → dispatch (mark sent; only then may the supplier be contacted) → record (the one
// tool_result). A subcall that is never dispatched is never sent. A dispatched subcall whose result cannot be recorded
// stays without a receipt and settles as unknown at its recovery deadline (user 0, supplier cost pending).
import { z } from 'zod';
import { claimFailure } from './claimFailure';
import type { BillingRpc } from './service';
import type { ToolClaimPayload, toolResultEvidence } from './toolBilling';

const uuid = z.string().uuid();
const claimed = z.object({ id: uuid, state: z.string(), dispatchToken: z.string().uuid().nullable().optional() }).passthrough();

export type ToolClaim =
  | { state: 'claimed'; callId: string; token: string }
  | { state: 'waiting_credits' }
  /** The same sequence was claimed before (a replay): it must not be sent again from here. */
  | { state: 'replayed'; callId: string };

export interface ToolSubcallBilling {
  readonly runId: string;
  claim(sequence: number, payload: ToolClaimPayload): Promise<ToolClaim>;
  /** true only when this process may send the request now. */
  dispatch(callId: string, token: string): Promise<boolean>;
  record(callId: string, evidence: ReturnType<typeof toolResultEvidence>): Promise<{ accountClosed: boolean; contentDeleted: boolean }>;
}

/** Actor-bound RPC steps for tool subcalls of one run. The actor comes from the trusted runtime, never from the model. */
export function toolSubcallBilling(deps: { admin: BillingRpc; actorId: string; runId: string }): ToolSubcallBilling {
  const actor = uuid.parse(deps.actorId);
  const runId = uuid.parse(deps.runId);
  async function call(name: string, args: Record<string, unknown>) {
    const result = await deps.admin.rpc(name, { ...args, p_run_id: runId, p_actor_id: actor });
    if (result.error) {
      if (name === 'bill2_claim' || name === 'bill2_dispatch') throw claimFailure(result.error);
      const receipt = args.p_evidence as ReturnType<typeof toolResultEvidence> | undefined;
      // An authoritative not-dispatched response confirms zero supplier/user cost; no receipt is needed.
      if (name === 'bill2_record' && receipt?.toolOutcome === 'failed_free' && receipt.cost === '0'
        && z.object({ message: z.literal('BILL2_CALL_NOT_DISPATCHED') }).safeParse(result.error).success) return {};
      throw new Error('BILL2_DATABASE_UNAVAILABLE');
    }
    return result.data;
  }
  return {
    runId,
    async claim(sequence, payload) {
      const raw = await call('bill2_claim', { p_sequence: z.number().int().positive().parse(sequence), p_payload: payload });
      // The balance cannot cover this call's bound: nothing is held or sent (the id is null then).
      if (z.object({ state: z.literal('waiting_credits') }).passthrough().safeParse(raw).success) return { state: 'waiting_credits' };
      const data = claimed.parse(raw);
      return data.dispatchToken ? { state: 'claimed', callId: data.id, token: data.dispatchToken } : { state: 'replayed', callId: data.id };
    },
    async dispatch(callId, token) {
      const data = z.object({ dispatch: z.boolean() }).passthrough()
        .parse(await call('bill2_dispatch', { p_call_id: uuid.parse(callId), p_token: uuid.parse(token) }));
      return data.dispatch;
    },
    async record(callId, evidence) {
      const args = { p_call_id: uuid.parse(callId), p_evidence: evidence };
      let data: unknown;
      try { data = await call('bill2_record', args); }
      // One retry: the record is idempotent for the same evidence (0255 rejects only a different result).
      catch { data = await call('bill2_record', args); }
      const view = z.object({ accountClosed: z.boolean().optional(), contentDeleted: z.boolean().optional() }).passthrough().parse(data);
      return { accountClosed: view.accountClosed === true, contentDeleted: view.contentDeleted === true };
    },
  };
}
