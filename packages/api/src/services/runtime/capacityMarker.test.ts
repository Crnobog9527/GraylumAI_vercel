/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import {runtimeExecutor} from './execute';
const mock=vi.hoisted(()=>({run:vi.fn(),billing:{claimCall:vi.fn(),dispatchOnce:vi.fn(),recoverRun:vi.fn()}}));
vi.mock('./runner',()=>({runRuntime:mock.run}));
vi.mock('../bill2/service',()=>({authoritativeBilling:()=>mock.billing}));
const id='10000000-0000-4000-8000-000000000001';
beforeEach(()=>vi.clearAllMocks());

// Content beyond capacity in a later call of a round that already charged an earlier one: the round
// is interrupted as before, and the capacity code is recorded first so that no automatic or operator
// refund applies to it (user material too long is not refunded, Owner 2026-10-12).
function round(code:string,marker:'ok'|'error'='ok'){
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Current',instructions:'Fixed',model:'fixture',
  maxOutputTokens:100,maxTurns:1,historyItems:0,tools:[],network:'deny'};
 const calls:Array<{name:string;action?:unknown;args:Record<string,unknown>}>=[];
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  calls.push({name,action:args.p_action,args});
  if(name==='runtime_execution'&&args.p_action==='begin')return {data:{live:true,state:'running',epoch:3,sessionId:id,runId:id,context,
   billing:{contractVersion:'bill2.v2',callPolicy:[{model:'fixture',provider:'fixture',protocol:'fixture-cost-v1',inputLimit:20000}],rules:{},limits:{maxCalls:2}}},error:null};
  if(name==='runtime_session_items'&&args.p_action==='read')return {data:[],error:null};
  // An earlier call of this round was dispatched, so pre-dispatch cancellation does not apply.
  if(name==='runtime_execution'&&args.p_action==='fail_before_dispatch')return {data:{state:'running'},error:null};
  if(name==='runtime_record_capacity_failure')return marker==='ok'?{data:{recorded:true},error:null}:{data:null,error:{message:'synthetic'}};
  return {data:{state:'running'},error:null};
 })};
 mock.run.mockImplementation(async()=>{throw new Error(code);});
 const execute=()=>runtimeExecutor({database,actor:async()=>id,callGate:async()=>({ok:true}),adapter:{dispatch:vi.fn()} as never}).execute(id);
 return {execute,calls};
}
const sequence=(calls:ReturnType<typeof round>['calls'])=>calls.map(c=>c.name==='runtime_execution'?String(c.action):c.name)
 .filter(step=>!['owner_session','runtime_session_items'].includes(step));

it.each(['RUNTIME_REQUIRED_CONTEXT_EXCEEDS_CAPACITY','RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY'])(
 'records %s on the execution before interrupting it',async code=>{
 const r=round(code);
 expect(await r.execute()).toEqual({state:'pending',unavailable:'capacity'});
 expect(sequence(r.calls)).toEqual(['begin','fail_before_dispatch','runtime_record_capacity_failure','interrupt']);
 expect(r.calls.find(c=>c.name==='runtime_record_capacity_failure')?.args).toEqual({p_actor_id:id,p_execution_id:id,p_code:code});
});

it('still interrupts when the marker cannot be written (before 0282, or an outage)',async()=>{
 const r=round('RUNTIME_COMPLETE_REQUEST_EXCEEDS_CAPACITY','error');
 expect(await r.execute()).toEqual({state:'pending',unavailable:'capacity'});
 expect(sequence(r.calls).at(-1)).toBe('interrupt');
});

it('other unclassified failures stay unmarked and remain eligible for the 24-hour refund',async()=>{
 const r=round('SYNTHETIC_UNKNOWN_FAILURE');
 expect(await r.execute()).toEqual({state:'pending'});
 expect(sequence(r.calls)).not.toContain('runtime_record_capacity_failure');
});
