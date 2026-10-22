/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-6 (Owner 2026-10-17, "同意 RT-6 输入上限选 A"): only a mentor turn that offers the research tools gets the 112000-byte
// input ceiling; the real admission path decides with the raised ceiling and freezes it.
import {expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {runtimeContext} from './runtimeContext';
import {openRouterBound} from '../bill2/openRouterPolicy';
import type {FrozenPaygRun} from '../bill2/service';
import {RESEARCH_PHASE} from './researchTurn';
import {RESEARCH_TURN_INPUT_BYTES,sentHostBytes} from './researchAdmission';
import {hostTurnInput} from './hostTurn';
import {DISABLED_RESEARCH_TOOLS,researchToolsConfigSchema} from '../research/vendors/config';
import {tikhubRouteId} from '../research/vendors/tikhub';
import {FIRECRAWL_ROUTE} from '../research/vendors/firecrawl';
const switchRead=vi.hoisted(()=>({on:false}));
vi.mock('./newWorkGate',async original=>{
 const gates=(await import('../__tests__/fixtures/runtimeGates')).testAdmissionGates;
 return {...await original<typeof import('./newWorkGate')>(),...gates,
  readAdmissionSettings:async()=>({...await gates.readAdmissionSettings(),researchEnabled:switchRead.on})};
});
vi.mock('../skills/databaseSource',()=>({databaseSkillSource:()=>({list:async()=>[{revisionId}]})}));
const skill=vi.hoisted(()=>({text:'Pinned skill'}));
vi.mock('../skills/loader',()=>({identityOf:(value:unknown)=>value,activateSkill:async()=>({forModel:()=>skill.text})}));
const actor='10000000-0000-4000-8000-000000000001',modelId='10000000-0000-4000-8000-000000000002';
const revisionId='10000000-0000-4000-8000-000000000003',moduleId='10000000-0000-4000-8000-000000000004';
const requestId='10000000-0000-4000-8000-000000000005';
const now=Date.now(),day=86_400_000;
const limits={providerSlug:'local',contextTokens:300000,promptUsdPerMillion:'1',completionUsdPerMillion:'2',requestUsd:'0'};
const modelPolicy:FrozenPaygRun['callPolicy'][number]={modelId,model:'fixture/mentor',provider:'fixture',account:'local',
 protocol:'fixture-cost-v1',inputLimit:200000,outputLimit:100,upperUsd:openRouterBound(limits,100).upperUsd,providerLimits:limits,
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
function fixture(enabled:boolean,budgets=true,scopeMaterial?:unknown){
 const settings:Record<string,unknown>={research_tools_config:researchConfig(enabled),
  billing_provider_prices:{version:1,entries:[price('tikhub',null,'call'),price('parallel','parallel:search:fast','sku_search'),
   price('firecrawl',FIRECRAWL_ROUTE,'credit')]},
  runtime_purpose_budgets:{version:2,interactive:{inputBytes:90000,historyItems:100},organize:{inputBytes:64000,historyItems:100},
   report:{inputBytes:196608,historyItems:0}},
  billing_payg_start_thresholds:{version:'v1',thresholds:routes.map(r=>({model:`${r.vendor}:${r.route}`,purpose:RESEARCH_PHASE,credits:1}))}};
 let saved:unknown=null;
 const logs:unknown[]=[];
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:actor},...(scopeMaterial?{scopeMaterial}: {})},error:null};
  if(name==='runtime_admission_replay')return {data:saved,error:null};
  if(name==='research_user_cards')return {data:[{cardId:requestId,kind:'keywords',options:[],minSelect:1,maxSelect:5,
   confirmationId:modelId,items:['家居收纳']}],error:null};
  if(name==='research_benchmark_rows')return {data:{rows:[],hash:'c'.repeat(64)},error:null};
  if(name==='runtime_admit'){saved={context:args.p_payload,billing:args.p_billing};return {data:saved,error:null};}
  throw new Error(name);
 });
 const row={id:modelId,model_id:'fixture/mentor',is_active:'true',provider:'fixture',max_tokens:1000,input_limit:400000};
 const admin={rpc,from:(table:string)=>{
  let key='';
  const query={insert:(row:unknown)=>({abortSignal:async()=>{logs.push(row);return {error:null};}}),select:()=>query,eq:(_column:string,value:string)=>{key=value;return query;},in:async(_column:string,keys:string[])=>({data:table==='system_settings'
    ?keys.filter(key=>settings[key]!==undefined).map(key=>({key,value:settings[key]})):[],error:null}),
   maybeSingle:async()=>({error:null,data:settings[key]===undefined?null:{key,value:settings[key],revision:'2'}}),
   single:async()=>({data:table==='modules'?{id:moduleId,active:true,skill_id:moduleId,model_id:modelId}:row,error:null})};
  return query;
 }} as unknown as SupabaseClient;
 const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
 const policy={account:'local',costPerCall:'0.02',creditsPerUsd:'100',multiplier:'6',maxCalls:1,maxOutputTokens:100,inputBytes:64000,
  historyItems:0,opcTurnToken:requestId,mentorStream:true,hostTurnContext:{stepId:'step-1',opening:false,checklist:[]},
  researchTools:true,purposeBudgets:budgets,payg:{callPolicies:[modelPolicy],billingUnit}};
 const input={sessionId:actor,requestId,input:'帮我找对标账号',network:'deny',selection:{kind:'skill',moduleId,revisionId}};
 return {admin,user,policy,input,rpc,logs};
}

