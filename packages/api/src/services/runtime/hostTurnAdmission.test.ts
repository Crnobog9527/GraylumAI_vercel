/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';

import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {runtimeContext} from './execute';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {pricingConfig} from '../__tests__/fixtures/runtimePricing';
import {agentTurnInstructions,AGENT_TURN_STABLE_PREFIX} from '../opc/agentTurnPrompt';
import {freezeHistorySelection,HOST_TURN_DATA_NOTICE_V1,type HostTurnContext} from './hostTurn';
import {runtimeScopeInput} from './context';
import {OPENING_INPUT} from '../../shared/opcQuestions';
const skill='Pinned skill 正文';
vi.mock('../skills/databaseSource',()=>({databaseSkillSource:()=>({list:async()=>[{revisionId:'10000000-0000-4000-8000-000000000003'}]})}));
vi.mock('../skills/loader',()=>({identityOf:(value:unknown)=>value,activateSkill:async()=>({forModel:()=>skill})}));
vi.mock('./billingUnitAdmission',async original=>({
 ...(await original<typeof import('./billingUnitAdmission')>()),freezeWindowBillingUnit:async()=>undefined,
}));
const actor='10000000-0000-4000-8000-000000000001',modelId='10000000-0000-4000-8000-000000000002';
const revisionId='10000000-0000-4000-8000-000000000003',moduleId='10000000-0000-4000-8000-000000000004';
const requestId='10000000-0000-4000-8000-000000000005';
const host=()=>agentTurnInstructions({step:{id:'private-step',title:'Private title',schema:[]},question:null,
 questionLabel:null,workflowContext:{private:'user data'},opening:false});
