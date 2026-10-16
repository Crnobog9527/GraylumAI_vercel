/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-3b PR-3: the real admission path of a positioning mentor turn on a PAYG v2 run, with and without research.
import {expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {runtimeContext} from './runtimeContext';
import {openRouterBound} from '../bill2/openRouterPolicy';
import type {FrozenPaygRun} from '../bill2/service';
import {toolCallPolicies} from '../bill2/runPolicies';
import {RESEARCH_PHASE} from './researchTurn';
import {DISABLED_RESEARCH_TOOLS,researchToolsConfigSchema} from '../research/vendors/config';
import {POSITIONING_RESEARCH_TOOLS} from '../research/tools/schemas';
import {tikhubRouteId} from '../research/vendors/tikhub';
import {FIRECRAWL_ROUTE} from '../research/vendors/firecrawl';
import {OPENING_INPUT} from '../../shared/opcQuestions';
vi.mock('./newWorkGate',async original=>({...await original<typeof import('./newWorkGate')>(),
 ...(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates}));
vi.mock('../skills/databaseSource',()=>({databaseSkillSource:()=>({list:async()=>[{revisionId}]})}));
vi.mock('../skills/loader',()=>({identityOf:(value:unknown)=>value,activateSkill:async()=>({forModel:()=>'Pinned skill'})}));
const actor='10000000-0000-4000-8000-000000000001',modelId='10000000-0000-4000-8000-000000000002';
const revisionId='10000000-0000-4000-8000-000000000003',moduleId='10000000-0000-4000-8000-000000000004';
const requestId='10000000-0000-4000-8000-000000000005';
const now=Date.now(),day=86_400_000;
const limits={providerSlug:'local',contextTokens:300000,promptUsdPerMillion:'1',completionUsdPerMillion:'2',requestUsd:'0'};
const modelPolicy:FrozenPaygRun['callPolicy'][number]={modelId,model:'fixture/mentor',provider:'fixture',account:'local',
 protocol:'fixture-cost-v1',inputLimit:64000,outputLimit:100,upperUsd:openRouterBound(limits,100).upperUsd,providerLimits:limits,
 multiplier:'6',automaticRetry:false,hiddenTools:false,lookupSupported:true,
 payg:{policyId:'fixture',version:'1',profileVersion:'1',evidenceVersion:'1',pricingHash:'a'.repeat(64),endpointTag:'local',
  templateTokens:4096,marginTokens:4096,admissionPath:'fixture',maxBytes:196608,maxMessages:64,maxTools:9,maxSchemaBytes:16384,
  purposes:['skill'],expiresAt:'2099-01-01T00:00:00Z',nominalPricing:{version:'nominal-v1',pricingHash:'a'.repeat(64),endpointTag:'local',
   tiers:[{minPromptTokens:0,prompt:'1',completion:'2',request:'0'}],timeOfDay:[]}}};
const billingUnit={version:'bill-unit-v2' as const,creditsPerUsd:'100',defaultMultiplier:'6',providers:{},hash:'b'.repeat(64),
 models:{[modelId]:{multiplier:'6',source:'global' as const}}};
const routes=[...(['keyword_posts','account_profile','account_posts'] as const).map(kind=>({platform:'tiktok',kind,vendor:'tikhub',
 route:tikhubRouteId('tiktok',kind)!,backup:null,maxUnitsPerCall:'1'})),
 {platform:'web',kind:'web_search',vendor:'parallel',route:'parallel:search:fast',backup:null,maxUnitsPerCall:'1'},
 {platform:'web',kind:'web_fetch',vendor:'firecrawl',route:FIRECRAWL_ROUTE,backup:null,maxUnitsPerCall:'1'}];
const price=(provider:string,route:string|null,usageUnit:string)=>({provider,route,appliesToUnlistedRoutes:route===null,currency:'USD',
 usageUnit,unitsPerPrice:'1',price:'0.01',usdPerCurrency:null,fxSourceUrl:null,fxEffectiveAt:null,fxValidUntil:null,pricingBasis:'list',
 sourceUrl:'https://example.com/p',evidenceHash:'a'.repeat(64),verifiedAt:new Date(now-day).toISOString(),
 validUntil:new Date(now+7*day).toISOString(),chargeCondition:'per call',includedInReceipt:false,priceMultiplier:null});
function researchConfig(enabled:boolean){
 const vendor={enabled:true,hardCapAttested:{by:actor,at:new Date(now).toISOString()}};
 return {...researchToolsConfigSchema.parse({...DISABLED_RESEARCH_TOOLS,enabled,vendors:{tikhub:vendor,parallel:vendor,firecrawl:vendor},
  verifiedPlatforms:['tiktok'],benchmarkPlatforms:['tiktok'],routes,limits:{maxSubcallsPerRound:20,discoverSubcalls:25}}),
  revision:2,updatedBy:actor,updatedAt:new Date(now).toISOString()};
}
function fixture(enabled:boolean){
 const settings:Record<string,unknown>={research_tools_config:researchConfig(enabled),
  billing_provider_prices:{version:1,entries:[price('tikhub',null,'call'),price('parallel','parallel:search:fast','sku_search'),
   price('firecrawl',FIRECRAWL_ROUTE,'credit')]},
  billing_payg_start_thresholds:{version:'v1',thresholds:routes.map(r=>({model:`${r.vendor}:${r.route}`,purpose:RESEARCH_PHASE,credits:1}))}};
 let saved:unknown=null;
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:actor}},error:null};
  if(name==='runtime_admission_replay')return {data:saved,error:null};
  if(name==='runtime_admit'){saved={context:args.p_payload,billing:args.p_billing};return {data:saved,error:null};}
  throw new Error(name);
 });
 const row={id:modelId,model_id:'fixture/mentor',is_active:'true',provider:'fixture',max_tokens:1000,input_limit:64000};
 const admin={rpc,from:(table:string)=>{
  let key='';
  const query={select:()=>query,eq:(_column:string,value:string)=>{key=value;return query;},in:async()=>({data:[],error:null}),
   maybeSingle:async()=>({error:null,data:settings[key]===undefined?null:{value:settings[key],revision:'2'}}),
   single:async()=>({data:table==='modules'?{id:moduleId,active:true,skill_id:moduleId,model_id:modelId}:row,error:null})};
  return query;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const policy={account:'local',costPerCall:'0.02',creditsPerUsd:'100',multiplier:'6',maxCalls:1,maxOutputTokens:100,inputBytes:64000,
  historyItems:0,opcTurnToken:requestId,mentorStream:true,hostTurnContext:{stepId:'step-1',opening:false,checklist:[]},
  researchTools:true,payg:{callPolicies:[modelPolicy],billingUnit}};
 const input={sessionId:actor,requestId,input:'帮我找对标账号',network:'deny',selection:{kind:'skill',moduleId,revisionId}};
 return {admin,user,policy,input,rpc};
}
const researchNames=new Set<string>(POSITIONING_RESEARCH_TOOLS);

it('with the research switch off the frozen request carries no research tool and the run no tool price',async()=>{
 const f=fixture(false);
 const admitted=await runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input);
 const context=runtimeContext.parse(admitted.context);
 expect(context.tools).toEqual(['ask_question']);
 expect(context.tools.some(name=>researchNames.has(name))).toBe(false);
 expect(context.research).toBeUndefined();
 expect(context).toMatchObject({maxTurns:1,maxToolCalls:1});
 expect(toolCallPolicies(admitted.billing.callPolicy)).toEqual([]);
 expect(admitted.billing.limits.maxCalls).toBe(1);
});

