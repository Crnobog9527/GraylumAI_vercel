/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runtimeAdmissionService } from './admission';
import { allowAllModeration } from './moderation';
import { DEFAULT_RUNTIME_RATE_LIMITS as defaults } from './rateLimitSettings';
import { createRequestTiming } from './timing';
import { OPENING_INPUT } from '../../shared/opcQuestions';
const mock = vi.hoisted(() => ({ redis: vi.fn(), recovery: vi.fn() }));
vi.mock('../redisRateLimiter', () => ({ checkRuntimeRateLimit: mock.redis }));
vi.mock('./automaticRecovery', () => ({ runAutomaticFinancialRecovery: mock.recovery }));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  let replay: {executionId?:string}|null = null;
  let config: unknown = defaults;
  let failure = false, hanging = false;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<{data: {executionId?: string;payload?: unknown;scope?: unknown}|null;error: {code:string;message:string}|null}> => {
    if (name === 'runtime_session_context') return { data: { scope: { kind: 'positioning_draft', draftId: id(2) } }, error: null };
    if (name === 'runtime_admission_replay') return { data: replay, error: null };
    if (name === 'runtime_admit') return { data: { executionId: id(4), payload: args.p_payload }, error: null };
    throw new Error(name);
  });
  const read = vi.fn(async () => {
    if (hanging) return new Promise<never>(() => {});
    if (failure) throw new Error('PRIVATE');
    return { data: config === null ? null : { value: config }, error: null };
  });
  const model = { id: id(3), model_id: 'fixture', provider: 'fixture', is_active: 'true', max_tokens: 1000, input_limit: 32000 };
  const q = { select: () => q, eq: () => q, maybeSingle: read, single: async () => ({ data: model, error: null }) };
  const admin = { rpc, from: vi.fn(() => q) } as unknown as SupabaseClient;
  const user = { auth: { getUser: async () => ({ data: { user: { id: id(1), email_confirmed_at: '2026-01-01' } }, error: null }) } };
  const policy = { account: 'local', costPerCall: '0.02', creditsPerUsd: '1000', multiplier: '1',
    maxCalls: 3, maxOutputTokens: 1000, inputBytes: 32000, historyItems: 10 };
  const input = { sessionId: id(2), requestId: id(4), input: 'synthetic', selection: { kind: 'ordinary', modelId: id(3) }, network: 'deny' };
  return { rpc, read, input, policy, admin, user: user as unknown as SupabaseClient,
    replay: (value: {executionId?:string}|null) => { replay = value; }, config: (value: unknown) => { config = value; },
    fail: () => { failure = true; }, hang: () => { hanging = true; } };
}
beforeEach(() => {
  mock.redis.mockReset().mockResolvedValue({ success: true });
  mock.recovery.mockReset().mockResolvedValue({ failed: 0 });
});
afterEach(() => vi.restoreAllMocks());
it.each(['paused', 'failed', 'hanging'])('returns replay without a gate or moderation even with %s settings', async mode => {
  const f = fixture(); f.replay({ executionId: id(4) });
  if (mode === 'paused') f.config({ ...defaults, stopNewCalls: true });
  if (mode === 'failed') f.fail();
  if (mode === 'hanging') f.hang();
  const moderation = vi.spyOn(allowAllModeration, 'checkInput');
  expect(await runtimeAdmissionService(f.user, f.admin, f.policy).prepare(f.input)).toEqual({ executionId: id(4) });
  expect(mock.redis).not.toHaveBeenCalled(); expect(moderation).not.toHaveBeenCalled();
  expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain('runtime_admit');
});
it.each(['minute', 'day', 'paused', 'failed', 'invalid', 'unavailable'])('denies %s before model loading, admission or moderation', async reason => {
  const f = fixture();
  if (reason === 'paused') f.config({ ...defaults, stopNewCalls: true });
  else if (reason === 'failed') f.fail();
  else if (reason === 'invalid') f.config({});
  else mock.redis.mockResolvedValue({ success: false, reason: reason === 'unavailable' ? 'unavailable' : 'rate_limited',
    window: reason, retryAfter: 25 });
  const moderation = vi.spyOn(allowAllModeration, 'checkInput');
  await expect(runtimeAdmissionService(f.user, f.admin, f.policy).prepare(f.input)).rejects.toMatchObject({
    code: ['minute', 'day'].includes(reason) ? 'TOO_MANY_REQUESTS' : 'SERVICE_UNAVAILABLE',
  });
  expect(f.admin.from).toHaveBeenCalledTimes(1); expect(moderation).not.toHaveBeenCalled();
  expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain('runtime_admit');
});
it('counts verified actor once, passes resolved card text, then admits unchanged frozen payload', async () => {
  const f = fixture(); f.config(null);
  const moderation = vi.spyOn(allowAllModeration, 'checkInput');
  const timing = createRequestTiming();
  const result = await timing.run(() => runtimeAdmissionService(f.user, f.admin, { ...f.policy, resolvedInput: 'resolved card text' })
    .prepare(f.input));
  expect(mock.redis).toHaveBeenCalledExactlyOnceWith(id(1), 'admission', defaults, 'local', 1);
  expect(moderation).toHaveBeenCalledExactlyOnceWith({ actorId: id(1), sessionId: id(2), requestId: id(4),
    text: 'resolved card text', opening: false });
  expect((result.payload as {input:string}).input).toBe('resolved card text');
  const args = f.rpc.mock.calls.find(([name]) => name === 'runtime_admit')![1];
  expect((args.p_billing as { input: unknown }).input).toEqual(args.p_payload);
  expect(timing.summary().phases.rateLimit).toBeDefined();
});
it('uses the staging namespace only when the authenticated host supplies a real policy', async () => {
  const f = fixture();
  mock.redis.mockResolvedValue({ success: false, reason: 'rate_limited', window: 'minute', retryAfter: 25 });
  await expect(runtimeAdmissionService(f.user, f.admin, { ...f.policy, real: {
    id: id(6), expiresAt: '2099-01-01T00:00:00Z', creditsPerUsd: '1000', multiplier: '1', callPolicies: [],
  } }).prepare(f.input)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  expect(mock.redis).toHaveBeenCalledExactlyOnceWith(id(1), 'admission', defaults, 'staging', 1);
});
it.each(['block', 'throw'])('input moderation %s prevents execution and reservation', async mode => {
  const f = fixture();
  const check = vi.spyOn(allowAllModeration, 'checkInput');
  if (mode === 'block') check.mockResolvedValue({ action: 'block', category: 'synthetic' });
  else check.mockRejectedValue(new Error('PRIVATE'));
  await expect(runtimeAdmissionService(f.user, f.admin, { ...f.policy, mentorStream: true, opcTurnToken: id(5) })
    .prepare({ ...f.input, input: OPENING_INPUT }))
    .rejects.toThrow('RUNTIME_MODERATION_BLOCKED');
  expect(check.mock.calls[0][0].opening).toBe(true);
  expect(f.rpc.mock.calls.map(([name]) => name)).not.toContain('runtime_admit');
});

it('admits the normal path without any recovery inventory round trip', async () => {
 const f=fixture();
 await runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input);
 expect(mock.recovery).not.toHaveBeenCalled();
 expect(f.rpc.mock.calls.map(([name])=>name)).not.toContain('runtime_pending_financial_batch');
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admit')).toHaveLength(1);
});

