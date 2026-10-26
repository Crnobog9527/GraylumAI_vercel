/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {Session} from '@openai/agents';
import {runtimeAdmissionService} from '../runtime/admission';
import {runtimeContext} from '../runtime/runtimeContext';
import {runRuntime} from '../runtime/runner';
import {openRouterRequestBody} from '../runtime/providerRequest';
import {runtimePaygCall} from '../runtime/paygRuntime';
import {openRouterBound,openRouterCallBound} from '../bill2/openRouterPolicy';
import {decimal} from '../bill2/decimal';
import type {FrozenPaygRun} from '../bill2/service';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {REVIEW_PROMPT} from './reviews';
const extensions=vi.hoisted(()=>({catalog:vi.fn(),research:vi.fn()}));
vi.mock('../runtime/skillCatalog',async original=>({...(await original<typeof import('../runtime/skillCatalog')>()),
 discoverSkillCatalog:extensions.catalog}));
vi.mock('../runtime/freeChatResearch',async original=>({...(await original<typeof import('../runtime/freeChatResearch')>()),
 attachFreeChatResearch:extensions.research}));
vi.mock('../runtime/newWorkGate',()=>({readAdmissionSettings:async()=>({ok:true}),
 newWorkGate:()=>({message:async()=>({ok:true})}),requireNewWork:()=>{}}));
vi.mock('../models/openRouterKey',()=>({readOpenRouterKeyOrUnset:async()=>undefined}));
vi.mock('../runtime/paygHostPolicy',async original=>({...(await original<typeof import('../runtime/paygHostPolicy')>()),
 readPaygHostPolicies:async(_db:unknown,_real:unknown,quotes:unknown[])=>quotes}));