function fixture(model='anthropic/test',write:string|undefined='2.5',real=true,inputBytes=32000){
 const providerLimits={providerSlug:'synthetic/fp8',contextTokens:32000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',
  requestUsd:'0',...(write===undefined?{}:{cacheWriteUsdPerMillion:write})};
 const quote={modelId,provider:'openrouter',account:'synthetic',model,protocol:'openrouter-chat-v1' as const,providerLimits,
  upperUsd:openRouterBound(providerLimits,100).upperUsd,inputLimit:32000,outputLimit:100,
  automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
 const row={id:modelId,model_id:model,is_active:'true',provider:real?'openrouter':'fixture',max_tokens:1000,input_limit:32000,
  config:pricingConfig(model,'synthetic/fp8','2','0')};
 const configReads=vi.fn();let saved:unknown=null;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:actor}},error:null};
  if(name==='runtime_admission_replay')return {data:saved,error:null};
  if(name==='runtime_admit'){
   saved={context:args.p_payload,billing:args.p_billing};return {data:saved,error:null};
  }
  throw new Error(name);
 });
 const admin={rpc,from:(table:string)=>{
  configReads(table);
  const query={select:()=>query,eq:()=>query,
   single:async()=>({data:table==='modules'?{id:moduleId,active:true,skill_id:moduleId,model_id:modelId}:row,error:null}),
   in:async()=>({data:[row],error:null})};return query;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const policy={...(real?{real:{id:actor,creditsPerUsd:'1000',multiplier:'1',expiresAt:'2030-01-01',callPolicies:[quote]}}:{}),
  account:'synthetic',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:100,inputBytes,historyItems:0,
  additionalInstructions:host(),stableAdditionalInstructions:AGENT_TURN_STABLE_PREFIX};
 const input={sessionId:actor,requestId,input:'user facts',network:'deny',selection:{kind:'skill',moduleId,revisionId}};
 return {service:runtimeAdmissionService(user,admin,policy),input,rpc,configReads,row,user,admin,policy};
}

const hostState:HostTurnContext={stepId:'step-1',opening:false,checklist:[]};
function hostFixture(model='anthropic/test') {
 const f=fixture(model),reasoning=configuredReasoning(f.row.model_id).reasoning;
 f.row.config.reasoning={...reasoning,catalog:reasoning.catalog!,route:reasoning.route!};
 return {...f,policy:{...f.policy,opcTurnToken:requestId,mentorStream:true,
  hostTurnContext:hostState,additionalInstructions:'Fixed checklist rules',stableAdditionalInstructions:'Fixed checklist rules'}};
}
it('freezes host, v2 selection and cache independently; replay ignores changed host/defaults',async()=>{
 const f=hostFixture(),service=runtimeAdmissionService(f.user,f.admin,f.policy);
 const result=await service.prepare(f.input),context=runtimeContext.parse(result.context);
 expect(context.hostTurnContext).toEqual(hostState);
 expect(context.inputSelection).toBe('scope-projection-v2');
 expect(context.historySelection).toEqual(freezeHistorySelection());
 expect(context.promptCache).toMatchObject({version:'prompt-cache-v2',historyMarker:true,systemPrefixChars:context.instructions.length});
 expect(context.instructions).toContain('complete public prose in message');
 const replay=await runtimeAdmissionService(f.user,f.admin,{...f.policy,hostTurnContext:{...hostState,stepId:'changed'}}).prepare(f.input);
 expect(replay).toEqual(result);
 expect(JSON.parse(runtimeScopeInput(context.input,context.scopeMaterial,context.hostTurnContext)).dataNotice).toBe(HOST_TURN_DATA_NOTICE_V1);
 for(const key of ['hostTurnContext','historySelection','inputSelection']){
  const broken={...context};delete broken[key as keyof typeof broken];
  expect(runtimeContext.safeParse(broken).success).toBe(false);
 }
});
it.each(['no-price','different-model','cache-off'] as const)('host structure survives %s',async mode=>{
 const f=hostFixture();
 if(mode==='no-price'){
  const quote=f.policy.real!.callPolicies[0]!;
  delete (quote.providerLimits as {cacheWriteUsdPerMillion?:string}).cacheWriteUsdPerMillion;
  quote.upperUsd=openRouterBound(quote.providerLimits,100).upperUsd;
 }
 if(mode==='different-model'){
  // Keep the synthetic pricing fixture coherent for Gemini; no remote lookup.
  f.row.model_id='google/gemini-test';
  const quote=f.policy.real!.callPolicies[0]!;quote.model=f.row.model_id;
  f.row.config=pricingConfig(f.row.model_id,'synthetic/fp8','2','0');
  const reasoning=configuredReasoning(f.row.model_id).reasoning;
  f.row.config.reasoning={...reasoning,catalog:reasoning.catalog!,route:reasoning.route!};
 }
 if(mode==='cache-off')f.policy.stableAdditionalInstructions='mismatched';
 const context=(await runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input)).context;
 expect(context).not.toHaveProperty('promptCache');
 expect(context.hostTurnContext).toEqual(hostState);
 expect(context.historySelection).toEqual(freezeHistorySelection());
 expect(context.instructions).toContain('Fixed checklist rules');
});
it.each(['opening','comparison','fallback'] as const)('omits only history marker for %s',async mode=>{
 const f=hostFixture();
 const input=mode==='opening'?OPENING_INPUT:mode==='comparison'?'compare previous version':'x'.repeat(13000);
 if(mode==='opening')f.policy.hostTurnContext={...hostState,opening:true};
 const result=await runtimeAdmissionService(f.user,f.admin,f.policy).prepare({...f.input,input});
 expect(result.context.promptCache).toMatchObject({version:'prompt-cache-v2',historyMarker:false});
});
it('rejects invalid or oversized host state before admit and reserves 150 even without caching',async()=>{
 const f=hostFixture();
 await expect(runtimeAdmissionService(f.user,f.admin,{...f.policy,hostTurnContext:{...hostState,extra:true} as HostTurnContext})
  .prepare(f.input)).rejects.toThrow('RUNTIME_CONTEXT_INVALID');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});
vi.mock('./newWorkGate', async importOriginal => ({
 ...await importOriginal(), ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));
it('uses identical marker reservation at the admission byte boundary with and without cache',async()=>{
 const f=hostFixture();
 const context=(await runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input)).context;
 const {askQuestionToolBytes}=await import('./agentTools');
 const current=runtimeScopeInput(context.input,context.scopeMaterial,context.hostTurnContext);
 const edge=Buffer.byteLength(JSON.stringify({instructions:context.instructions,messages:[{role:'user',content:current}]}))+
  askQuestionToolBytes(true)+150+1024;
 for(const enabled of [true,false])for(const delta of [0,-1]){
  const sample=hostFixture();
  const service=runtimeAdmissionService(sample.user,sample.admin,{...sample.policy,inputBytes:edge+delta,
   stableAdditionalInstructions:enabled?sample.policy.additionalInstructions:'disabled'});
  if(delta<0)await expect(service.prepare(sample.input)).rejects.toThrow('RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY');
  else expect((await service.prepare(sample.input)).context.historySelection.markerReserveBytes).toBe(150);
 }
});
