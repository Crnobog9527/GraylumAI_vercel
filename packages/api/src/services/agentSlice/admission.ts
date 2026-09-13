/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {checkInputSecurity} from '../../middleware/securityChecks';
import {workbenchModelSchema,providerInputReservation} from '../artifacts/modelPolicy';
import {summaryPolicy,assertSeparateSummaryModel} from '../artifacts/summaryPolicy';
import {getModelPricing,getBillingRuntimeSettings,calculateTokenCostWithPricing,estimatePreDeductCredits} from '../billing';
import {preferenceReference} from './preferences';
const uuid=z.string().uuid();
export const sliceAdmissionInput=z.object({conversationId:uuid,requestId:uuid,projectId:uuid,roundId:uuid,stepId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),pairId:z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),body:z.string().trim().min(1).max(2000),preferenceRefs:preferenceReference.array().max(40)}).strict();
const admitted=z.object({requestId:uuid,projectId:uuid,roundId:uuid,revisionId:uuid});
async function deadline<T>(value:PromiseLike<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;return Promise.race([Promise.resolve(value),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));}
export function sliceAdmission(user:SupabaseClient,admin:SupabaseClient){
 return {async begin(input:z.infer<typeof sliceAdmissionInput>){
  const {conversationId,requestId,...payload}=sliceAdmissionInput.parse(input);checkInputSecurity(payload.body);
  const auth=await deadline(user.auth.getUser());if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
  const args={p_actor_id:auth.data.user.id,p_conversation_id:conversationId,p_request_id:requestId};
  const prior=await admin.rpc('agent_slice_admission_replay',{...args,p_payload:payload}).abortSignal(AbortSignal.timeout(10000));
  if(prior.error)throw new Error('SLICE_ADMISSION_CONFLICT');if(prior.data)return admitted.parse(prior.data);
  const binding=await admin.rpc('artifact_query',{p_actor_id:auth.data.user.id,p_action:'resolve',p_project_id:payload.projectId,p_round_id:payload.roundId}).abortSignal(AbortSignal.timeout(10000));
  if(binding.error)throw new Error('SLICE_DENIED');
  const moduleId=uuid.parse(binding.data?.moduleId);
  const moduleRow=await admin.from('modules').select('model_id').eq('id',moduleId).abortSignal(AbortSignal.timeout(10000)).single();
  const settingsRow=await admin.from('system_settings').select('key,value').in('key',['v3_summary_model_id','v3_summary_max_tokens']).abortSignal(AbortSignal.timeout(10000));
  if(moduleRow.error||settingsRow.error)throw new Error('SLICE_MODEL_DENIED');
  const primaryId=uuid.parse(moduleRow.data?.model_id),policy=summaryPolicy(Object.fromEntries(settingsRow.data.map(s=>[s.key,s.value])),primaryId);
  const rows=await admin.from('ai_models').select('*').in('id',[primaryId,policy.modelId]).abortSignal(AbortSignal.timeout(10000));
  if(rows.error)throw new Error('SLICE_MODEL_DENIED');
  const primary=workbenchModelSchema.parse(rows.data.find(r=>r.id===primaryId)),summary=workbenchModelSchema.parse(rows.data.find(r=>r.id===policy.modelId));
  assertSeparateSummaryModel(primary.model_id,summary.model_id);
  if([primary,summary].some(m=>/(^openai\/|gpt)/i.test(m.model_id)))throw new Error('SLICE_MODEL_DENIED');
  const billing=await deadline(getBillingRuntimeSettings(admin));
  let budgetCredits=0;
  for(const [model,multiplier,limit] of [[primary,2,4096],[summary,1,policy.maxTokens]] as const){
   const maxTokens=Math.min(model.max_tokens,limit),inputTokens=providerInputReservation(model,[],maxTokens);
   if(inputTokens===null)throw new Error('SLICE_MODEL_DENIED');
   const pricing=await deadline(getModelPricing(admin,model.model_id,{requireModelPricing:true,modelRecordId:model.id}));
   if(Object.values(pricing).some(x=>!Number.isFinite(x)||x<0))throw new Error('SLICE_PRICING');
   const upper=calculateTokenCostWithPricing({inputTokens,outputTokens:maxTokens,cacheReadTokens:0,cacheCreationTokens:0},pricing,{},billing).credits;
   budgetCredits+=multiplier*estimatePreDeductCredits(upper,billing);
  }
  if(!Number.isSafeInteger(budgetCredits)||budgetCredits<1||budgetCredits>1000000)throw new Error('SLICE_BUDGET');
  const result=await admin.rpc('agent_slice_admit',{...args,p_summary_model_id:policy.modelId,p_summary_max_tokens:policy.maxTokens,p_payload:{...payload,modelId:primaryId,budgetCredits}}).abortSignal(AbortSignal.timeout(10000));
  if(result.error)throw new Error('SLICE_ADMISSION_CONFLICT');return admitted.parse(result.data);
 }};
}
