/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transportEvidence, unknownEvidence, type CallIdentity, type TransportObservation } from './fixtureAdapter';
import {openRouterLimits,OPENROUTER_LOOKUP_TIMEOUT_MS} from './openRouterPolicy';
import { paygStablePolicy, paygCallQuote } from './paygPolicy';
import { MULTIPLIER_PATTERN } from '../billingUnit';
import { frozenBillingUnit } from '../runtime/billingUnitAdmission';
import type {RuntimeBudget} from '../runtime/budget';
import { openRouterRejection } from './openRouterRejection';
import { openRouterNotFound, type RejectionRecovery } from './openRouterNotFound';
import { openRouterEvidence } from './openRouterEvidence';
import {consumeOpenRouterNotStarted} from './openRouterAdapter';
import { aggregateCredits } from './decimal';
import { applyInvitationRebateForSpend } from '../invitationRebate';
const uuid = z.string().uuid();
const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('positioning_draft'), draftId: uuid }).strict(),
  z.object({ kind: z.literal('work_item'), projectId: uuid, workItemId: uuid }).strict(),
]);
export const frozenCallPolicy = z.object({
  payg: paygStablePolicy.optional(), multiplier: z.string().regex(MULTIPLIER_PATTERN).optional(),
   modelId: uuid, provider:z.string().min(1),account:z.string().min(1),model:z.string().min(1),protocol:z.enum(['fixture-cost-v1','openrouter-chat-v1']),providerLimits:openRouterLimits.optional(),upperUsd:z.string(),inputLimit:z.number().int().positive().max(1_000_000),outputLimit:z.number().int().positive().max(1_000_000),automaticRetry:z.literal(false),hiddenTools:z.literal(false),lookupSupported:z.boolean() }).strict();
const frozen = z.object({
  contractVersion: z.literal('bill2.v1'), mode: z.enum(['isolated','staging_test']), testWindowId:uuid.optional(), sessionRef: z.null().optional(), scope,
  moduleId: uuid.optional(), skillId: uuid.optional(),
  callPolicy: z.array(frozenCallPolicy).min(1).max(32),
  operation: z.enum(['question', 'research', 'organize', 'plan', 'work']), modelId: uuid, revisionId: uuid.optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), input: z.unknown(),
  rules: z.object({ billingUnit: frozenBillingUnit.optional(),
    version: z.string().min(1), quoteVersion: z.string().min(1), creditsPerUsd: z.string(), multiplier: z.string(),
    fx: z.record(z.string(), z.object({ version: z.string().min(1), usdPerUnit: z.string() }).strict()) }).strict(),
  limits: z.object({ costUsd: z.string(), credits: z.number().int().positive().max(2_147_483_647), maxPreDeduct: z.number().int().positive().max(2_147_483_647),
    maxCalls: z.number().int().min(1).max(32), deadline: z.string().datetime() }).strict(),
}).strict();
const frozenPayg = frozen.extend({
  contractVersion: z.literal('bill2.v2'),
  limits: frozen.shape.limits.extend({ credits: z.literal(0) }),
}).refine(value => value.callPolicy.every(policy => policy.payg !== undefined) && value.rules.billingUnit !== undefined);
export type FrozenPaygRun = z.infer<typeof frozenPayg>;
export type FrozenRun = z.infer<typeof frozen>;
const call = z.object({ runtimeEpoch: z.number().int().positive().optional(), payg: paygCallQuote.optional(),
  provider: z.string().min(1).max(128), account: z.string().min(1).max(128), model: z.string().min(1).max(256),
  protocol: z.enum(['fixture-cost-v1','openrouter-chat-v1']), providerLimits:openRouterLimits.optional(), requestHash: z.string().regex(/^[a-f0-9]{64}$/), upperUsd: z.string(),
  inputLimit: z.number().int().positive().max(1_000_000), outputLimit: z.number().int().positive().max(1_000_000),
  automaticRetry: z.literal(false), hiddenTools: z.literal(false), lookupSupported: z.boolean(), phase: z.string().min(1).max(64),
  billingUnit: z.object({ modelId: uuid, multiplier: z.string().regex(MULTIPLIER_PATTERN), source: z.enum(['model', 'provider', 'global']) })
    .strict().optional() }).strict();
