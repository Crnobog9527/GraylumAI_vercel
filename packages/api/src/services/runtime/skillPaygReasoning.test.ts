/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterEach,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {packageHash,sha256} from '../skills/loader';
import {pricingConfig} from '../__tests__/fixtures/runtimePricing';
import {configuredReasoning} from '../__tests__/fixtures/runtimeReasoning';
import {openRouterBound} from '../bill2/openRouterPolicy';
import type {PaygHostProfile} from './paygHostPolicy';
// The real readPaygHostPolicies decides admission here; only pricing/billing-unit freezing is stubbed.
vi.mock('./paygPricing',()=>({freezeStagingPaygPricing:async(_admin:unknown,policies:{payg:unknown}[])=>policies.map(p=>({...p,
 payg:{...p.payg as object,pricingHash:'a'.repeat(64)}}))}));
vi.mock('./newWorkGate',async original=>({...await original<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates}));
vi.mock('./billingUnitAdmission',async original=>({...(await original<typeof import('./billingUnitAdmission')>()),
 freezeWindowBillingUnit:async()=>({version:'bill-unit-v2',creditsPerUsd:'100',defaultMultiplier:'3',models:{},providers:{},hash:'f'.repeat(64)})}));
vi.mock('../skills/databaseSource',()=>({databaseSkillSource:()=>({list:async()=>[descriptor],state:async()=> 'enabled'})}));
vi.mock('../skills/loader',async original=>({...await original<typeof import('../skills/loader')>(),
 activateSkill:async()=>({forModel:()=>'Synthetic document Skill'})}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const base={packageId:id(7),revisionId:id(8),directoryName:'synthetic-script',files:[{
 path:'SKILL.md',bytes:0,sha256:sha256(''),mediaType:'text/markdown' as const,requires:[]}],tasks:{},requiredCapabilities:[]};
const descriptor={...base,packageHash:packageHash(base)};
const env={VERCEL:'1',VERCEL_PROJECT_PRODUCTION_URL:'auth-staging.graylum.com',
 VERCEL_GIT_COMMIT_REF:'staging',VERCEL_GIT_REPO_OWNER:'Crnobog9527',VERCEL_GIT_REPO_SLUG:'GraylumAI_vercel',
 VERCEL_PROJECT_ID:'fixture-project',V3_RUNTIME_STAGING_PROJECT_ID:'fixture-project',
 V3_RUNTIME_STAGING_DATABASE_HOST:'fixture.supabase.co',NEXT_PUBLIC_SUPABASE_URL:'https://fixture.supabase.co',
 V3_RUNTIME_STAGING_WINDOW_ID:id(5),V3_RUNTIME_STAGING_ENABLED:'true'};
afterEach(()=>vi.unstubAllEnvs());
// Synthetic evidence in the staging shape: Gemini has only the low variant, Sonnet has none and low.
function profile(model:string,tag:string,variants:PaygHostProfile['reasoningVariants'][number]['reasoning'][]):PaygHostProfile{
 return {model,endpointTag:tag,protocol:'openrouter-chat-v1',profileVersion:'test-only',evidenceVersion:'test-only',admissionPath:'empirical',
  templateTokens:4096,marginTokens:4096,maxBytes:196608,maxMessages:128,maxTools:3,maxSchemaBytes:16384,
  purposes:['skill','report','ordinary','skill_matching'],
  requestFormats:['agent-turn-v5-stream','serial-tools-v4-stream','serial-tools-v6-reasoning'],
  reasoningVariants:variants.map(reasoning=>({reasoning,outputLimit:32768,testedOutputLimit:512,evidenceReference:'test-only',
   manifestHash:'b'.repeat(64),outputStressSamples:2,includesReasoning:true as const})),
  outputLimit:32768,expiresAt:'2099-01-01T00:00:00Z',
  evidence:{reference:'test-only',manifestHash:'a'.repeat(64),distinctSamples:60,messageStressSamples:12,maxVerifiedMessages:128,
   completeCells:15,variantsPerCell:4,maxPromptToBytes:0.5,maxPromptToUpper:0.4,outputLimit:32768,testedOutputLimit:512,
   outputSemantics:'max-tokens-includes-reasoning',includesReasoning:true,cacheCovered:true,costBoundPassed:true}};
}
function fixture(model:string,tag:string){
 for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
 const providerLimits={providerSlug:tag,contextTokens:1000000,promptUsdPerMillion:'1',completionUsdPerMillion:'1',requestUsd:'0'};
 const quote={modelId:id(3),model,provider:'openrouter',account:'synthetic',protocol:'openrouter-chat-v1' as const,
  providerLimits,upperUsd:openRouterBound(providerLimits,32768).upperUsd,inputLimit:196608,outputLimit:32768,
  multiplier:'3',automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
 const settings={version:1,enabled:true,windowId:id(5),profiles:[
  profile('google/gemini-3.8-flash','google-ai-studio',[{effort:'low'}]),
  profile('anthropic/claude-sonnet-5.5','anthropic',[{parameter:'none'},{effort:'low'}])]};
 const reasoning=configuredReasoning(model,{mode:'effort',effort:'low',wire:'reasoning_effort'}).reasoning;
 const modelRow={id:id(3),model_id:model,provider:'openrouter',is_active:'true',input_limit:1000000,max_tokens:32768,
  config:{...pricingConfig(model,tag,'1','1'),reasoning:{...reasoning,route:tag,
   catalog:{...reasoning.catalog!,endpoints:reasoning.catalog!.endpoints.map(e=>({...e,tag}))}}}};
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:id(2)}},error:null};
  if(name==='runtime_admission_replay')return {data:null,error:null};
  if(name==='runtime_admit')return {data:{executionId:String(args.p_request_id),context:args.p_payload,billing:args.p_billing},error:null};
  if(name==='model_identity_guard_config')return {data:{version:1,enabled:true,revision:0,updatedBy:null,updatedAt:null},error:null};
  throw new Error(name);
 });
 const admin={rpc,from:(table:string)=>{
  // DB-PERF PR-3: admission's one settings query carries the PAYG profile setting.
  const q={select:()=>q,eq:()=>q,in:async()=>({data:table==='system_settings'?[{key:'runtime_payg_staging',value:settings}]:[modelRow],error:null}),
   maybeSingle:async()=>({data:table==='system_settings'?{value:settings}:null,error:null}),
   single:async()=>({data:table==='modules'?{id:id(7),active:true,skill_id:id(7),model_id:id(3)}:modelRow,error:null})};
  return q;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:id(1),email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const policy={real:{id:id(5),creditsPerUsd:'100',multiplier:'3',expiresAt:'2099-01-01T00:00:00Z',callPolicies:[quote]},
  paygHost:true,account:'local',costPerCall:'1',creditsPerUsd:'100',multiplier:'3',maxCalls:2,
  maxOutputTokens:32768,inputBytes:90000,historyItems:10};
 const input={sessionId:id(2),requestId:id(4),input:'Write a short video script',network:'deny',
  selection:{kind:'skill' as const,moduleId:id(7),revisionId:id(8)}};
 return runtimeAdmissionService(user,admin,policy).prepare(input);
}
// #1026 step 4: a chosen document Skill bound to Gemini was refused RUNTIME_PAYG_PROFILE_REQUIRED, because
// admission froze reasoning none while the Gemini profile (reasoning is mandatory there) only evidences low.
it.each([['google/gemini-3.8-flash','google-ai-studio'],['anthropic/claude-sonnet-5.5','anthropic']])(
 'a chosen Skill on %s freezes the administrator interactive reasoning and passes the PAYG profile',async(model,tag)=>{
 const admitted=await fixture(model,tag);
 expect(admitted.context).toMatchObject({role:'skill',providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low'}});
 expect(admitted.billing).toMatchObject({contractVersion:'bill2.v2'});
});