vi.mock('../runtime/paygPricing',()=>({freezeStagingPaygPricing:async(_db:unknown,quotes:unknown[])=>quotes}));
vi.mock('../runtime/billingUnitAdmission',async original=>({...(await original<typeof import('../runtime/billingUnitAdmission')>()),
 freezeWindowBillingUnit:async()=>({version:'bill-unit-v2',creditsPerUsd:'100',defaultMultiplier:'3',
  providers:{},models:{'10000000-0000-4000-8000-000000000003':{multiplier:'3',source:'global'}},hash:'a'.repeat(64)})}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(price='2.5',completion='10',purposeBudgets=true){
 extensions.catalog.mockClear();extensions.research.mockClear();
 extensions.catalog.mockResolvedValue([{name:'Small skill',description:'A tiny published skill',moduleId:id(20),skillId:id(21),
  packageId:id(21),revisionId:id(22),packageHash:'c'.repeat(64),resultBytes:20}]);
 extensions.research.mockImplementation(async()=>{throw new Error('REVIEW_RESEARCH_MUST_NOT_RUN');});
 const model='anthropic/claude-sonnet-5.5';
 const limits={providerSlug:'anthropic',contextTokens:1000000,promptUsdPerMillion:price,
  completionUsdPerMillion:completion,requestUsd:'0'};
 const quote={modelId:id(3),model,provider:'openrouter',account:'synthetic',protocol:'openrouter-chat-v1' as const,
  providerLimits:limits,upperUsd:openRouterBound(limits,32768).upperUsd,inputLimit:196608,outputLimit:32768,
  multiplier:'3',automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true,
  payg:{version:'synthetic',policyId:'synthetic',profileVersion:'synthetic',evidenceVersion:'synthetic',
   admissionPath:'empirical' as const,templateTokens:4096,marginTokens:4096,maxBytes:196608,maxMessages:128,
   maxTools:2,maxSchemaBytes:16384,purposes:['ordinary'],expiresAt:'2099-01-01T00:00:00Z',
   pricingHash:'a'.repeat(64),endpointTag:'anthropic',nominalPricing:{version:'nominal-v1' as const,
    pricingHash:'a'.repeat(64),endpointTag:'anthropic',tiers:[{minPromptTokens:0,prompt:price,completion,request:'0'}],timeOfDay:[]}}};
 const config=configuredReasoning(model,{mode:'effort',effort:'low',wire:'reasoning_effort'});
 config.reasoning.route='anthropic';config.reasoning.catalog!.endpoints[0]!.tag='anthropic';
 const row={id:id(3),model_id:model,provider:'openrouter',is_active:'true',input_limit:1000000,max_tokens:32768,config};
 const settings=[{key:purposeBudgets?'runtime_purpose_budgets':'unused_budget',value:{version:2,interactive:{inputBytes:90000,historyItems:100},
  organize:{inputBytes:64000,historyItems:100},report:{inputBytes:196608,historyItems:0}}},
  {key:'chat_my_posts_enabled',value:true},{key:'publish_monitor_enabled',value:true},
  {key:'library_agent_read_enabled',value:true},{key:'chat_library_retrieval_enabled',value:true},{key:'chat_research_tools_enabled',value:true}];
 const saved=new Map<string,{executionId:string}>();let billing:FrozenPaygRun;let context:unknown;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='publish_monitor_review_step')return {data:{allowed:true,actorId:id(1)},error:null};
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:id(8)}},error:null};
  if(name==='runtime_admission_replay')return {data:saved.get(String(args.p_request_id))??null,error:null};
  if(name==='runtime_workspace_session')return {data:true,error:null};
  if(name==='runtime_workspace_post_window')return {data:90,error:null};
  if(name==='runtime_admit'){
   billing=args.p_billing as FrozenPaygRun;context=args.p_payload;
   const result={executionId:id(10)};saved.set(String(args.p_request_id),result);return {data:result,error:null};
  }
  throw new Error(name);
 });
 const from=(table:string)=>{const data=table==='ai_models'?row:table==='profiles'?{reply_language:'zh-Hans'}:settings;
  const q={select:()=>q,eq:()=>q,single:async()=>({data,error:null}),in:async()=>({data:Array.isArray(data)?data:[data],error:null})};return q;};
 const db={rpc,from} as unknown as SupabaseClient;
 const policy={real:{id:id(5),creditsPerUsd:'100',multiplier:'3',expiresAt:'2099-01-01T00:00:00Z',callPolicies:[quote]},
  paygHost:true,purposeBudgets:true,account:'synthetic',costPerCall:'0.02',creditsPerUsd:'100',multiplier:'3',
  maxCalls:3,maxOutputTokens:1000,inputBytes:32000,historyItems:0,workspaceContext:true,
  weeklyReview:{id:id(6),token:id(7),maxCostUsd:'0.30'}};
 const request={sessionId:id(2),requestId:id(4),input:REVIEW_PROMPT,selection:{kind:'ordinary',modelId:id(3)},network:'deny'};
 const admission=runtimeAdmissionService(db,db,policy);
 return {admission,request,quote,rpc,get:()=>({billing:billing!,context:runtimeContext.parse(context)})};
}
it('Sonnet admits two bounded calls under $0.30, freezes the computed BILL2 budget, and replays unchanged',async()=>{
 const f=fixture();await f.admission.prepare(f.request);
 const {billing,context}=f.get();
 expect(context.maxOutputTokens).toBe(1000);expect(context.reasoning).toEqual({parameter:'none'});
 expect(context.purposeBudget).toMatchObject({inputBytes:32000,historyItems:0});
 expect(context.historyItems).toBe(0);expect(context.maxTurns).toBe(2);
 expect(context.tools).toEqual(['read_source']);expect(context.libraryRetrieval).toBeUndefined();
 expect(context.research).toBeUndefined();expect(context.skillCatalog).toBeUndefined();
 expect(extensions.catalog).not.toHaveBeenCalled();expect(extensions.research).not.toHaveBeenCalled();
 const upper=openRouterCallBound(f.quote.providerLimits,1000,32000+4096+4096).upperUsd;
 expect(upper).toBe('0.110480000000');
 expect(billing.limits.maxCalls).toBe(2);expect(decimal(billing.limits.costUsd)).toBe(decimal(upper)*2n);
 expect(decimal(billing.limits.costUsd)).toBeLessThanOrEqual(decimal('0.30'));
 expect(billing.callPolicy).toEqual([f.quote]); // Approved quote and unit prices remain intact.
 expect(await f.admission.prepare(f.request)).toEqual({executionId:id(10)});
 expect(f.rpc.mock.calls.filter(([name])=>name==='runtime_admit')).toHaveLength(1);
});
it('the real SDK request and BILL2 per-call quote use 1000 tokens, reading the source then retaining the length-limited final answer',async()=>{
 const f=fixture();await f.admission.prepare(f.request);const {billing,context}=f.get();
 const requests:string[]=[];
 const session:Session={getSessionId:async()=> 'synthetic',getItems:async()=>[],addItems:async()=>{},
  popItem:async()=>undefined,clearSession:async()=>{}};
 const result=await runRuntime({model:context.model,instructions:context.instructions,input:context.input,session,
  maxOutputTokens:context.maxOutputTokens,maxTurns:context.maxTurns,reasoning:context.reasoning,
  tools:[{name:'read_source',description:'Read saved performance',execute:async()=>JSON.stringify({kind:'my_posts',review:{rows:[]}})}],
  selectHistory:async(_h,incoming)=>incoming,exchange:async(_sequence,body)=>{
   const request=openRouterRequestBody(body,{context,policy:billing.callPolicy[0]!,phase:'ordinary',primaryDialogue:true});
   requests.push(request);expect(JSON.parse(request).max_tokens).toBe(1000);
   expect(JSON.parse(request)).not.toHaveProperty('reasoning_effort');expect(JSON.parse(request)).not.toHaveProperty('reasoning');
   const {call}=runtimePaygCall(request,'ordinary',billing.callPolicy[0]!,billing.rules,1,true);
   expect(call.outputLimit).toBe(1000);
   expect(call.upperUsd).toBe(openRouterCallBound(f.quote.providerLimits,1000,call.payg!.promptTokensUpper).upperUsd);
   expect(decimal(call.upperUsd)*2n).toBeLessThanOrEqual(decimal(billing.limits.costUsd));
   if(requests.length===1)return JSON.stringify({id:'synthetic-source',object:'chat.completion',model:context.model,
    choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{
     id:'source-read',type:'function',function:{name:'read_source',arguments:'{"query":"my_posts:90"}'}}]}}],
    usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}});
   return JSON.stringify({id:'synthetic',object:'chat.completion',model:context.model,
    choices:[{index:0,finish_reason:'length',message:{role:'assistant',content:'预算内的截断正文'}}],
    usage:{prompt_tokens:100,completion_tokens:1000,total_tokens:1100}});
  }});
 expect(result).toBe('预算内的截断正文');expect(requests).toHaveLength(2);
});
it('a very expensive model still refuses before admission without changing its approved quote',async()=>{
 const f=fixture('100','100');const original=structuredClone(f.quote);
 await expect(f.admission.prepare(f.request)).rejects.toThrow('PUBLISH_MONITOR_REVIEW_CAP_TOO_LOW');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);expect(f.quote).toEqual(original);
});

it('missing global purpose settings still freeze review input/output limits, and cheap models stay within three calls',async()=>{
 const f=fixture('0.1','0.1',false);await f.admission.prepare(f.request);
 const {billing,context}=f.get();
 expect(context.purposeBudget).toMatchObject({inputBytes:32000,historyItems:0});
 expect(context.maxOutputTokens).toBe(1000);expect(context.maxTurns).toBe(3);expect(billing.limits.maxCalls).toBe(3);
});