// The Skill instructions stand in for a long positioning step (the user text is capped at 20000 characters).
const admit=async(enabled:boolean,bytes:number,budgets=true)=>{
 skill.text='步'.repeat(Math.floor(bytes/3));
 const f=fixture(enabled,budgets);
 const admitted=await runtimeAdmissionService(f.user,f.admin,f.policy).prepare(f.input);
 return runtimeContext.parse(admitted.context);
};

it('a research turn that would not fit the 90000-byte interactive budget is admitted with the raised ceiling, frozen in the context',async()=>{
 // ~75 KB of instructions: the turn itself fits 90000, but not together with the ~31 KB research tools and result reserve.
 const context=await admit(true,75000);
 expect(context.research).toBeDefined();
 expect(context.purposeBudget).toMatchObject({purpose:'interactive',inputBytes:RESEARCH_TURN_INPUT_BYTES});
 expect(RESEARCH_TURN_INPUT_BYTES).toBe(112000);
});

it('every other turn keeps the interactive budget: switch off, or research that does not fit even the raised ceiling',async()=>{
 const off=await admit(false,75000);
 expect(off.research).toBeUndefined();
 expect(off.purposeBudget).toMatchObject({purpose:'interactive',inputBytes:90000});
 const tooLarge=await admit(true,84000);
 expect(tooLarge.research).toBeUndefined();
 expect(tooLarge.purposeBudget).toMatchObject({purpose:'interactive',inputBytes:90000});
});

it('a small research turn is frozen at the raised ceiling too, and without purpose budgets nothing is raised',async()=>{
 const small=await admit(true,300);
 expect(small.research).toBeDefined();
 expect(small.purposeBudget?.inputBytes).toBe(RESEARCH_TURN_INPUT_BYTES);
 const legacy=await admit(true,300,false);
 expect(legacy.purposeBudget).toBeUndefined();
});

it('with the switch on, the cards and benchmark table join the turn only together with the tools (#1070 review)',async()=>{
 switchRead.on=true;
 try{
  const attached=await admit(true,300);
  expect(attached.research).toBeDefined();
  expect(attached.hostTurnContext?.research?.cards).toEqual([{kind:'keywords',cardId:requestId,confirmationId:modelId,keywords:['家居收纳']}]);
  // Tools that cannot attach leave the ordinary turn exactly as it was: no block, no capacity refusal.
  const plain=await admit(true,84000);
  expect(plain.research).toBeUndefined();
  expect(plain.hostTurnContext?.research).toBeUndefined();
  expect(plain.purposeBudget?.inputBytes).toBe(90000);
 }finally{switchRead.on=false;}
});

it('the host block is measured as sent: serialized into the message, then escaped again by the request',async()=>{
 const before={stepId:'s',opening:false,checklist:[]};
 const after={...before,note:'含 "引号" 和 \\ 反斜杠'.repeat(40)};
 const request=(host:object)=>Buffer.byteLength(JSON.stringify([{role:'user',content:hostTurnInput('帮我找对标',undefined,host as never)}]));
 expect(sentHostBytes(after)-sentHostBytes(before)).toBe(request(after)-request(before));
 // A single serialization would undercount the escaped quotes and backslashes.
 expect(Buffer.byteLength(JSON.stringify(after))-Buffer.byteLength(JSON.stringify(before))).toBeLessThan(request(after)-request(before));
});

