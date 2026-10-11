/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import {runtimeExecutor} from './execute';
import {platformFailureReason} from './executorRpc';
import type {RuntimeRunnerInput} from './runner';
const mock=vi.hoisted(()=>({run:vi.fn(),billing:{claimCall:vi.fn(),dispatchOnce:vi.fn(),recoverRun:vi.fn()}}));
vi.mock('./runner',()=>({runRuntime:mock.run}));
vi.mock('../bill2/service',()=>({authoritativeBilling:()=>mock.billing}));
const id='10000000-0000-4000-8000-000000000001';
beforeEach(()=>vi.clearAllMocks());

it.each([
 ['RUNTIME_PROVIDER_HISTORY_DENIED','provider_history'],['BILL2_PROVIDER_REQUEST_DENIED','preflight'],
 ['RUNTIME_PROVIDER_BINDING_DENIED','preflight'],['RUNTIME_TIME_BUDGET_EXHAUSTED',undefined],
 ['RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY',undefined],[undefined,undefined],
] as const)('classifies %s as a Graylum system failure: %s',(code,reason)=>{
 expect(platformFailureReason(code)).toBe(reason);
});

// A later call of a round that already charged an earlier call (a resumed PAYG round) hits a
// history incompatibility: nothing more is dispatched, so the round ends through fail_platform.
function round(contractVersion:'bill2.v2'|'bill2.v1',platform:'cancelled'|'cost_pending'|'error'){
 const bad={role:'assistant',content:[{type:'output_text',text:'Synthetic',providerData:{unknown:'synthetic'}}]};
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Current',instructions:'Fixed',model:'fixture',
  maxOutputTokens:100,maxTurns:1,historyItems:32,tools:[],network:'deny',providerRequestFormat:'serial-tools-v6-reasoning',
  reasoning:{effort:'low'}};
 const actions:Array<{action:unknown;result:unknown}>=[];
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_execution')actions.push({action:args.p_action,result:args.p_result});
  if(name==='runtime_execution'&&args.p_action==='begin')return {data:{live:true,state:'running',epoch:3,sessionId:id,runId:id,context,
   billing:{contractVersion,callPolicy:[{model:'fixture',provider:'fixture',protocol:'fixture-cost-v1',inputLimit:20000}],rules:{},limits:{maxCalls:2}}},error:null};
  if(name==='runtime_session_items'&&args.p_action==='read')return {data:[],error:null};
  // An earlier call of this round was dispatched, so pre-dispatch cancellation does not apply.
  if(name==='runtime_execution'&&args.p_action==='fail_before_dispatch')return {data:{state:'running'},error:null};
  if(name==='runtime_execution'&&args.p_action==='fail_platform')
   return platform==='error'?{data:null,error:{message:'RUNTIME_RESUME_CONFLICT'}}:{data:{state:platform},error:null};
  return {data:{state:'running'},error:null};
 })};
 mock.run.mockImplementation(async(o:RuntimeRunnerInput)=>{
  const selected=await o.selectHistory(await o.session.getItems(),[{role:'user',content:o.input}]);
  o.filterModelInput!([...selected,bad] as never,o.instructions);
  return 'unreachable';
 });
 const execute=()=>runtimeExecutor({database,actor:async()=>id,callGate:async()=>({ok:true}),adapter:{dispatch:vi.fn()} as never}).execute(id);
 return {execute,actions};
}

// A cost-pending round is not refunded yet, so it carries no "not charged" reason.
it.each([['cancelled',{state:'cancelled',unavailable:'provider_history'}],['cost_pending',{state:'cost_pending'}]] as const)(
 'a PAYG round failing on our side ends through fail_platform (%s) and never interrupts',async(platform,expected)=>{
 const r=round('bill2.v2',platform);
 expect(await r.execute()).toEqual(expected);
 expect(r.actions.find(a=>a.action==='fail_platform')?.result).toEqual({epoch:3,value:{unavailable_reason:'provider_history'}});
 expect(r.actions.some(a=>a.action==='interrupt')).toBe(false);
 expect(mock.billing.claimCall).not.toHaveBeenCalled();
});

it('keeps the original recovery path when SQL declines the platform failure',async()=>{
 const r=round('bill2.v2','error');
 expect(await r.execute()).toEqual({state:'pending'});
 expect(r.actions.map(a=>a.action).filter(action=>action!=='owner_session'))
  .toEqual(['begin','fail_before_dispatch','fail_platform','interrupt']);
});

it('leaves pre-PAYG (bill2.v1) rounds on their existing path',async()=>{
 const r=round('bill2.v1','cancelled');
 expect(await r.execute()).toEqual({state:'pending'});
 expect(r.actions.some(a=>a.action==='fail_platform')).toBe(false);
});
