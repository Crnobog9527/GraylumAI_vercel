/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runtimeAdmissionService } from './admission';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { openRouterBound } from '../bill2/openRouterPolicy';
const mocks=vi.hoisted(()=>({host:vi.fn(),freeze:vi.fn()}));
vi.mock('./paygHostPolicy',()=>({readPaygHostPolicies:mocks.host}));
vi.mock('./paygPricing',()=>({freezeStagingPaygPricing:mocks.freeze}));
vi.mock('./newWorkGate',()=>({readNewWorkSettings:()=>({}),
  newWorkGate:()=>({message:async()=>({ok:true})}),requireNewWork:()=>{}}));
vi.mock('./billingUnitAdmission',async original=>({
  ...(await original<typeof import('./billingUnitAdmission')>()),
  freezeWindowBillingUnit:async()=>({version:'bill-unit-v2',creditsPerUsd:'100',defaultMultiplier:'3',
    models:{},providers:{},hash:'f'.repeat(64)}),
}));
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
it('real host admits v2, replays original admission across switch-off, then admits new requests as v1',async()=>{
  const model='anthropic/claude-sonnet-5.5',tag='anthropic';
  const providerLimits={providerSlug:tag,contextTokens:250000,promptUsdPerMillion:'1',completionUsdPerMillion:'1',requestUsd:'0'};
  const quote={modelId:id(3),model,provider:'openrouter',account:'synthetic',protocol:'openrouter-chat-v1' as const,
    providerLimits,upperUsd:openRouterBound(providerLimits,8192).upperUsd,inputLimit:90000,outputLimit:8192,
    multiplier:'3',automaticRetry:false as const,hiddenTools:false as const,lookupSupported:true};
  const profile={version:'test-only',policyId:id(5),profileVersion:'test-only',evidenceVersion:'test-only',
    admissionPath:'empirical',templateTokens:4096,marginTokens:4096,maxBytes:196608,maxMessages:32,maxTools:2,
    maxSchemaBytes:16384,purposes:['ordinary'],expiresAt:'2099-01-01T00:00:00Z'};
  mocks.host.mockResolvedValue([{...quote,payg:profile}]);
  mocks.freeze.mockImplementation(async(_admin,policies)=>policies.map((p:typeof quote)=>({...p,payg:{...profile,
    pricingHash:'a'.repeat(64),endpointTag:tag,nominalPricing:{version:'nominal-v1',pricingHash:'a'.repeat(64),endpointTag:tag,
      tiers:[{minPromptTokens:0,prompt:'1',completion:'1',request:'0'}],timeOfDay:[]}}})));
  const saved=new Map<string,unknown>();const contracts:string[]=[];
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:id(2)}},error:null};
    if(name==='runtime_admission_replay')return {data:saved.get(String(args.p_request_id))??null,error:null};
    if(name==='runtime_admit'){
      const billing=args.p_billing as {contractVersion:string;limits:{credits:number}};
      contracts.push(billing.contractVersion);
      const data={executionId:String(args.p_request_id),billing};saved.set(String(args.p_request_id),data);
      return {data,error:null};
    }
    throw new Error(name);
  });
  const modelRow={id:id(3),model_id:model,provider:'openrouter',is_active:'true',input_limit:250000,max_tokens:8192,
    config:pricingConfig(model,tag,'1','1')};
  const q={select:()=>q,eq:()=>q,single:async()=>({data:modelRow,error:null}),in:async()=>({data:[modelRow],error:null})};
  const admin={rpc,from:()=>q} as unknown as SupabaseClient;
  const user={auth:{getUser:async()=>({data:{user:{id:id(1),email_confirmed_at:'2026-01-01'}},error:null})}} as unknown as SupabaseClient;
  const policy={real:{id:id(5),creditsPerUsd:'100',multiplier:'3',expiresAt:'2099-01-01T00:00:00Z',callPolicies:[quote]},
    paygHost:true,account:'local',costPerCall:'1',creditsPerUsd:'100',multiplier:'3',maxCalls:3,
    maxOutputTokens:8192,inputBytes:90000,historyItems:10};
  const request={sessionId:id(2),requestId:id(4),input:'Synthetic host cutover',selection:{kind:'ordinary',modelId:id(3)},network:'deny'};
  const first=await runtimeAdmissionService(user,admin,policy).prepare(request);
  expect(first).toMatchObject({billing:{contractVersion:'bill2.v2',limits:{credits:0}}});
  expect(mocks.host).toHaveBeenCalledTimes(1);
  expect(mocks.host.mock.calls[0][3]).toEqual([{modelId:id(3),phase:'ordinary',outputLimit:8192,
    requestFormat:'serial-tools-v2',reasoning:undefined}]);
  mocks.host.mockResolvedValue(undefined);
  expect(await runtimeAdmissionService(user,admin,policy).prepare(request)).toEqual(first);
  expect(mocks.host).toHaveBeenCalledTimes(1);
  const next=await runtimeAdmissionService(user,admin,policy).prepare({...request,requestId:id(6)});
  expect(next).toMatchObject({billing:{contractVersion:'bill2.v1'}});
  expect(contracts).toEqual(['bill2.v2','bill2.v1']);
});