export type FrozenCall = z.infer<typeof call>;
export type RunView = { executionId?: string|null; accountClosed?: boolean; id: string; state: 'prepared' | 'dispatched' | 'unknown' | 'cost_pending' | 'settled' | 'refunded';
  contractVersion?: string; calls?: Array<{preDeductId?: string; chargedCredits?: number;}>;
  preDeductId: string; closed: boolean; conflict: boolean; reservedCredits: number; chargedCredits: number | null; outcome: string | null };
type RpcResult={data:unknown;error:unknown};
export interface BillingRpc {
  rpc(name:string,args:Record<string,unknown>):PromiseLike<RpcResult> & {
    abortSignal?:(signal:AbortSignal)=>PromiseLike<RpcResult>;
  };
}
export interface BillingTransport {
 /** Private no-HTTP validation before persistent dispatch; returned capability
  * encloses the exact validated request and credential for one send. */
 prepareDispatch?(body:unknown,identity:CallIdentity,onChunk?:(chunk:string)=>void,onIdentity?:(id:string)=>void):Promise<()=>Promise<TransportObservation>>;
 dispatch(body:unknown, identity:CallIdentity):Promise<TransportObservation>;
 lookup(providerId:string, identity:CallIdentity, options?:{timeoutMs?:number}):Promise<TransportObservation>;
}
function providerEvidence(observation:TransportObservation,identity:CallIdentity,source:'response'|'lookup',expectedProviderId?:string){
 if(identity.protocol==='openrouter-chat-v1') {
  if(identity.provider!=='openrouter')throw new Error('BILL2_PROVIDER_IDENTITY_DENIED');
  return openRouterEvidence(observation,{...identity,provider:'openrouter',protocol:'openrouter-chat-v1'},source,expectedProviderId);
 }
 return transportEvidence(observation,identity,source);
}
const financialNames=new Set(['bill2_read','bill2_record','bill2_finalize','bill2_pending_calls','bill2_recovery_claim',
  'bill2_revoke_unstarted_dispatch','bill2_close','bill2_cancel','runtime_receipt_saved']);
export type DispatchClaim = { id: string; state: string; dispatchToken: string | null };
/** Trusted server composition only: actor comes from verified authentication, policy from the server.
 * No public route exposes raw RPC payloads or accepts a browser price/receipt. No env/fallback loading. */
