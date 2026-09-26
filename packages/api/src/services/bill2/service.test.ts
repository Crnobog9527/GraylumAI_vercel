/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
const rebate=vi.hoisted(()=>vi.fn(async(_args:Record<string,unknown>)=>({status:'already_applied'})));
vi.mock('../invitationRebate',()=>({applyInvitationRebateForSpend:rebate}));
import { authoritativeBilling } from './service';
import { localFixtureAdapter } from './fixtureAdapter';
beforeEach(()=>rebate.mockClear());
it('passes only actual terminal spend and the original idempotent identity to the existing downstream',async()=>{
 const actor=randomUUID(),run=randomUUID(),pre=randomUUID(),client={};const view={id:run,preDeductId:pre,state:'settled',chargedCredits:7};
 const api=authoritativeBilling({admin:{rpc:async()=>({data:view,error:null})},actor:async()=>actor,adapter:localFixtureAdapter('http://127.0.0.1:1'),rebateClient:client});
 await api.finalizeRun(run);await api.finalizeRun(run);
 expect(rebate.mock.calls).toHaveLength(2);for(const args of rebate.mock.calls)expect(args[0]).toMatchObject({inviteeId:actor,preDeductId:pre,consumedCredits:7,supabaseAdmin:client});
 // This asserts adapter identity only. Original helper/RPC suites prove downstream idempotence.
});
it.each([{state:'refunded',chargedCredits:0},{state:'settled',chargedCredits:0},{state:'unknown',chargedCredits:null}])('never rebates a release, zero spend or unresolved reservation: %j',async state=>{
 const api=authoritativeBilling({admin:{rpc:async()=>({data:state,error:null})},actor:async()=>randomUUID(),adapter:localFixtureAdapter('http://127.0.0.1:1'),rebateClient:{}});await api.finalizeRun(randomUUID());expect(rebate).not.toHaveBeenCalled();
});
it('does not consume a bounded recovery claim when its full lookup cannot fit',async()=>{
 const {createRuntimeBudget}=await import('../runtime/budget');let clock=0;const budget=createRuntimeBudget(()=>clock);clock=211_000;
 const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>)=>({data:[randomUUID()],error:null})),lookup=vi.fn();
 await authoritativeBilling({admin:{rpc},actor:async()=>randomUUID(),adapter:{dispatch:vi.fn(),lookup},budget}).recoverReceipts(randomUUID());
 expect(rpc.mock.calls.map(call=>call[0])).toEqual(['bill2_pending_calls']);expect(lookup).not.toHaveBeenCalled();
});
it.each(['confirmed','lost-commit','not-committed','inspect-unavailable','started-error'])('only revokes this owned grant with adapter proof before transport: %s',async(mode)=>{
 const {openRouterAdapter}=await import('./openRouterAdapter'),{openRouterBound}=await import('./openRouterPolicy'),{createRuntimeBudget}=await import('../runtime/budget'),{createHash}=await import('node:crypto');
 let elapsed=0,attempts=0;const runId=randomUUID(),callId=randomUUID(),token=randomUUID(),actor=randomUUID(),budget=createRuntimeBudget(()=>elapsed);
 const limits={providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'};
 const body=JSON.stringify({model:'test/model',messages:[],stream:false,store:false,max_tokens:100,provider:openRouterBound(limits,100).routing});
 const frozen={provider:'openrouter',account:'synthetic',model:'test/model',protocol:'openrouter-chat-v1' as const,providerLimits:limits,inputLimit:8000,outputLimit:100,requestHash:createHash('sha256').update(body).digest('hex'),upperUsd:'0.02',phase:'ordinary',automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>=>{
  if(name==='bill2_claim')return {data:{id:callId,state:'prepared',dispatchToken:token},error:null};
  if(name==='bill2_dispatch'){elapsed=mode==='started-error'?0:136_000;return {data:{dispatch:true},error:null};}
  if(name==='bill2_record')return {data:{state:'unknown'},error:null};
  expect(name).toBe('bill2_revoke_unstarted_dispatch');expect(args).toMatchObject({p_actor_id:actor,p_run_id:runId,p_call_id:callId,p_token:token,p_request_hash:frozen.requestHash});
  if(args.p_inspect)return mode==='inspect-unavailable'?{data:null,error:{code:'offline'}}:{data:{revoked:mode==='lost-commit',eligible:mode==='not-committed'},error:null};
  attempts++;if(attempts===1&&mode!=='confirmed')return {data:null,error:{code:'lost'}};
  return {data:{revoked:true,eligible:false},error:null};
 });
 const transport=vi.fn<typeof fetch>(async()=>{throw new Error('RUNTIME_TIME_BUDGET_EXHAUSTED');});
 const adapter=openRouterAdapter({budget,credential:async()=> 'SYNTHETIC',transport});
 const billing=authoritativeBilling({admin:{rpc},actor:async()=>actor,adapter,budget});
 await billing.claimCall(runId,1,frozen);
 const first=billing.dispatchOnce(callId,body),second=billing.dispatchOnce(callId,body);
 expect(await second).toEqual({dispatched:false});
 if(mode==='inspect-unavailable')await expect(first).rejects.toThrow('BILL2_DATABASE_UNAVAILABLE');
 else expect(await first).toMatchObject(mode==='started-error'?{dispatched:true}:{dispatched:false,transportNotStarted:true});
 expect(transport).toHaveBeenCalledTimes(mode==='started-error'?1:0);
 expect(rpc.mock.calls.filter(([name])=>name==='bill2_record')).toHaveLength(mode==='started-error'?1:0);
 const revoke=rpc.mock.calls.filter(([name])=>name==='bill2_revoke_unstarted_dispatch').map(([,args])=>args.p_inspect===true?'inspect':'write');
 expect(revoke).toEqual(mode==='started-error'?[]:mode==='confirmed'?['write']:mode==='not-committed'?['write','inspect','write']:['write','inspect']);
});
