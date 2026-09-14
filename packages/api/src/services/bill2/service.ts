/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transportEvidence, localFixtureAdapter, unknownEvidence, type CallIdentity, type TransportObservation } from './fixtureAdapter';
import { aggregateCredits } from './decimal';
import { applyInvitationRebateForSpend } from '../invitationRebate';
const uuid = z.string().uuid();
const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('positioning_draft'), draftId: uuid }).strict(),
  z.object({ kind: z.literal('work_item'), projectId: uuid, workItemId: uuid }).strict(),
]);
const frozen = z.object({
  contractVersion: z.literal('bill2.v1'), mode: z.literal('isolated'), sessionRef: z.null().optional(), scope,
  moduleId: uuid.optional(), skillId: uuid.optional(),
  callPolicy: z.array(z.object({ modelId: uuid, provider:z.string().min(1),account:z.string().min(1),model:z.string().min(1),protocol:z.literal('fixture-cost-v1'),upperUsd:z.string(),inputLimit:z.number().int().positive().max(1_000_000),outputLimit:z.number().int().positive().max(1_000_000),automaticRetry:z.literal(false),hiddenTools:z.literal(false),lookupSupported:z.boolean() }).strict()).min(1).max(32),
  operation: z.enum(['question', 'research', 'organize', 'plan', 'work']), modelId: uuid, revisionId: uuid.optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), input: z.unknown(),
  rules: z.object({ version: z.string().min(1), quoteVersion: z.string().min(1), creditsPerUsd: z.string(), multiplier: z.string(),
    fx: z.record(z.string(), z.object({ version: z.string().min(1), usdPerUnit: z.string() }).strict()) }).strict(),
  limits: z.object({ costUsd: z.string(), credits: z.number().int().positive().max(2_147_483_647), maxPreDeduct: z.number().int().positive().max(2_147_483_647),
    maxCalls: z.number().int().min(1).max(32), deadline: z.string().datetime() }).strict(),
}).strict();
export type FrozenRun = z.infer<typeof frozen>;
const call = z.object({ provider: z.string().min(1).max(128), account: z.string().min(1).max(128), model: z.string().min(1).max(256),
  protocol: z.literal('fixture-cost-v1'), requestHash: z.string().regex(/^[a-f0-9]{64}$/), upperUsd: z.string(),
  inputLimit: z.number().int().positive().max(1_000_000), outputLimit: z.number().int().positive().max(1_000_000),
  automaticRetry: z.literal(false), hiddenTools: z.literal(false), lookupSupported: z.boolean(), phase: z.string().min(1).max(64) }).strict();
export type FrozenCall = z.infer<typeof call>;
export type RunView = { id: string; state: 'prepared' | 'dispatched' | 'unknown' | 'cost_pending' | 'settled' | 'refunded';
  preDeductId: string; closed: boolean; conflict: boolean; reservedCredits: number; chargedCredits: number | null; outcome: string | null };
export interface BillingRpc { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> }
export type DispatchClaim = { id: string; state: string; dispatchToken: string | null };
/** Trusted server composition only: actor comes from verified authentication, policy from the server.
 * No public route exposes raw RPC payloads or accepts a browser price/receipt. No env/fallback loading. */
