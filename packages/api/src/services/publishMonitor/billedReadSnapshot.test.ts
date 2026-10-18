/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import {resolveProviderPrice,type ProviderPriceEntry} from '../billingProviderPrices';
import {multiplierForProviderCall,type MultiplierSnapshot} from '../billingUnit';
import {toolCallPolicy} from '../bill2/toolBilling';
const mock=vi.hoisted(()=>({window:vi.fn()}));
vi.mock('../runtime/stagingPolicy',()=>({loadStagingPolicy:mock.window}));
vi.mock('../research/vendors/config',async original=>({...await original<object>(),readResearchToolsConfig:async()=>({
 config:{enabled:true,vendors:{tikhub:{enabled:true}}}})}));
import {admitReadRun} from './billedRead';
const routes=['/xiaohongshu/app_v2/get_user_info','/xiaohongshu/app_v2/get_user_posted_notes'];
const now=new Date('2026-10-18T00:00:00Z');
const keys={actorId:'11111111-1111-4111-8111-111111111111',connectionId:'22222222-2222-4222-8222-222222222222',
 lease:'33333333-3333-4333-8333-333333333333',refreshId:'44444444-4444-4444-8444-444444444444'};
function fixture(q='100'){
 const entries:ProviderPriceEntry[]=routes.map((route,index)=>({provider:'tikhub',route,appliesToUnlistedRoutes:false,
  currency:'USD',usageUnit:'call',unitsPerPrice:'1',price:'0.01',usdPerCurrency:null,fxSourceUrl:null,fxEffectiveAt:null,
  fxValidUntil:null,pricingBasis:'fixture',sourceUrl:'https://example.org/pricing',evidenceHash:'a'.repeat(64),
  verifiedAt:'2026-10-17T00:00:00Z',validUntil:'2030-01-01T00:00:00Z',chargeCondition:'per call',
  includedInReceipt:false,priceMultiplier:index===0?'7':null}));
 const prices={version:1 as const,entries};
 const policies=routes.map(route=>toolCallPolicy({vendor:'tikhub',account:'test',route,purposes:['publish_monitor'],
  maxUnitsPerCall:'1',price:resolveProviderPrice(prices,{provider:'tikhub',route},'6',now)}));
 mock.window.mockResolvedValue({id:'55555555-5555-4555-8555-555555555555',callPolicies:[],creditsPerUsd:'100',multiplier:'7',
  expiresAt:'2030-01-01T00:00:00Z',toolPolicies:policies});
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>({data:name==='bill2_create_draft'
  ?'66666666-6666-4666-8666-666666666666':name==='bill2_prepare'?{id:'77777777-7777-4777-8777-777777777777'}
  :{runId:args.p_run_id,policies:[]},error:null}));
 const db={rpc,from:(table:string)=>{
  expect(table).toBe('system_settings');let key='';
  return {select(){return this;},eq(_column:string,value:string){key=value;return this;},
   in:async()=>({data:[{key:'billing_credits_per_usd',value:q},{key:'billing_token_price_multiplier',value:'6'}],error:null}),
   maybeSingle:async()=>({data:{value:key==='billing_provider_prices'?prices:
    {thresholds:routes.map(route=>({model:'tikhub:'+route,purpose:'publish_monitor'}))}},error:null})};
 }};
 return {db:db as never,rpc,entries};
}
it('real tool-only snapshot freezes exactly the two TikHub routes, without mocking billing/price/resolver functions',async()=>{
 const f=fixture();const result=await admitReadRun(f.db,keys,routes,{},now);
 expect(result?.policies).toHaveLength(2);
 const payload=f.rpc.mock.calls.find(([name])=>name==='bill2_prepare')![1].p_payload as {rules:{billingUnit:MultiplierSnapshot}};
 const snapshot=payload.rules.billingUnit;
 expect(snapshot.models).toEqual({});
 expect(snapshot.providers).toEqual({['tikhub '+routes[0]]:{multiplier:'7',source:'provider'},
  ['tikhub '+routes[1]]:{multiplier:'6',source:'global'}});
 f.entries[0]!.priceMultiplier='9';
 expect(multiplierForProviderCall(snapshot,'tikhub',routes[0]!)).toMatchObject({multiplier:'7'});
 expect(()=>multiplierForProviderCall(snapshot,'tikhub','/unapproved')).toThrow('BILLING_UNIT_ROUTE_NOT_APPROVED');
});
it('a q mismatch refuses preparation before any billing RPC',async()=>{
 const f=fixture('200');await expect(admitReadRun(f.db,keys,routes,{},now)).rejects.toThrow();
 expect(f.rpc).not.toHaveBeenCalled();
});
