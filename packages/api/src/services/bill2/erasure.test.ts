/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {authoritativeBilling,type FrozenCall} from './service';
const rawBody=JSON.stringify({id:'receipt',model:'m',cost:'0.001',currency:'USD',final:true,
 coverage:'request_total',usage:{sdkResponse:{choices:[{message:{content:'PRIVATE_CANARY'}}]}}});
const observation={rawBody,rawBodyBase64:Buffer.from(rawBody).toString('base64'),sourceHash:'a'.repeat(64),
 httpStatus:200,complete:true,transportIssue:null};
it.each(['at-record','after-record','open','read-error'] as const)(
 'does not return provider content after account confirmation: %s',async mode=>{
  const actor=randomUUID(),run=randomUUID(),callId=randomUUID(),token=randomUUID();
  const body='synthetic request';
  const frozen:FrozenCall={provider:'fixture',account:'test',model:'m',protocol:'fixture-cost-v1',
   requestHash:createHash('sha256').update(body).digest('hex'),upperUsd:'0.01',inputLimit:1000,outputLimit:1000,
   automaticRetry:false,hiddenTools:false,lookupSupported:true,phase:'ordinary'};
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
   expect(args.p_actor_id).toBe(actor);
   if(name==='bill2_claim')return {data:{id:callId,state:'prepared',dispatchToken:token},error:null};
   if(name==='bill2_dispatch')return {data:{dispatch:true},error:null};
   if(name==='bill2_record')return {data:{accountClosed:mode==='at-record'},error:null};
   expect(name).toBe('bill2_read');
   return mode==='read-error'?{data:null,error:{code:'offline'}}:{data:{accountClosed:mode==='after-record'},error:null};
  });
  const adapter={dispatch:vi.fn(async()=>observation),lookup:vi.fn()};
  const billing=authoritativeBilling({admin:{rpc},actor:async()=>actor,adapter});
  await billing.claimCall(run,1,frozen);
  if(mode==='read-error')await expect(billing.dispatchOnce(callId,body)).rejects.toThrow('DATABASE_UNAVAILABLE');
  else {
   const result=await billing.dispatchOnce(callId,body);
   if(mode==='open')expect(result.observation).toEqual(observation);
   else {expect(result).toEqual({dispatched:true,accountClosed:true});expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');}
  }
  expect(adapter.dispatch).toHaveBeenCalledTimes(1);expect(adapter.lookup).not.toHaveBeenCalled();
  expect(await billing.dispatchOnce(callId,body)).toEqual({dispatched:false});
  expect(rpc.mock.calls.filter(([name])=>name==='bill2_record')).toHaveLength(1);
 });
it('a closed original run recovery uses the existing lookup claim and never dispatches',async()=>{
 const actor=randomUUID(),run=randomUUID(),callId=randomUUID();
 const rpc=vi.fn(async(name:string)=>{
  if(name==='bill2_pending_calls')return {data:[callId],error:null};
  if(name==='bill2_recovery_claim')return {data:{provider:'fixture',account:'test',model:'m',
   protocol:'fixture-cost-v1',providerId:'receipt'},error:null};
  return {data:{accountClosed:true,closed:true,state:'settled',chargedCredits:1},error:null};
 });
 const adapter={dispatch:vi.fn(),lookup:vi.fn(async()=>observation)};
 await authoritativeBilling({admin:{rpc},actor:async()=>actor,adapter}).recoverRun(run);
 expect(adapter.dispatch).not.toHaveBeenCalled();expect(adapter.lookup).toHaveBeenCalledTimes(1);
 expect(rpc.mock.calls.map(([name])=>name)).toEqual([
  'bill2_pending_calls','bill2_recovery_claim','bill2_record','bill2_read','bill2_finalize']);
});
