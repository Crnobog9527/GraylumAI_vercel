/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {ProviderPriceEntry} from '../billingProviderPrices';
const mock=vi.hoisted(()=>({rows:[] as unknown[]}));
vi.mock('../turn/admission/admissionConfiguration',()=>({readAdmissionConfiguration:async()=>({data:mock.rows,error:null})}));
vi.mock('../research/vendors/config',async original=>({...await original<object>(),readResearchToolsConfig:async()=>({
 config:{enabled:true,vendors:{tikhub:{enabled:true}}}})}));
import {admitReadTurn} from './billedRead';
const routes=['/xiaohongshu/app_v2/get_user_info','/xiaohongshu/app_v2/get_user_posted_notes'];
const now=new Date('2026-10-18T00:00:00Z');
const STOP_LOSS={limitUsd:100,p:4,poolSize:16,uFastUsd:1,uBigUsd:5};
function fixture(q='100',thresholds=routes){
 const entries:ProviderPriceEntry[]=routes.map((route,index)=>({provider:'tikhub',route,appliesToUnlistedRoutes:false,
  currency:'USD',usageUnit:'call',unitsPerPrice:'1',price:'0.01',usdPerCurrency:null,fxSourceUrl:null,fxEffectiveAt:null,
  fxValidUntil:null,pricingBasis:'fixture',sourceUrl:'https://example.org/pricing',evidenceHash:'a'.repeat(64),
  verifiedAt:'2026-10-17T00:00:00Z',validUntil:'2030-01-01T00:00:00Z',chargeCondition:'per call',
  includedInReceipt:false,priceMultiplier:index===0?'7':null}));
 mock.rows=[{key:'core_path_v2',value:{enabled:true,stopLoss:STOP_LOSS,decisionUpperUsd:'0.01'}},
  {key:'billing_provider_prices',value:{version:1,entries}},
  {key:'billing_payg_start_thresholds',value:{version:'1',thresholds:thresholds.map(route=>({model:'tikhub:'+route,purpose:'publish_monitor',typicalUsd:'0.01'}))}}];
 const db={from:(table:string)=>{
  expect(table).toBe('system_settings');
  return {select(){return this;},eq(){return this;},
   in:async()=>({data:[{key:'billing_credits_per_usd',value:q},{key:'billing_token_price_multiplier',value:'6'}],error:null}),
   maybeSingle:async()=>({data:null,error:null})};
 }};
 return db as never;
}
it('freezes exactly the two TikHub routes at their own prices and multipliers, with the real price resolver',async()=>{
 const result=await admitReadTurn(fixture(),routes,now);
 expect(result?.policies.map(policy=>[policy.model,policy.multiplier])).toEqual([['tikhub:'+routes[0],'7'],['tikhub:'+routes[1],'6']]);
 expect(result).toMatchObject({q:'100',multiplier:'7',stopLoss:STOP_LOSS});
 // 0.01 USD x 7 x 100 = 7 credits per call is the start threshold of the dearest route; the bound covers both calls at m = 7.
 expect(result?.startCredits).toBe(7);
 expect(result?.bound).toBe('0.02');
});
it('a route without its own start threshold refuses the read before anything opens',async()=>{
 expect(await admitReadTurn(fixture('100',[routes[0]!]),routes,now)).toBeNull();
});
it('the core-path switch off refuses the read',async()=>{
 const db=fixture();mock.rows=mock.rows.map(row=>(row as {key:string}).key==='core_path_v2'?{key:'core_path_v2',value:{enabled:false}}:row);
 expect(await admitReadTurn(db,routes,now)).toBeNull();
});