export function authoritativeBilling(deps: { budget?:RuntimeBudget; admin: BillingRpc; actor: () => Promise<string>; adapter: BillingTransport;
  /** Existing downstream rebate, explicitly enabled only by the trusted host. */
  rebateClient?: Parameters<typeof applyInvitationRebateForSpend>[0]['supabase'];
}) {
  const capabilities = new Map<string, { token: string; frozen: FrozenCall; runId: string; actorId: string }>();
  const financialActors = new Map<string,string>();
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const runId = typeof args.p_run_id === 'string' ? args.p_run_id : '';
    const retained = financialNames.has(name) ? financialActors.get(runId) : undefined;
    const actor = retained ?? uuid.parse(await deps.actor());
    return rpcAs<T>(name,args,actor);
  }
  async function rpcAs<T>(name:string,args:Record<string,unknown>,actor:string):Promise<T> {
    const query=deps.admin.rpc(name,{...args,p_actor_id:actor});
    // Native cancellation bounds the owned early write and ambiguous-result readback.
    // Supabase supports abortSignal; test doubles can return already-bounded promises.
    const remaining=Math.max(1,Math.floor(deps.budget?.remainingPersistence()??10_000));
    const result=await (financialNames.has(name)&&query.abortSignal ? query.abortSignal(AbortSignal.timeout(Math.min(10_000,remaining))) : query);
    if (result.error) {
      const code = typeof result.error === 'object' && 'message' in result.error ? result.error.message : null;
      if (name === 'bill2_claim' && typeof code === 'string' &&
        ['REPORT_MEMBERSHIP_REQUIRED', 'REPORT_ENTITLEMENTS_UNAVAILABLE', 'REPORT_SOURCE_CONFLICT'].includes(code)) {
        throw new Error(code);
      }
      throw new Error('BILL2_DATABASE_UNAVAILABLE');
    }
    return result.data as T;
  }
  const readRun = (id: string) => rpc<RunView>('bill2_read', { p_run_id: uuid.parse(id) });
  async function recordReceipt(runId:string,callId:string,evidence:unknown):Promise<RunView> {
    const args={p_run_id:uuid.parse(runId),p_call_id:uuid.parse(callId),p_evidence:evidence};
    try { return await rpc<RunView>('bill2_record',args); }
    catch(error) {
      if (!financialActors.has(runId)) throw error;
      const prior=await readRun(runId);
      if(!prior.executionId)throw error;
      const saved=await rpc<boolean>('runtime_receipt_saved',{...args,p_execution_id:prior.executionId});
      return saved ? readRun(runId) : rpc<RunView>('bill2_record',args);
    }
  }
  async function finalizeRun(runId: string): Promise<RunView> {
    let state: RunView;
    try { state = await rpc<RunView>('bill2_finalize', { p_run_id: uuid.parse(runId) }); }
    catch (error) {
      // Ambiguous transaction result: inspect original identity; never redispatch or retry blindly.
      state = await readRun(runId);
      if (!['settled', 'refunded'].includes(state.state)) throw error;
    }
    if (state.contractVersion === 'bill2.v2' && state.state === 'settled' && deps.rebateClient) {
      const current = await readRun(runId);
      for (const item of current.calls ?? []) {
        if (!item.preDeductId || !item.chargedCredits) continue;
        await applyInvitationRebateForSpend({ supabase: deps.rebateClient, supabaseAdmin: deps.rebateClient,
          inviteeId: financialActors.get(runId) ?? uuid.parse(await deps.actor()),
          consumedCredits: item.chargedCredits, preDeductId: item.preDeductId });
      }
    } else if (state.contractVersion !== 'bill2.v2' && state.state === 'settled' && state.chargedCredits && deps.rebateClient) {
      // Reuse the existing idempotent downstream; run identity is stable, releases/refunds never enter it.
      await applyInvitationRebateForSpend({ supabase: deps.rebateClient, supabaseAdmin: deps.rebateClient,
        inviteeId: financialActors.get(runId) ?? uuid.parse(await deps.actor()), consumedCredits: state.chargedCredits, preDeductId: state.preDeductId });
    }
    return state;
  }
  async function recoverReceipts(runId: string, options: {timeoutMs?:number;callId?:string;immediate?:boolean} = {}) {
      const calls = await rpc<string[]>('bill2_pending_calls', { p_run_id: uuid.parse(runId) });
      for (const callId of calls.filter(id => !options.callId || id === options.callId).slice(0, 32)) {
        try{deps.budget?.assertCanStart(options.timeoutMs ?? OPENROUTER_LOOKUP_TIMEOUT_MS);}catch{break;} // Do not spend a recovery claim when no lookup fits.
        const identity = await rpc<(CallIdentity & { providerId: string; rejectionRecovery?: RejectionRecovery }) | null>(
          'bill2_recovery_claim', { p_run_id: runId, p_call_id: callId });
        if (!identity) continue;
        let evidence;
        const queryTimes: string[] = [];
        const queryOutcomes: string[] = [];
        try {
          for (let attempt = 0; attempt < (options.immediate ? 2 : 1); attempt++) {
            queryTimes.push(new Date().toISOString());
            queryOutcomes.push('other');
            const observation = await deps.adapter.lookup(identity.providerId, identity, {timeoutMs: options.timeoutMs});
            const absent = identity.rejectionRecovery ? openRouterNotFound(observation, identity, identity.providerId) : null;
            queryOutcomes[attempt] = absent?.lookupOutcome ?? 'other';
            evidence = absent ?? providerEvidence(observation, identity, 'lookup', identity.providerId);
            if (!absent || !options.immediate || attempt === 1) break;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch {
          if (!identity.rejectionRecovery) continue;
          evidence = { ...unknownEvidence(identity), source: 'lookup', evidenceKind: 'transport_observation' };
        }
        if (identity.rejectionRecovery) Object.assign(identity.rejectionRecovery, {queryCount: queryTimes.length, queryTimes, queryOutcomes});
        // SQL owns claim identity/time and keeps only a financial projection for this path.
        await recordReceipt(runId, callId, { ...evidence, expectedProviderId: identity.providerId,
          ...(identity.rejectionRecovery ? { rejectionRecovery: identity.rejectionRecovery } : {}) });
      }
  }
  async function claimPaygCall(runId: string, sequence: number, value: FrozenCall) {
      const parsed = call.parse(value);
      const actorId=uuid.parse(await deps.actor());
      const claimed = await rpcAs<DispatchClaim>('bill2_claim', { p_run_id: uuid.parse(runId), p_sequence: z.number().int().positive().parse(sequence), p_payload: parsed },actorId);
      if (claimed.state === 'waiting_credits') return { id: null, state: 'waiting_credits' as const };
      if (claimed.dispatchToken) capabilities.set(claimed.id, { token: claimed.dispatchToken, frozen: parsed, runId, actorId });
      return { id: claimed.id, state: claimed.state };
    }
  return {
    readRun, finalizeRun, recoverReceipts,
    /** Trusted server recovery of a retained transport observation; never exposed as a client receipt endpoint. */
    recordReceipt,
    createDraft: () => rpc<string>('bill2_create_draft', {}),
    revokeDraft: (id: string) => rpc<void>('bill2_revoke_draft', { p_draft_id: uuid.parse(id) }),
    readPrivateInput: (id: string) => rpc<unknown>('bill2_private_input', { p_run_id: uuid.parse(id) }),
    /** Core-only v2 entry; no Runtime or public route selects it in PR-A. */
    preparePaygRun: (requestId: string, value: FrozenPaygRun) =>
      rpc<RunView>('bill2_prepare', { p_request_id: uuid.parse(requestId), p_payload: frozenPayg.parse(value) }),
    async prepareRun(requestId: string, value: FrozenRun) {
      const parsed = frozen.parse(value);
      if (aggregateCredits([parsed.limits.costUsd], parsed.rules.creditsPerUsd, parsed.rules.multiplier) > parsed.limits.credits || parsed.limits.credits > parsed.limits.maxPreDeduct) throw new Error('BILL2_BUDGET_REJECTED');
      return rpc<RunView>('bill2_prepare', { p_request_id: uuid.parse(requestId), p_payload: parsed });
    },
    claimPaygCall,
    async claimCall(runId: string, sequence: number, value: FrozenCall) {
      const result = await claimPaygCall(runId, sequence, value);
      if (result.id === null) throw new Error('BILL2_INSUFFICIENT_CREDITS');
      return { id: result.id, state: result.state };
    },
    async rotatePrepared(runId: string, callId: string, value: FrozenCall) {
      const parsed = call.parse(value);
      const actorId=uuid.parse(await deps.actor());
      const rotated = await rpcAs<{ dispatchToken?: string }>('bill2_dispatch', { p_run_id: uuid.parse(runId), p_call_id: uuid.parse(callId), p_token: null, p_rotate: true, p_payload: parsed },actorId);
      if (rotated.dispatchToken) capabilities.set(callId, { token: rotated.dispatchToken, frozen: parsed, runId, actorId });
      return Boolean(rotated.dispatchToken);
    },
    async dispatchOnce(callId: string, body: string, onChunk?:(chunk:string)=>void) {
      const capability = capabilities.get(callId);
      if (!capability) return { dispatched: false };
      if (createHash('sha256').update(body).digest('hex') !== capability.frozen.requestHash) throw new Error('BILL2_REQUEST_CONFLICT');
      if ((capability.frozen.payg ? Buffer.byteLength(body) : body.length) > capability.frozen.inputLimit) throw new Error('BILL2_INPUT_LIMIT');
      if (capability.frozen.payg && Buffer.byteLength(body) !== capability.frozen.payg.bytes) {
        throw new Error('BILL2_INPUT_BOUND_CONFLICT');
      }
      capabilities.delete(callId); // Single process possession is consumed before any await.
      const identity: CallIdentity = capability.frozen;
      const input={input:body,maxOutputTokens:capability.frozen.outputLimit,automaticRetry:false,hiddenTools:false};
      // A known local preflight failure leaves the SQL call prepared, so the
      // existing Runtime fail-before-dispatch path can safely release it.
      let early:Promise<unknown>|undefined;
      const onIdentity=(providerId:string)=>{
        if(early)return;
        const evidence={...unknownEvidence({provider:identity.provider,account:identity.account,
          model:identity.model,protocol:identity.protocol}),providerId,source:'response',
          sourceHash:createHash('sha256').update(JSON.stringify({providerId,provider:identity.provider,
            account:identity.account,model:identity.model})).digest('hex'),evidenceKind:'transport_observation'};
        early=recordReceipt(capability.runId,callId,evidence).catch(()=>undefined);
      };
      const send=deps.adapter.prepareDispatch?await deps.adapter.prepareDispatch(input,identity,onChunk,onIdentity):()=>deps.adapter.dispatch(input,identity);
      const actorId=uuid.parse(await deps.actor());
      if(actorId!==capability.actorId)throw new Error('BILL2_ACTOR_BINDING_DENIED');
      const permission = await rpcAs<{ dispatch: boolean }>('bill2_dispatch',
        { p_run_id: capability.runId, p_call_id: callId, p_token: capability.token },actorId);
      if (!permission.dispatch) return { dispatched: false };
      financialActors.set(capability.runId,actorId);
      let evidence;
      let observation: TransportObservation | undefined;
      try {
       observation = await send();
       evidence = openRouterRejection(observation,identity,capability.frozen.requestHash)
        ?? providerEvidence(observation, identity, 'response');
      }
      catch(error) {
       if(consumeOpenRouterNotStarted(error,capability.frozen.requestHash,send)){
        const args={p_run_id:capability.runId,p_call_id:callId,p_token:capability.token,p_request_hash:capability.frozen.requestHash};
        type Revocation={revoked:boolean;eligible:boolean};
        let revoked=false;
        try{revoked=(await rpc<Revocation>('bill2_revoke_unstarted_dispatch',args)).revoked;}
        catch{
         // Inspect an ambiguous durable result before the one bounded retry.
         const prior=await rpc<Revocation>('bill2_revoke_unstarted_dispatch',{...args,p_inspect:true});
         if(prior.revoked)revoked=true;
         else if(prior.eligible){
          try{revoked=(await rpc<Revocation>('bill2_revoke_unstarted_dispatch',args)).revoked;}
          catch{revoked=(await rpc<Revocation>('bill2_revoke_unstarted_dispatch',{...args,p_inspect:true})).revoked;}
         }
        }
        if(!revoked)throw new Error('BILL2_UNSTARTED_REVOKE_UNCONFIRMED');
        return {dispatched:false,transportNotStarted:true as const};
       }
       evidence = { ...unknownEvidence(identity), evidenceKind: 'transport_observation' };
      }
      await early; // Owned by this invocation; database transport shares its persistence deadline.
      try {
        const saved = await recordReceipt(capability.runId, callId, evidence);
        if (saved.accountClosed) return { dispatched: true, accountClosed: true as const };
        if ('evidenceKind' in evidence && evidence.evidenceKind === 'provider_rejection_pending') {
          // Only this strict refusal gets a bounded immediate lookup; never retry generation.
          await recoverReceipts(capability.runId, {callId, timeoutMs: 1_500, immediate: true});
        }
      }
      catch { return { dispatched: true,
        providerRejected: 'evidenceKind' in evidence &&
          ['provider_rejection', 'provider_rejection_pending'].includes(String(evidence.evidenceKind)),
        pendingReceipt: { runId: capability.runId, callId, evidence } }; }
      // Confirmation can still commit after this receipt. Every later Runtime
      // read/write then refuses the actor (bill2_actor), so no content reaches SDK/history/result.
      return { dispatched: true, observation,
        providerRejected: 'evidenceKind' in evidence &&
          ['provider_rejection', 'provider_rejection_pending'].includes(String(evidence.evidenceKind)) };
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
