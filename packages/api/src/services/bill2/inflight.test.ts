/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {authoritativeBilling,type BillingTransport,type FrozenCall} from './service';
const body='synthetic';
function setup(mode='normal') {
 const actorId=randomUUID(),runId=randomUUID(),callId=randomUUID(),executionId=randomUUID();
 let authorized=true,records=0;
 const actor=vi.fn(async()=>{if(!authorized)throw new Error('AUTH_REVOKED');return actorId;});
 const frozen:FrozenCall={provider:'fixture',account:'synthetic',model:'m',protocol:'fixture-cost-v1',
  requestHash:createHash('sha256').update(body).digest('hex'),upperUsd:'0.01',inputLimit:1000,outputLimit:1000,
  automaticRetry:false,hiddenTools:false,lookupSupported:true,phase:'ordinary'};
 const rawBody=JSON.stringify({id:'generation',model:'m',cost:'0.001',currency:'USD',final:true,coverage:'request_total'});
 const observation={rawBody,rawBodyBase64:Buffer.from(rawBody).toString('base64'),sourceHash:'a'.repeat(64),
  httpStatus:200,complete:true,transportIssue:null};
 const view={id:runId,executionId,closed:true,state:'settled',chargedCredits:1};
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>=>{
  expect(args.p_actor_id).toBe(actorId);
  if(name==='bill2_claim')return {data:{id:callId,state:'prepared',dispatchToken:randomUUID()},error:null};
  if(name==='bill2_dispatch')return {data:{dispatch:mode!=='denied'},error:null};
  if(name==='bill2_record'){
   records++;
   if(records===1&&mode.startsWith('ambiguous'))return {data:null,error:{code:'transport'}};
  }
  if(name==='runtime_receipt_saved'){
   expect(args).toMatchObject({p_execution_id:executionId,p_run_id:runId,p_call_id:callId});
   return mode==='ambiguous-read-fails'?{data:null,error:{code:'transport'}}:{data:mode==='ambiguous-committed',error:null};
  }
  if(name==='bill2_pending_calls')return {data:[],error:null};
  return {data:view,error:null};
 });
 const adapter:BillingTransport={dispatch:vi.fn(async()=>{authorized=false;return observation;}),lookup:vi.fn()};
 return {actorId,runId,callId,frozen,rpc,actor,adapter,observation,view,revoke:()=>{authorized=false;}};
}
it.each(['logout','password-revoked','disabled','banned','deleted'])(
 'retains only this dispatched financial identity after %s',async()=>{
 const f=setup(),api=authoritativeBilling({admin:{rpc:f.rpc},actor:f.actor,adapter:f.adapter});
 await api.claimCall(f.runId,1,f.frozen);
 expect(await api.dispatchOnce(f.callId,body)).toMatchObject({dispatched:true});
 const authenticated=f.actor.mock.calls.length;
 await api.readRun(f.runId);await api.closeRun(f.runId,'cancelled');await api.requestCancel(f.runId);
 await api.recoverRun(f.runId);
 expect(f.actor).toHaveBeenCalledTimes(authenticated);
 await expect(api.claimCall(f.runId,2,f.frozen)).rejects.toThrow('AUTH_REVOKED');
 await expect(api.readPrivateInput(f.runId)).rejects.toThrow('AUTH_REVOKED');
 await expect(api.readRun(randomUUID())).rejects.toThrow('AUTH_REVOKED');
 expect(f.adapter.dispatch).toHaveBeenCalledTimes(1);
});
it('does not mint a financial capability from claim alone or denied dispatch',async()=>{
 const f=setup('denied'),api=authoritativeBilling({admin:{rpc:f.rpc},actor:f.actor,adapter:f.adapter});
 await api.claimCall(f.runId,1,f.frozen);
 expect(await api.dispatchOnce(f.callId,body)).toEqual({dispatched:false});
 f.revoke();await expect(api.readRun(f.runId)).rejects.toThrow('AUTH_REVOKED');
 expect(f.adapter.dispatch).not.toHaveBeenCalled();
});
it.each(['ambiguous-committed','ambiguous-missing','ambiguous-read-fails'])(
 'reads exact original receipt before a bounded idempotent retry: %s',async(mode)=>{
 const f=setup(mode),api=authoritativeBilling({admin:{rpc:f.rpc},actor:f.actor,adapter:f.adapter});
 await api.claimCall(f.runId,1,f.frozen);
 const result=await api.dispatchOnce(f.callId,body);
 const names=f.rpc.mock.calls.map(([name])=>name);
 expect(names.slice(2,5)).toEqual(['bill2_record','bill2_read','runtime_receipt_saved']);
 expect(names.filter(name=>name==='bill2_record')).toHaveLength(mode==='ambiguous-missing'?2:1);
 expect(Boolean(result.pendingReceipt)).toBe(mode==='ambiguous-read-fails');
 expect(f.adapter.dispatch).toHaveBeenCalledTimes(1);
});
it('does not transfer a claimed capability to a changed authenticated actor',async()=>{
 const f=setup();let current=f.actorId;
 const api=authoritativeBilling({admin:{rpc:f.rpc},actor:async()=>current,adapter:f.adapter});
 await api.claimCall(f.runId,1,f.frozen);current=randomUUID();
 await expect(api.dispatchOnce(f.callId,body)).rejects.toThrow('BILL2_ACTOR_BINDING_DENIED');
 expect(f.adapter.dispatch).not.toHaveBeenCalled();
});
it.each(['slow','failure'])( 'early observation never delays chunk emission and is joined: %s',async(mode)=>{
 const f=setup();let release!:()=>void;
 const slow=new Promise<void>(resolve=>{release=resolve;});
 let writes=0;const events:string[]=[];
 const rpc=async(name:string,args:Record<string,unknown>)=>{
  if(name==='bill2_record'&&++writes===1){events.push('early-start');await slow;events.push('early-finished');
   if(mode==='failure')return {data:null,error:{code:'write-failed'}};
  }
  return f.rpc(name,args);
 };
 const adapter:BillingTransport={...f.adapter,prepareDispatch:async(_input,_identity,onChunk,onIdentity)=>async()=>{
  onIdentity?.('first-id');onIdentity?.('first-id');onChunk?.('first');events.push('stream-finished');return f.observation;
 }};
 const api=authoritativeBilling({admin:{rpc},actor:f.actor,adapter});await api.claimCall(f.runId,1,f.frozen);
 let finished=false;const pending=api.dispatchOnce(f.callId,body,()=>events.push('chunk')).then(value=>{finished=true;return value;});
 for(let i=0;i<20;i++)await Promise.resolve();
 expect(events).toEqual(['early-start','chunk','stream-finished']);expect(finished).toBe(false);
 release();expect(await pending).toMatchObject({dispatched:true});
 expect(events.indexOf('chunk')).toBeLessThan(events.indexOf('early-finished'));
 const early=f.rpc.mock.calls.find(([name,args])=>name==='bill2_record'&&(args.p_evidence as {providerId?:string}).providerId==='first-id');
 if(mode==='slow')expect(early?.[1].p_evidence).toMatchObject({providerId:'first-id',final:false,cost:null});
});
it('persists after the real runtimeActor getUser chain starts rejecting the original token',async()=>{
 const {runtimeActor}=await import('../runtime/actor');
 const {createRuntimeBudget}=await import('../runtime/budget');
 const f=setup();let revoked=false;
 const jwt='test.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.test';
 const auth={getSession:vi.fn(async()=>({data:{session:{access_token:jwt}},error:null})),
  getUser:vi.fn(async()=>({data:{user:revoked?null:{id:f.actorId}},error:revoked?{message:'revoked'}:null}))};
 const actor=runtimeActor(auth as unknown as Parameters<typeof runtimeActor>[0],f.actorId,createRuntimeBudget());
 const api=authoritativeBilling({admin:{rpc:f.rpc},actor,
  adapter:{...f.adapter,dispatch:async()=>{revoked=true;return f.observation;}}});
 await api.claimCall(f.runId,1,f.frozen);await api.dispatchOnce(f.callId,body);
 await expect(actor()).rejects.toThrow('RUNTIME_DENIED');
 await api.closeRun(f.runId,'cancelled');await api.finalizeRun(f.runId);
 await expect(api.claimCall(f.runId,2,f.frozen)).rejects.toThrow('RUNTIME_DENIED');
 expect(auth.getUser).toHaveBeenCalledWith(jwt);
 expect(f.rpc.mock.calls.map(([name])=>name)).toEqual([
  'bill2_claim','bill2_dispatch','bill2_record','bill2_close','bill2_finalize',
 ]);
});
it('cancels and joins a stalled early write within the remaining invocation budget',async()=>{
 const {createRuntimeBudget}=await import('../runtime/budget');
 const f=setup();let elapsed=0;
 const budget=createRuntimeBudget(()=>elapsed);elapsed=284_980;
 let first=true,outstanding=0;
 const rpc=(name:string,args:Record<string,unknown>)=>{
  if(name==='bill2_record'&&first){
   first=false;outstanding++;
   let settle!:(result:{data:unknown;error:unknown})=>void;
   const promise=new Promise<{data:unknown;error:unknown}>(resolve=>{settle=resolve;});
   return Object.assign(promise,{abortSignal(signal:AbortSignal){
    signal.addEventListener('abort',()=>{outstanding--;settle({data:null,error:{code:'cancelled'}});},{once:true});
    return promise;
   }});
  }
  return f.rpc(name,args);
 };
 const adapter:BillingTransport={...f.adapter,prepareDispatch:async(_input,_identity,onChunk,onIdentity)=>async()=>{
  onIdentity?.('gen-early');onChunk?.('first');return f.observation;
 }};
 const api=authoritativeBilling({admin:{rpc},actor:f.actor,adapter,budget});
 await api.claimCall(f.runId,1,f.frozen);
 const chunk=vi.fn();expect(await api.dispatchOnce(f.callId,body,chunk)).toMatchObject({dispatched:true});
 expect(chunk).toHaveBeenCalledExactlyOnceWith('first');expect(outstanding).toBe(0);
});
