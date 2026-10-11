/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {runtimeContext} from './runtimeContext';
import {openRouterRequestBody} from './providerRequest';
import {frozenReasoningFields,type ReasoningPolicy} from './reasoningPolicy';
import {openRouterBound} from '../bill2/openRouterPolicy';
import type {ReasoningConfig} from '../../shared/modelReasoning';
vi.mock('./billingUnitAdmission', async (original) => ({
  ...(await original<typeof import('./billingUnitAdmission')>()),
  freezeWindowBillingUnit: async () => ({ version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', models: {}, providers: {}, hash: 'f'.repeat(64) }),
}));
// Skill discovery is covered in matching.test.ts; only the admitted format matters here.
vi.mock('./matching', async original => ({...(await original<typeof import('./matching')>()),discoverRuntimeCandidates:async()=>[]}));
vi.mock('./newWorkGate', async importOriginal => ({
 ...await importOriginal<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates,
}));
// Staging free chat: ordinary turns freeze the administrator's interactive reasoning on the
// already-evidenced serial-tools-v6-reasoning format instead of the unevidenced serial-tools-v2.
const actor='10000000-0000-4000-8000-000000000001',sessionId='10000000-0000-4000-8000-000000000002';
const dialogue='10000000-0000-4000-8000-000000000003',unset='10000000-0000-4000-8000-000000000004';
const organizer='10000000-0000-4000-8000-000000000005',requestId='10000000-0000-4000-8000-000000000006';
const nextId='10000000-0000-4000-8000-000000000007';
const low={mode:'effort',effort:'low',wire:'reasoning_effort'} as const;
type ModelConfig={pricing:unknown;reasoning?:ReasoningConfig};
type Admitted={executionId:string;context:Record<string,unknown>;billing:Record<string,unknown>};
function fixture(real=true){
 const models:Array<{id:string;model_id:string;config:ModelConfig}>=[
  {id:dialogue,model_id:'synthetic/dialogue',config:configuredReasoning('synthetic/dialogue',low)},
  {id:unset,model_id:'synthetic/unset',config:{pricing:configuredReasoning('synthetic/unset').pricing}},
  {id:organizer,model_id:'synthetic/organizer',config:configuredReasoning('synthetic/organizer',{mode:'off',wire:'reasoning'},'organize')}];
 for(const m of models)Object.assign(m,{provider:real?'openrouter':'fixture',is_active:'true',max_tokens:8192,input_limit:32000});
 const frozen=new Map<string,Admitted>();let reads=0;
 const rpc=vi.fn(async(name:string,args:{p_request_id:string;p_payload:Record<string,unknown>;p_billing:Admitted['billing']})=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:sessionId},
   dialogueModelId:dialogue,dialogueModel:'synthetic/dialogue'},error:null};
  if(name==='runtime_admission_replay')return {data:frozen.get(args.p_request_id)??null,error:null};
  if(name==='runtime_admit'){
   const result={executionId:args.p_request_id,context:structuredClone(args.p_payload),billing:structuredClone(args.p_billing)};
   frozen.set(args.p_request_id,result);return {data:result,error:null};
  }
  throw new Error(name);
 });
 const settings=[{key:'v3_summary_model_id',value:organizer},{key:'v3_summary_max_tokens',value:'4096'}];
 const admin={rpc,from:(table:string)=>{
  let id='';const q={select:()=>q,eq:(_key:string,value:string)=>{id=value;return q;},maybeSingle:async()=>({data:null,error:null}),
   single:async()=>{reads++;return {data:models.find(m=>m.id===id),error:null};},
   in:async()=>({data:table==='ai_models'?models:settings,error:null})};return q;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const quotes=models.map(m=>{
  const providerLimits={providerSlug:'synthetic/fp8',contextTokens:32000,promptUsdPerMillion:'0.1',completionUsdPerMillion:'0.1',requestUsd:'0'};
  return {modelId:m.id,provider:'openrouter',account:'synthetic',model:m.model_id,protocol:'openrouter-chat-v1' as const,providerLimits,
   upperUsd:openRouterBound(providerLimits,8192).upperUsd,inputLimit:32000,outputLimit:8192,
   automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
 });
 const policy={...(real?{real:{id:sessionId,creditsPerUsd:'1000',multiplier:'1',expiresAt:'2030-01-01',callPolicies:quotes}}:{}),
  account:'synthetic',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,maxOutputTokens:8192,inputBytes:32000,historyItems:10};
 const service=runtimeAdmissionService(user,admin,policy);
 const input={sessionId,requestId,input:'Synthetic free question',selection:{kind:'ordinary' as const,modelId:dialogue},network:'deny'};
 return {models,service,input,frozen,rpc,quotes,reads:()=>reads};
}
const sdk=(model:string,reasoning:ReasoningPolicy|undefined)=>JSON.stringify({model,
 messages:[{role:'user',content:'Synthetic free question'}],...(reasoning?frozenReasoningFields(reasoning):{})});

it('real free chat freezes v6 with the configured interactive reasoning and binds it into provider bytes',async()=>{
 const f=fixture();
 const admitted=await f.service.prepare(f.input);
 const context=runtimeContext.parse(admitted.context);
 expect(context).toMatchObject({role:'ordinary',providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low'}});
 expect(context).not.toHaveProperty('attachedOrganizer');
 expect(admitted.billing.sourceHash).toBe(createHash('sha256').update(JSON.stringify(admitted.context)).digest('hex'));
 const policy=f.quotes[0]!;
 const sent=JSON.parse(openRouterRequestBody(sdk(context.model,context.reasoning),{context,policy,phase:'ordinary',primaryDialogue:true}));
 expect(sent.reasoning_effort).toBe('low');expect(sent.stream).toBe(false);
 // The SDK request must carry exactly the frozen setting.
 expect(()=>openRouterRequestBody(sdk(context.model,undefined),{context,policy,phase:'ordinary',primaryDialogue:true}))
  .toThrow('RUNTIME_PROVIDER_BINDING_DENIED');
 // Replay bypasses later configuration changes and keeps the original bytes.
 const bytes=JSON.stringify(admitted),reads=f.reads();
 f.models[0]!.config=configuredReasoning('synthetic/dialogue',{mode:'effort',effort:'high',wire:'reasoning_effort'});
 expect(JSON.stringify(await f.service.prepare(f.input))).toBe(bytes);expect(f.reads()).toBe(reads);
});

it('real free chat fails closed before any reservation when interactive reasoning is unset or on another route',async()=>{
 const f=fixture();
 await expect(f.service.prepare({...f.input,selection:{kind:'ordinary',modelId:unset}})).rejects.toThrow('RUNTIME_REASONING_NOT_CONFIGURED');
 f.models[0]!.config.reasoning!.route='synthetic/fp16';
 await expect(f.service.prepare({...f.input,requestId:nextId})).rejects.toThrow('RUNTIME_REASONING_ROUTE_MISMATCH');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

it('an already frozen v2 free chat replays byte-identically without reading current reasoning',async()=>{
 const f=fixture();
 const context={providerRequestFormat:'serial-tools-v2',role:'ordinary',request:{...f.input,sources:[]},tools:[],maxTurns:1};
 const old={executionId:requestId,context,billing:{limits:{maxCalls:1},
  sourceHash:createHash('sha256').update(JSON.stringify(context)).digest('hex')}};
 const bytes=JSON.stringify(old);f.frozen.set(requestId,old);
 f.models[0]!.config={pricing:configuredReasoning('synthetic/dialogue').pricing};
 expect(JSON.stringify(await f.service.prepare(f.input))).toBe(bytes);
 expect(f.reads()).toBe(0);expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
});

it('attached organizer keeps its own organize reasoning while the free-chat turn uses interactive',async()=>{
 const f=fixture();
 const admitted=await f.service.prepare({...f.input,organizeAfter:true});
 expect(admitted.context).toMatchObject({providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low'},
  attachedOrganizer:{modelId:organizer,reasoning:{parameter:'reasoning',value:{enabled:false}}}});
 const context=runtimeContext.parse(admitted.context),organizerPolicy=f.quotes[2]!;
 const attached=JSON.parse(openRouterRequestBody(sdk(organizerPolicy.model,context.attachedOrganizer!.reasoning),
  {context,policy:organizerPolicy,phase:'attached_organizer',primaryDialogue:false}));
 expect(attached.reasoning).toEqual({enabled:false});expect(attached).not.toHaveProperty('reasoning_effort');
});

it('standalone organizer semantics are unchanged by the free-chat format',async()=>{
 const f=fixture();
 const admitted=await f.service.prepare({...f.input,selection:{kind:'organizer'}});
 expect(admitted.context).toMatchObject({role:'organizer',providerRequestFormat:'serial-tools-v6-reasoning',
  reasoning:{parameter:'reasoning',value:{enabled:false}}});
});

it.each([['auto',true],['ordinary',false]] as const)('%s (real=%s) keeps its original format and no reasoning',async(kind,real)=>{
 const f=fixture(real);
 const admitted=await f.service.prepare({...f.input,selection:{kind,modelId:dialogue}});
 expect(admitted.context.providerRequestFormat).toBe(real?'serial-tools-v2':undefined);
 expect(admitted.context).not.toHaveProperty('reasoning');
});