export function authoritativeBilling(deps: { admin: BillingRpc; actor: () => Promise<string>; adapter: ReturnType<typeof localFixtureAdapter>;
  /** Existing downstream rebate, explicitly enabled only by the trusted host. */
  rebateClient?: Parameters<typeof applyInvitationRebateForSpend>[0]['supabase'];
}) {
  const capabilities = new Map<string, { token: string; frozen: FrozenCall; runId: string }>();
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const actor = uuid.parse(await deps.actor());
    const result = await deps.admin.rpc(name, { ...args, p_actor_id: actor });
    if (result.error) throw new Error('BILL2_DATABASE_UNAVAILABLE');
    return result.data as T;
  }
  const readRun = (id: string) => rpc<RunView>('bill2_read', { p_run_id: uuid.parse(id) });
  const recordReceipt = (runId: string, callId: string, evidence: unknown) => rpc<RunView>('bill2_record', { p_run_id: uuid.parse(runId), p_call_id: uuid.parse(callId), p_evidence: evidence });
  async function finalizeRun(runId: string): Promise<RunView> {
    let state: RunView;
    try { state = await rpc<RunView>('bill2_finalize', { p_run_id: uuid.parse(runId) }); }
    catch (error) {
      // Ambiguous transaction result: inspect original identity; never redispatch or retry blindly.
      state = await readRun(runId);
      if (!['settled', 'refunded'].includes(state.state)) throw error;
    }
    if (state.state === 'settled' && state.chargedCredits && deps.rebateClient) {
      // Reuse the existing idempotent downstream; run identity is stable, releases/refunds never enter it.
      await applyInvitationRebateForSpend({ supabase: deps.rebateClient, supabaseAdmin: deps.rebateClient,
        inviteeId: uuid.parse(await deps.actor()), consumedCredits: state.chargedCredits, preDeductId: state.preDeductId });
    }
    return state;
  }
  async function recoverReceipts(runId: string) {
      const calls = await rpc<string[]>('bill2_pending_calls', { p_run_id: uuid.parse(runId) });
      for (const callId of calls.slice(0, 32)) {
        const identity = await rpc<(CallIdentity & { providerId: string }) | null>('bill2_recovery_claim', { p_run_id: runId, p_call_id: callId });
        if (!identity) continue;
        let evidence;
        try { evidence = transportEvidence(await deps.adapter.lookup(identity.providerId), identity, 'lookup'); }
        catch { continue; } // No receipt is not evidence of zero cost. SQL enforces attempt/time bounds.
        await recordReceipt(runId, callId, { ...evidence, expectedProviderId: identity.providerId });
      }
  }
  return {
    readRun, finalizeRun, recoverReceipts,
    /** Trusted server recovery of a retained transport observation; never exposed as a client receipt endpoint. */
    recordReceipt,
    createDraft: () => rpc<string>('bill2_create_draft', {}),
    revokeDraft: (id: string) => rpc<void>('bill2_revoke_draft', { p_draft_id: uuid.parse(id) }),
    readPrivateInput: (id: string) => rpc<unknown>('bill2_private_input', { p_run_id: uuid.parse(id) }),
    async prepareRun(requestId: string, value: FrozenRun) {
      const parsed = frozen.parse(value);
      if (aggregateCredits([parsed.limits.costUsd], parsed.rules.creditsPerUsd, parsed.rules.multiplier) > parsed.limits.credits || parsed.limits.credits > parsed.limits.maxPreDeduct) throw new Error('BILL2_BUDGET_REJECTED');
      return rpc<RunView>('bill2_prepare', { p_request_id: uuid.parse(requestId), p_payload: parsed });
    },
    async claimCall(runId: string, sequence: number, value: FrozenCall) {
      const parsed = call.parse(value);
      const claimed = await rpc<DispatchClaim>('bill2_claim', { p_run_id: uuid.parse(runId), p_sequence: z.number().int().positive().parse(sequence), p_payload: parsed });
      if (claimed.dispatchToken) capabilities.set(claimed.id, { token: claimed.dispatchToken, frozen: parsed, runId });
      return { id: claimed.id, state: claimed.state };
    },
    async rotatePrepared(runId: string, callId: string, value: FrozenCall) {
      const parsed = call.parse(value);
      const rotated = await rpc<{ dispatchToken?: string }>('bill2_dispatch', { p_run_id: uuid.parse(runId), p_call_id: uuid.parse(callId), p_token: null, p_rotate: true, p_payload: parsed });
      if (rotated.dispatchToken) capabilities.set(callId, { token: rotated.dispatchToken, frozen: parsed, runId });
      return Boolean(rotated.dispatchToken);
    },
    async dispatchOnce(callId: string, body: string) {
      const capability = capabilities.get(callId);
      if (!capability) return { dispatched: false };
      if (createHash('sha256').update(body).digest('hex') !== capability.frozen.requestHash) throw new Error('BILL2_REQUEST_CONFLICT');
      if (body.length > capability.frozen.inputLimit) throw new Error('BILL2_INPUT_LIMIT');
      capabilities.delete(callId); // Single process possession is consumed before awaiting any commit response.
      const permission = await rpc<{ dispatch: boolean }>('bill2_dispatch', { p_run_id: capability.runId, p_call_id: callId, p_token: capability.token });
      if (!permission.dispatch) return { dispatched: false };
      const identity: CallIdentity = capability.frozen;
      let evidence;
      let observation: TransportObservation | undefined;
      try { observation = await deps.adapter.dispatch({ input: body, maxOutputTokens: capability.frozen.outputLimit, automaticRetry: false, hiddenTools: false }); evidence = transportEvidence(observation, identity, 'response'); }
      catch { evidence = { ...unknownEvidence(identity), evidenceKind: 'transport_observation' }; }
      try { await recordReceipt(capability.runId, callId, evidence); }
      catch { return { dispatched: true, pendingReceipt: { runId: capability.runId, callId, evidence } }; }
      return { dispatched: true, observation }; // Private server composition only; never a public route result.
    },
    closeRun: (runId: string, outcome: 'delivered' | 'confirmed_failure' | 'cancelled' | 'unknown', result: unknown = null) =>
      rpc<RunView>('bill2_close', { p_run_id: uuid.parse(runId), p_outcome: outcome, p_result: result }),
    requestCancel: (runId: string) => rpc<RunView>('bill2_cancel', { p_run_id: uuid.parse(runId) }),
    async recoverRun(runId: string) {
      await recoverReceipts(runId);
      const state = await readRun(runId);
      return state.closed ? finalizeRun(runId) : state;
    },
  };
}
