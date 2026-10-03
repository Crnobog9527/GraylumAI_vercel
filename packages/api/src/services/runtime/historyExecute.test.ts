/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import {runtimeExecutor} from './execute';
import {freezeHistorySelection} from './hostTurn';
import type {RuntimeRunnerInput} from './runner';
const mock=vi.hoisted(()=>({run:vi.fn(),billing:{claimCall:vi.fn(),dispatchOnce:vi.fn(),recoverRun:vi.fn()}}));
vi.mock('./runner',()=>({runRuntime:mock.run}));
vi.mock('../bill2/service',()=>({authoritativeBilling:()=>mock.billing}));
const id='10000000-0000-4000-8000-000000000001';
beforeEach(()=>vi.clearAllMocks());
it.each(['first-overflow','later-overflow','replay'] as const)('H1 %s fails before the affected claim and never shrinks frozen history',async mode=>{
 const history=Array.from({length:48},(_,i)=>({role:i%2?'assistant':'user',content:String(i+1).padStart(100,'h')}));
 let frozen:unknown,raw:string|undefined;
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',input:mode==='first-overflow'?'x'.repeat(15000):'current',
  instructions:'fixed',model:'fixture',maxOutputTokens:100,maxTurns:1,historyItems:32,tools:[],network:'deny',
  providerRequestFormat:'agent-turn-v5-stream',reasoning:{parameter:'none'},inputSelection:'scope-projection-v2',
  historySelection:{...freezeHistorySelection(),currentReserveBytes:1000},hostTurnContext:{stepId:'s',opening:false,checklist:[]}};
 const policy={model:'fixture',provider:'fixture',protocol:'fixture-cost-v1',inputLimit:10000};
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_execution'&&args.p_action==='begin')return {data:{live:true,state:'running',sessionId:id,runId:id,
   context,billing:{callPolicy:[policy],rules:{},limits:{maxCalls:2}}},error:null};
  if(name==='runtime_session_items'&&args.p_action==='read')return {data:history.map((item,i)=>({revision:i+1,item})),error:null};
  if(name==='runtime_session_items'&&args.p_action==='freeze'){
   if(frozen)expect(args.p_items).toEqual(frozen);frozen=args.p_items;
  }
  if(name==='runtime_response')return {data:raw?{rawBody:raw}:null,error:null};
  return {data:{state:'cancelled'},error:null};
 })};
 mock.billing.claimCall.mockResolvedValue({id});
 mock.billing.dispatchOnce.mockImplementation(async()=>{raw=JSON.stringify({usage:{sdkResponse:{model:'fixture',choices:[]}}});
  return {dispatched:true};});
 mock.run.mockImplementation(async(o:RuntimeRunnerInput)=>{
  const loaded=await o.session.getItems(),incoming=[{role:'user',content:o.input}];
  const selected=await o.selectHistory(loaded,incoming);
  const first=o.filterModelInput!(selected as never,o.instructions);
  expect(first).toHaveLength(33);
  await o.exchange(1,JSON.stringify({model:'fixture',messages:first}));
  if(mode==='later-overflow'){
   const required=[{type:'function_call',callId:'a',name:'ask_question',arguments:'{}'},
    {type:'function_call_result',callId:'a',name:'ask_question',output:'x'.repeat(15000)}];
   // The same callback the SDK invokes before every continuation; failure
   // prevents exchange/claim sequence 2, leaving the first paid call intact.
   const second=o.filterModelInput!([...selected,...required] as never,o.instructions);
   await o.exchange(2,JSON.stringify({model:'fixture',messages:second}));
  }
  return 'reply';
 });
 const options={database,actor:async()=>id,callGate:vi.fn(async()=>({ok:true as const})),adapter:{dispatch:vi.fn()} as never};
 await runtimeExecutor(options).execute(id);
 if(mode==='first-overflow')expect(mock.billing.claimCall).not.toHaveBeenCalled();
 else {
  expect(mock.billing.claimCall).toHaveBeenCalledTimes(1);
  expect(frozen).toEqual(Array.from({length:32},(_,i)=>i+17));
  if(mode==='replay'){
   await runtimeExecutor(options).execute(id);
   expect(mock.billing.claimCall).toHaveBeenCalledTimes(1);
  }
 }
});
