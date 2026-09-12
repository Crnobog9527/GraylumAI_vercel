/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {preAICallSecurityChecks} from '../../middleware/securityChecks';
import {calculateTokenCostWithPricing,estimatePreDeductCredits,getBillingRuntimeSettings,getModelPricing} from '../billing';
import {workbenchModelSchema,providerInputReservation} from '../artifacts/modelPolicy';
import type {CallEvidence} from './runner';

const state=z.object({callId:z.string().uuid(),state:z.enum(['prepared','dispatched','unknown','responded','settled','refunded']),token:z.string().uuid().optional()});
async function bounded<T>(promise:PromiseLike<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 return Promise.race([Promise.resolve(promise),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
}
export function sliceCallId(executionId:string,sequence:number){
 z.string().uuid().parse(executionId);z.number().int().min(1).max(2).parse(sequence);
 const b=createHash('sha256').update(`graylum-slice-call:${executionId}:${sequence}`).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;
 const s=b.toString('hex');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

/** Private service adapter. No quote, model credential or dispatch token is public input. */
export function sliceAccounting(user:SupabaseClient,admin:SupabaseClient,executionId:string,configuredModel:unknown){
 const model=workbenchModelSchema.parse(configuredModel);
 if(/(^openai\/|gpt)/i.test(model.model_id))throw new Error('SLICE_MODEL_DENIED');
 const owned=new Map<number,{token:string;quote:Awaited<ReturnType<typeof quote>>}>();
 async function actor(){const auth=await bounded(user.auth.getUser());if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');return auth.data.user.id;}
 async function call(sequence:number,action:string,payload:Record<string,unknown>={}){
  const r=await admin.rpc('agent_slice_call',{p_actor_id:await actor(),p_execution_id:executionId,p_call_id:sliceCallId(executionId,sequence),p_action:action,p_payload:payload}).abortSignal(AbortSignal.timeout(10000));
  if(r.error)throw new Error(r.error.code==='42501'?'SLICE_DENIED':'SLICE_CALL_CONFLICT');
  return r.data;
 }
 async function quote(request:unknown){
  const r=z.object({model:z.literal(model.model_id),messages:z.array(z.unknown()).min(1),max_tokens:z.number().int().positive().max(20000).optional(),max_completion_tokens:z.number().int().positive().max(20000).optional()}).passthrough().parse(request);
  const maxTokens=r.max_completion_tokens??r.max_tokens;
  if(!maxTokens||maxTokens>model.max_tokens)throw new Error('SLICE_CAPACITY');
  // Include SDK tool schemas, tool results and framing, not just the user's text.
  const serialized=JSON.stringify(request);
  const inputTokens=providerInputReservation(model,[{content:serialized}],maxTokens);
  if(inputTokens===null)throw new Error('SLICE_MODEL_DENIED');
  const [pricing,settings]=await Promise.all([bounded(getModelPricing(admin,model.model_id,{requireModelPricing:true,modelRecordId:model.id})),bounded(getBillingRuntimeSettings(admin))]);
  if(Object.values(pricing).some(v=>!Number.isFinite(v)||v<0))throw new Error('SLICE_PRICING');
  const upper=calculateTokenCostWithPricing({inputTokens,outputTokens:maxTokens,cacheReadTokens:0,cacheCreationTokens:0},pricing,{},settings).credits;
  const reservedCredits=estimatePreDeductCredits(upper,settings);
  if(!Number.isSafeInteger(reservedCredits)||reservedCredits<Math.max(1,upper)||reservedCredits>1000000)throw new Error('SLICE_BUDGET');
  return {modelId:model.id,providerModel:model.model_id,inputTokens,maxTokens,reservedCredits,pricing,settings,contextHash:createHash('sha256').update(serialized).digest('hex')};
 }
 return {
  async beforeCall(sequence:number,request:unknown){
   // Only a proven undispatched reservation can be reclaimed. SQL rotates its
   // dispatch token under lock; an older process then loses dispatch authority.
   const prior=await call(sequence,'get');
   if(prior&&state.parse(prior).state!=='prepared')throw new Error('SLICE_ALREADY_STARTED');
   const q=await quote(request);
   await bounded(preAICallSecurityChecks({supabase:user,userId:await actor()},prior?0:q.reservedCredits));
   const prepared=state.parse(await call(sequence,'prepare',{sequence,quote:q}));
   if(prepared.state!=='prepared'||!prepared.token)throw new Error('SLICE_ALREADY_STARTED');
   owned.set(sequence,{token:prepared.token,quote:q});
   // Lost dispatch acknowledgement is not permission to dispatch again or refund.
   const dispatched=await call(sequence,'dispatch',{token:prepared.token});
   if(dispatched?.dispatch!==true)throw new Error('SLICE_ALREADY_STARTED');
  },
  async recordCall(e:CallEvidence){
   const own=owned.get(e.sequence);if(!own)throw new Error('SLICE_CALL_CONFLICT');
   if(e.state==='unknown'||e.inputTokens===null||e.outputTokens===null||e.inputTokens>own.quote.inputTokens||e.outputTokens>own.quote.maxTokens){
    await call(e.sequence,'unknown',{token:own.token,observation:{providerId:e.providerId,finishReason:e.finishReason,inputTokens:e.inputTokens,outputTokens:e.outputTokens,usageEvidence:e.usageEvidence}});
    if(e.state!=='unknown')throw new Error('SLICE_USAGE_UNAVAILABLE');
    return;
   }
   // Preserve site pricing semantics: provider cache/reasoning subsets are evidence,
   // not additional tokens on top of the provider's total input/output counts.
   const cost=calculateTokenCostWithPricing({inputTokens:e.inputTokens,outputTokens:e.outputTokens,cacheReadTokens:0,cacheCreationTokens:0},own.quote.pricing,{},own.quote.settings);
   const evidence={providerId:e.providerId,finishReason:e.finishReason,inputTokens:e.inputTokens,outputTokens:e.outputTokens,cacheReadTokens:0,cacheCreationTokens:0,
    credits:Math.min(cost.credits,own.quote.reservedCredits),costUsd:cost.costUsd,outcome:e.state,usageEvidence:e.usageEvidence};
   await call(e.sequence,'evidence',{token:own.token,evidence});
   await call(e.sequence,'settle');
  },
  async recover(){
   const statuses=[];
   for(let sequence=1;sequence<=2;sequence++){
    const current=await call(sequence,'get');if(!current)continue;
    const row=state.parse(current);
    statuses.push(row.state==='responded'?state.parse(await call(sequence,'settle')):row);
   }
   return statuses;
  },
 };
}
