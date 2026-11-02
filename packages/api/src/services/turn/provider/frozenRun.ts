/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { CallIdentity, TransportObservation } from './fixtureAdapter';
import { openRouterLimits } from './openRouterPolicy';
import { paygStablePolicy, paygCallQuote } from '../admission/paygPolicy';
import { MULTIPLIER_PATTERN } from '../../billingUnit';
import { frozenBillingUnit } from '../admission/billingUnitAdmission';
/*
 * The frozen run and call contracts and the BILL2 transport types. Moved out of service.ts (the BILL2 client, which only the old
 * runtime executor still instantiates) so the turn path imports its schemas and types without importing the client.
 */
export const uuid = z.string().uuid();
const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('positioning_draft'), draftId: uuid }).strict(),
  z.object({ kind: z.literal('work_item'), projectId: uuid, workItemId: uuid }).strict(),
  // LIB-2d (0286): one of the actor's own PDF or Word documents in the library.
  z.object({ kind: z.literal('library_document'), documentId: uuid }).strict(),
]);
export const frozenCallPolicy = z.object({
  payg: paygStablePolicy.optional(), multiplier: z.string().regex(MULTIPLIER_PATTERN).optional(),
   modelId: uuid, provider:z.string().min(1),
   account:z.string().min(1),model:z.string().min(1),protocol:z.enum(['fixture-cost-v1','openrouter-chat-v1']),
   providerLimits:openRouterLimits.optional(),upperUsd:z.string(),
   inputLimit:z.number().int().positive().max(1_000_000),outputLimit:z.number().int().positive().max(1_000_000),
   automaticRetry:z.literal(false),hiddenTools:z.literal(false),lookupSupported:z.boolean() }).strict();
export const frozen = z.object({
  contractVersion: z.literal('bill2.v1'), mode: z.enum(['isolated','staging_test','production']), testWindowId:uuid.optional(),
  sessionRef: z.null().optional(), scope,
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
export const frozenPayg = frozen.extend({
  contractVersion: z.literal('bill2.v2'),
  limits: frozen.shape.limits.extend({ credits: z.literal(0) }),
}).refine(value => value.callPolicy.every(policy => policy.payg !== undefined) && value.rules.billingUnit !== undefined);
/** FUSION-REVIEW admission validates its runs before the database transaction prepares them. */
export const frozenPaygRunSchema = frozenPayg;
export type FrozenPaygRun = z.infer<typeof frozenPayg>;
export type FrozenRun = z.infer<typeof frozen>;
export const call = z.object({ runtimeEpoch: z.number().int().positive().optional(), payg: paygCallQuote.optional(),
  provider: z.string().min(1).max(128), account: z.string().min(1).max(128), model: z.string().min(1).max(256),
  protocol: z.enum(['fixture-cost-v1','openrouter-chat-v1']), providerLimits:openRouterLimits.optional(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), upperUsd: z.string(),
  inputLimit: z.number().int().positive().max(1_000_000), outputLimit: z.number().int().positive().max(1_000_000),
  automaticRetry: z.literal(false), hiddenTools: z.literal(false), lookupSupported: z.boolean(), phase: z.string().min(1).max(64),
  billingUnit: z.object({ modelId: uuid, multiplier: z.string().regex(MULTIPLIER_PATTERN), source: z.enum(['model', 'provider', 'global']) })
    .strict().optional() }).strict();
export const frozenCallSchema = call;
export type FrozenCall = z.infer<typeof call>;
export type RunView = { executionId?: string|null; accountClosed?: boolean; contentDeleted?: boolean; id: string;
  state: 'prepared' | 'dispatched' | 'unknown' | 'cost_pending' | 'settled' | 'refunded';
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
export type DispatchClaim = { id: string; state: string; dispatchToken: string | null };