it.each(['success','insufficient','unknown','committed'])('recovers once after insufficient credits then handles %s', async mode => {
 const f=fixture(),original=f.rpc.getMockImplementation()!;let attempts=0;
 f.rpc.mockImplementation(async(name,args)=>{
  if(name==='runtime_admit'){
   attempts++;
   if(attempts===1||mode==='insufficient')return {data:null,error:{code:'P0001',message:'400: insufficient credits'}};
   if(mode==='unknown'||mode==='committed'){
    if(mode==='committed')f.replay({executionId:id(4)});
    return {data:null,error:{code:'XX000',message:'synthetic ambiguous response'}};
   }
  }
  return original(name,args);
 });
 let release!:()=>void;
 mock.recovery.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
 const result=runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input).then(value=>({value,error:null}),error=>({value:null,error}));
 await vi.waitFor(()=>expect(mock.recovery).toHaveBeenCalledExactlyOnceWith(f.admin,id(1)));
 expect(attempts).toBe(1);release();
 const settled=await result;
 expect(attempts).toBe(2);expect(mock.recovery).toHaveBeenCalledTimes(1);
 const calls=f.rpc.mock.calls.filter(([name])=>name==='runtime_admit');
 expect(calls[1][1]).toEqual(calls[0][1]);
 expect(calls[1][1].p_request_id).toBe(f.input.requestId);
 if(mode==='success'||mode==='committed')expect(settled.value).toMatchObject({executionId:id(4)});
 else expect(settled.error).toMatchObject({message:mode==='insufficient'?'BILL2_INSUFFICIENT_CREDITS':'RUNTIME_ADMISSION_DENIED'});
});

