/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-AUTO-CONTEXT C: what a free chat admission freezes when the research switch is on, and that it changes nothing
// when it is off or the run cannot hold the extra rounds.
import {describe,expect,it} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {openRouterBound} from '../bill2/openRouterPolicy';
import type {FrozenPaygRun} from '../bill2/service';
import {toolCallPolicies} from '../bill2/runPolicies';
import {DISABLED_RESEARCH_TOOLS,researchToolsConfigSchema} from '../research/vendors/config';
import {tikhubRouteId} from '../research/vendors/tikhub';
import {FIRECRAWL_ROUTE} from '../research/vendors/firecrawl';
import {attachFreeChatResearch,CHAT_RESEARCH_KEY,FREE_CHAT_RESEARCH_INSTRUCTIONS} from './freeChatResearch';
import {RESEARCH_PHASE} from './researchTurn';
import {runtimeContext} from './runtimeContext';
import type {StagingPolicy} from './stagingPolicy';

const actor='10000000-0000-4000-8000-000000000001',modelId='10000000-0000-4000-8000-000000000002';
const now=Date.now(),day=86_400_000;
const limits={providerSlug:'local',contextTokens:300000,promptUsdPerMillion:'1',completionUsdPerMillion:'2',requestUsd:'0'};
const routes=[...(['keyword_posts','account_profile','account_posts'] as const).map(kind=>({platform:'tiktok',kind,vendor:'tikhub',
 route:tikhubRouteId('tiktok',kind)!,backup:null,maxUnitsPerCall:'1'})),
 {platform:'web',kind:'web_search',vendor:'parallel',route:'parallel:search:fast',backup:null,maxUnitsPerCall:'1'},
 {platform:'web',kind:'web_fetch',vendor:'firecrawl',route:FIRECRAWL_ROUTE,backup:null,maxUnitsPerCall:'1'}];
const price=(provider:string,route:string|null,usageUnit:string)=>({provider,route,appliesToUnlistedRoutes:route===null,currency:'USD',
 usageUnit,unitsPerPrice:'1',price:'0.01',usdPerCurrency:null,fxSourceUrl:null,fxEffectiveAt:null,fxValidUntil:null,pricingBasis:'list',
 sourceUrl:'https://example.com/p',evidenceHash:'a'.repeat(64),verifiedAt:new Date(now-day).toISOString(),
 validUntil:new Date(now+7*day).toISOString(),chargeCondition:'per call',includedInReceipt:false,priceMultiplier:null});

function fixture(options:{switchOn?:boolean;maxTools?:number;maxMessages?:number}={}){
 const vendor={enabled:true,hardCapAttested:{by:actor,at:new Date(now).toISOString()}};
 const settings:Record<string,unknown>={[CHAT_RESEARCH_KEY]:options.switchOn??true,
  research_tools_config:{...researchToolsConfigSchema.parse({...DISABLED_RESEARCH_TOOLS,enabled:true,
   vendors:{tikhub:vendor,parallel:vendor,firecrawl:vendor},verifiedPlatforms:['tiktok'],benchmarkPlatforms:['tiktok'],routes,
   limits:{maxSubcallsPerRound:12,discoverSubcalls:25}}),revision:3,updatedBy:actor,updatedAt:new Date(now).toISOString()},
  billing_provider_prices:{version:1,entries:[price('tikhub',null,'call'),price('parallel','parallel:search:fast','sku_search'),
   price('firecrawl',FIRECRAWL_ROUTE,'credit')]},
  billing_payg_start_thresholds:{version:'v1',thresholds:routes.map(r=>({model:`${r.vendor}:${r.route}`,purpose:RESEARCH_PHASE,credits:1}))}};
 const admin={from:()=>{
  let key='';
  const query={select:()=>query,eq:(_column:string,value:string)=>{key=value;return query;},
   in:async(_column:string,keys:string[])=>({error:null,data:keys.filter(k=>settings[k]!==undefined).map(k=>({key:k,value:settings[k]}))}),
   maybeSingle:async()=>({error:null,data:settings[key]===undefined?null:{value:settings[key],revision:'3'}})};
  return query;
 }} as unknown as SupabaseClient;
 const model:FrozenPaygRun['callPolicy'][number]={modelId,model:'fixture/chat',provider:'fixture',account:'local',
  protocol:'fixture-cost-v1',inputLimit:200000,outputLimit:100,upperUsd:openRouterBound(limits,100).upperUsd,providerLimits:limits,
  multiplier:'6',automaticRetry:false,hiddenTools:false,lookupSupported:true,
  payg:{policyId:'fixture',version:'1',profileVersion:'1',evidenceVersion:'1',pricingHash:'a'.repeat(64),endpointTag:'local',
   templateTokens:4096,marginTokens:4096,admissionPath:'fixture',maxBytes:196608,maxMessages:options.maxMessages??128,
   maxTools:options.maxTools??9,maxSchemaBytes:16384,purposes:['ordinary'],expiresAt:'2099-01-01T00:00:00Z',
   nominalPricing:{version:'nominal-v1',pricingHash:'a'.repeat(64),endpointTag:'local',
    tiers:[{minPromptTokens:0,prompt:'1',completion:'2',request:'0'}],timeOfDay:[]}}};
 const billing={contractVersion:'bill2.v2',callPolicy:[model],
  rules:{creditsPerUsd:'100',multiplier:'6',fx:{},billingUnit:{version:'bill-unit-v2',creditsPerUsd:'100',defaultMultiplier:'6',
   providers:{},hash:'b'.repeat(64),models:{[modelId]:{multiplier:'6',source:'global'}}}},
  limits:{costUsd:'0.1',credits:0,maxPreDeduct:0,maxCalls:6,deadline:new Date(now+day).toISOString()}} as unknown as FrozenPaygRun;
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'对标账号最近在发什么？',instructions:'Base rules.',
  model:'fixture/chat',modelId,maxOutputTokens:100,maxTurns:6,historyItems:20,network:'deny',
  providerRequestFormat:'serial-tools-v6-reasoning',tools:['read_source'],maxToolCalls:5,
  purposeBudget:{purpose:'interactive',inputBytes:90000,historyItems:20}} as Record<string,unknown>&Parameters<typeof attachFreeChatResearch>[0]['context'];
 const real={mode:'production',id:'production',callPolicies:[model],creditsPerUsd:'100',multiplier:'6',
  expiresAt:new Date(now+day).toISOString()} as unknown as StagingPolicy;
 return {admin,billing,context,real};
}

