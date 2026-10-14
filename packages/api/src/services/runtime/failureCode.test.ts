/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it,vi} from 'vitest';
import {runtimeExecutor} from './execute';
import {cancelWithCode} from './executorRpc';
import {createRuntimeBudget} from './budget';
const billing=vi.hoisted(()=>({claimCall:vi.fn(),dispatchOnce:vi.fn(),recoverRun:vi.fn()}));
vi.mock('../bill2/service',async original=>({...await original<typeof import('../bill2/service')>(),authoritativeBilling:()=>billing}));
const id='10000000-0000-4000-8000-000000000001';

// 0248: a v1 transport that never started is cancelled with its code in the same transaction.
it.each(['applied','pending'] as const)('records why a never-started v1 transport was cancelled (0248 %s)',async migration=>{
 vi.clearAllMocks();
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Hello',instructions:'Answer.',
  model:'fixture',maxOutputTokens:1000,maxTurns:1,historyItems:0,tools:[],maxToolCalls:0,network:'deny',
  inputSelection:'scope-projection-v1',nativeOutput:'native-output-v1'};
 const policy={model:'fixture',provider:'fixture',account:'test',protocol:'fixture-cost-v1',upperUsd:'0.01',inputLimit:64000,outputLimit:1000};
 const database={rpc:vi.fn(async(name:string,args:Record<string,unknown>)=>{
  let data:unknown={};
  if(name==='runtime_execution'&&args.p_action==='begin')data={live:true,state:'running',sessionId:id,runId:id,
   context,billing:{contractVersion:'bill2.v1',callPolicy:[policy],rules:{},limits:{maxCalls:1}}};
  else if(name==='runtime_session_items')data=args.p_action==='read'?[]:{};
  else if(name==='runtime_response')data=null;
  else if(name==='runtime_cancel_with_code'&&migration==='pending')return {data:null,error:{code:'PGRST202',message:'missing'}};
  else if(name==='runtime_cancel_with_code'||name==='runtime_cancel')data={state:'cancelled'};
  return {data,error:null};
 })};
 billing.claimCall.mockImplementation(async(_run,sequence)=>({id:String(sequence)}));
 billing.dispatchOnce.mockImplementation(async()=>({transportNotStarted:true}));
 const result=await runtimeExecutor({database,actor:async()=>id,callGate:vi.fn(async()=>({ok:true as const})),
  budget:createRuntimeBudget(),adapter:{dispatch:vi.fn()} as never}).execute(id);
 expect(result.state).toBe('cancelled');
 const names=database.rpc.mock.calls.map(([name])=>name).filter(name=>name.startsWith('runtime_cancel'));
 expect(names).toEqual(migration==='applied'?['runtime_cancel_with_code']:['runtime_cancel_with_code','runtime_cancel']);
 expect(database.rpc.mock.calls.find(([name])=>name==='runtime_cancel_with_code')?.[1].p_code).toBe('RUNTIME_TIME_BUDGET_EXHAUSTED');
});

it('falls back to the plain cancellation only when the coded one does not exist yet',async()=>{
 const missing=vi.fn(async(name:string)=>{
  if(name==='runtime_cancel_with_code')throw new Error('RUNTIME_CANCEL_WITH_CODE_UNAVAILABLE');
  return {state:'cancelled'};
 });
 expect(await cancelWithCode(missing as never,{p_execution_id:id},'X_CODE')).toEqual({state:'cancelled'});
 const failing=vi.fn(async()=>{throw new Error('RUNTIME_DATABASE_UNAVAILABLE');});
 await expect(cancelWithCode(failing as never,{p_execution_id:id},'X_CODE')).rejects.toThrow('RUNTIME_DATABASE_UNAVAILABLE');
 expect(failing).toHaveBeenCalledTimes(1);
});