it('never retries an ambiguous first admission or starts recovery for it', async () => {
 const f=fixture(),original=f.rpc.getMockImplementation()!;
 f.rpc.mockImplementation(async(name,args)=>name==='runtime_admit'
  ?{data:null,error:{code:'XX000',message:'synthetic timeout'}}:original(name,args));
 await expect(runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input)).rejects.toThrow('RUNTIME_ADMISSION_DENIED');
 expect(mock.recovery).not.toHaveBeenCalled();
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admit')).toHaveLength(1);
});

it('keeps default admission v1 and selects v2 only through trusted server policy', async () => {
 const f=fixture();
 await runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input);
 expect((f.rpc.mock.calls.find(([n])=>n==='runtime_admit')![1].p_billing as {contractVersion:string}).contractVersion).toBe('bill2.v1');
 const hash='a'.repeat(64);
 const nominalPricing={version:'nominal-v1' as const,pricingHash:hash,endpointTag:'local',
  tiers:[{minPromptTokens:0,prompt:'1',completion:'1',request:'0'}],timeOfDay:[]};
 const policy={modelId:id(3),model:'fixture',provider:'fixture',account:'local',protocol:'fixture-cost-v1' as const,
  multiplier:'1',upperUsd:'0.1',inputLimit:32000,outputLimit:1000,automaticRetry:false as const,
  hiddenTools:false as const,lookupSupported:true,
  providerLimits:{providerSlug:'local',contextTokens:100000,promptUsdPerMillion:'1',completionUsdPerMillion:'1',requestUsd:'0'},
  payg:{policyId:'local',version:'1',profileVersion:'1',evidenceVersion:'1',pricingHash:hash,endpointTag:'local',
   nominalPricing,templateTokens:4096,marginTokens:4096,admissionPath:'fixture' as const,maxBytes:32000,
   maxMessages:32,maxTools:2,maxSchemaBytes:16384,purposes:['ordinary'],expiresAt:'2099-01-01T00:00:00Z'}};
 f.rpc.mockClear();
 await runtimeAdmissionService(f.user,f.admin,{...f.policy,payg:{callPolicies:[policy],billingUnit:{
  version:'bill-unit-v2',creditsPerUsd:'1000',defaultMultiplier:'1',hash,
  models:{[id(3)]:{multiplier:'1',source:'global'}},providers:{}}}}).prepare(f.input);
 const billing=f.rpc.mock.calls.find(([n])=>n==='runtime_admit')![1].p_billing;
 expect(billing).toMatchObject({contractVersion:'bill2.v2',limits:{credits:0,maxCalls:3},callPolicy:[policy]});
 await expect(runtimeAdmissionService(f.user,f.admin,f.policy).prepare({...f.input,payg:true})).rejects.toThrow();
});