describe('free chat research admission',()=>{
 it('freezes the general tools, three more rounds, the subcall allowance, the raised input ceiling and the prices',async()=>{
  const f=fixture();
  const attached=await attachFreeChatResearch({admin:f.admin,real:f.real,context:f.context,billing:f.billing,fits:()=>true});
  expect(attached).toBe(true);
  const context=runtimeContext.parse(f.context);
  expect(context.tools).toEqual(['read_source','social_search','social_account','web_search','web_fetch']);
  expect(context).toMatchObject({maxTurns:9,maxToolCalls:8,sourceCalls:'first-call-v1',
   research:{freeChat:'free-chat-v1',subcalls:12,benchmarkPlatforms:[],verifiedPlatforms:['tiktok']},
   purposeBudget:{purpose:'interactive',inputBytes:150000}});
  expect(context.instructions.endsWith(FREE_CHAT_RESEARCH_INSTRUCTIONS)).toBe(true);
  // 3 more model calls and 12 subcalls on the run; every offered route's price is frozen beside the model.
  expect(f.billing.limits.maxCalls).toBe(6+3+12);
  expect(toolCallPolicies(f.billing.callPolicy).map(policy=>policy.model).sort()).toEqual(routes.map(route=>`${route.vendor}:${route.route}`).sort());
 });

 it.each([
  ['the switch is off',{switchOn:false}],
  ['the profile has no room for four more tools',{maxTools:3}],
  ['the profile message budget cannot hold three more rounds',{maxMessages:30}],
 ])('changes nothing when %s',async(_case,options)=>{
  const f=fixture(options);
  const before=JSON.stringify({context:f.context,billing:f.billing});
  expect(await attachFreeChatResearch({admin:f.admin,real:f.real,context:f.context,billing:f.billing,fits:()=>true})).toBe(false);
  expect(JSON.stringify({context:f.context,billing:f.billing})).toBe(before);
 });

 it('changes nothing when the tools and a result no longer fit the raised input ceiling',async()=>{
  const f=fixture();
  const seen:Array<number|undefined>=[];
  expect(await attachFreeChatResearch({admin:f.admin,real:f.real,context:f.context,billing:f.billing,
   fits:(_extra,bytes)=>{seen.push(bytes);return false;}})).toBe(false);
  expect(seen).toEqual([150000]);
  expect(f.context.tools).toEqual(['read_source']);
 });

 it('a frozen free chat context may not carry the positioning flow tools',()=>{
  const f=fixture();
  return attachFreeChatResearch({admin:f.admin,real:f.real,context:f.context,billing:f.billing,fits:()=>true}).then(()=>{
   const tampered={...f.context,tools:[...f.context.tools,'benchmark_fetch']};
   expect(runtimeContext.safeParse(tampered).success).toBe(false);
  });
 });
});