it('with the switch on the mentor turn freezes the tools, one reply call, the subcall allowance and the prices',async()=>{
 const f=fixture(true);
 const admitted=await runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input);
 const context=runtimeContext.parse(admitted.context);
 expect(context.tools).toEqual(['ask_question',...POSITIONING_RESEARCH_TOOLS]);
 expect(context).toMatchObject({maxTurns:2,maxToolCalls:2,research:{subcalls:20,phase:RESEARCH_PHASE,configRevision:2}});
 const tools=toolCallPolicies(admitted.billing.callPolicy);
 expect(tools.map(p=>p.model).sort()).toEqual(routes.map(r=>`${r.vendor}:${r.route}`).sort());
 expect(admitted.billing).toMatchObject({contractVersion:'bill2.v2',limits:{maxCalls:1+1+20}});
 // The source hash covers the context with the research slot.
 const {createHash}=await import('node:crypto');
 expect(admitted.billing.sourceHash).toBe(createHash('sha256').update(JSON.stringify(admitted.context)).digest('hex'));
});

it('openings and hosts that did not ask for research never get the tools, even with the switch on',async()=>{
 const opening=fixture(true);
 const first=await runtimeAdmissionService(opening.user,opening.admin,{...opening.policy,organizeOpening:false,
  hostTurnContext:{stepId:'step-1',opening:true,checklist:[]}}).prepare({...opening.input,input:OPENING_INPUT});
 expect(first.context.tools).toEqual([]);
 const other=fixture(true);
 const plain=await runtimeAdmissionService(other.user,other.admin,{...other.policy,researchTools:false}).prepare(other.input);
 expect(plain.context.tools).toEqual(['ask_question']);
 expect(toolCallPolicies(plain.billing.callPolicy)).toEqual([]);
});