it('a 90000-byte first-step request keeps its saved facts and the next step receives every research tool',async()=>{
 const {captureHostContext}=await import('../opc/captureContext');
 const {runtimeScopeInput}=await import('./context');
 const {groundedCardToolBytes}=await import('./groundedCard');
 const {REPLY_LANGUAGE_INSTRUCTIONS}=await import('./primaryInstructions');
 const {POSITIONING_RESEARCH_TOOLS}=await import('../research/tools/schemas');
 const steps=[{id:'first',title:'First'},{id:'research',title:'Research'}];
 const schema=Array.from({length:7},(_,i)=>({id:`fact${i}`,title:`Fact ${i}`,required:true}));
 const values=Object.fromEntries(schema.map(field=>[field.id,{value:'中'.repeat(400),nature:'fact',status:'confirmed'}]));
 const fieldMeta=Object.fromEntries(schema.map(field=>[field.id,{source:'user',protected:true,basis:'user_statement',
  hasPendingSuggestion:false,createdAt:'2026-10-22T00:00:00Z',executionId:requestId,origin:'capture'}]));
 const information={first:{schema,values,meta:fieldMeta},research:{schema:[{id:'benchmark_findings',required:true,
  elicitation:'agent_proposal' as const}],values:{},meta:{}}};
 const scopeMaterial={sessionId:actor,revision:11,hash:'a'.repeat(64),content:{work:{roundId:actor,
  steps:{first:{information:values,fieldMeta,valid:true,body:'Prior summary'},research:{information:{},fieldMeta:{},valid:false}}}}};
 const original=structuredClone(scopeMaterial);
 const first=fixture(true,true,scopeMaterial);
 const firstHost=captureHostContext(steps,information,'first',false,undefined,{first:true});
 skill.text='S'.repeat(43000);
 const firstService=runtimeAdmissionService(first.user,first.admin,{...first.policy,hostTurnContext:firstHost});
 const measure=(context:ReturnType<typeof runtimeContext.parse>)=>Buffer.byteLength(JSON.stringify({
  instructions:context.instructions+REPLY_LANGUAGE_INSTRUCTIONS,
  messages:[{role:'user',content:runtimeScopeInput(context.input,context.scopeMaterial,context.hostTurnContext)}],
 }))+groundedCardToolBytes()+150+1024;
 // JSON escaping is part of the byte budget. All input stays within the existing 8000-character OPC limit.
 const baseline=await firstService.prepare({...first.input,input:'x'});
 const extra=90000-measure(runtimeContext.parse(baseline.context));
 const text='\u0001'.repeat(Math.floor(extra/7))+'x'.repeat(extra%7+1);
 expect(text.length).toBeLessThanOrEqual(8000);
 const full=fixture(true,true,scopeMaterial);
 const admittedFirst=await runtimeAdmissionService(full.user,full.admin,{...full.policy,hostTurnContext:firstHost})
  .prepare({...full.input,input:text});
 expect(measure(runtimeContext.parse(admittedFirst.context))).toBe(90000);
 expect(admittedFirst.context.research).toBeUndefined();
 // A fresh request in this same round, using the saved fields; no old session or historical linking.
 skill.text='S'.repeat(59133);
 const next=fixture(true,true,scopeMaterial);
 const host=captureHostContext(steps,information,'research',false,undefined,{first:true});
 const admitted=await runtimeAdmissionService(next.user,next.admin,{...next.policy,hostTurnContext:host})
  .prepare({...next.input,input:'请给我关键词确认卡'});
 const context=runtimeContext.parse(admitted.context);
 expect(context.tools).toEqual(['ask_question',...POSITIONING_RESEARCH_TOOLS]);
 expect(context.purposeBudget?.inputBytes).toBe(112000);
 expect(context.scopeMaterial).toEqual(original);
 expect(scopeMaterial).toEqual(original);
 expect(context.hostTurnContext?.materialProjection).toBe('checklist-dedup-v1');
 const {researchCapacity}=await import('./researchCapacity');
 const {researchToolBytes}=await import('./researchAdmission');
 const {RESEARCH_RESULT_RESERVE_BYTES}=await import('./researchTurn');
 const beforeHost={...context.hostTurnContext!};delete beforeHost.materialProjection;
 // The old composition really fails; this is not a small fixture that passed even before the fix.
 const oldComposition=researchCapacity({instructions:context.instructions+REPLY_LANGUAGE_INSTRUCTIONS,
  currentInput:runtimeScopeInput(context.input,context.scopeMaterial,beforeHost),inputBudgetBytes:112000,
  existingToolsBytes:groundedCardToolBytes()+150,researchToolsBytes:researchToolBytes(POSITIONING_RESEARCH_TOOLS,true),
  researchHostDeltaBytes:0,resultReserveBytes:RESEARCH_RESULT_RESERVE_BYTES});
 expect(oldComposition.deficitBytes).toBeGreaterThan(0);
});

it('a still-oversize required research turn records numeric components and creates no billable execution',async()=>{
 skill.text='S'.repeat(83000);
 const f=fixture(true);
 const host={stepId:'research',opening:false,checklist:[{id:'research',title:'Research',fields:[{
  id:'benchmark_findings',title:'Findings',required:true,role:'agent_proposal' as const,status:'missing' as const,protected:false}]}]};
 const input={...f.input,input:'Secret input https://private.invalid/?token=secret'};
 await expect(runtimeAdmissionService(f.user,f.admin,{...f.policy,hostTurnContext:host}).prepare(input))
  .rejects.toThrow('RESEARCH_TOOLS_CONTEXT_CAPACITY');
 expect(f.rpc.mock.calls.some(([name])=>name==='runtime_admit')).toBe(false);
 const log=f.logs[0] as {context:{capacity:Record<string,number>}};
 expect(log.context.capacity.deficitBytes).toBeGreaterThan(0);
 expect(Object.values(log.context.capacity).every(value=>typeof value==='number'&&Number.isSafeInteger(value))).toBe(true);
 expect(JSON.stringify(f.logs)).not.toContain(input.input);
 expect(JSON.stringify(f.logs)).not.toContain('private.invalid');
 expect(input.input).toBe('Secret input https://private.invalid/?token=secret');
});
