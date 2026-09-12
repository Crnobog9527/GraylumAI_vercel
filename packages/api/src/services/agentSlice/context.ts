/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {checkInputSecurity} from '../../middleware/securityChecks';
import {databaseSkillSource} from '../skills/databaseSource';
import {activateSkill,identityOf} from '../skills/loader';
import {workflowSchema} from '../artifacts/workflow';
import {workbenchService} from '../artifacts/workbench';
import {confirmedPreferences,preferenceReference} from './preferences';
const uuid=z.string().uuid();
const discussion=z.array(z.object({user:z.string().max(2000),assistant:z.string().max(20000)})).max(8);
const context=z.object({discussion,executionId:uuid,conversationId:uuid,projectId:uuid,roundId:uuid,stepId:z.string(),moduleId:uuid,skillId:uuid,revisionId:uuid,packageHash:z.string(),workflow:workflowSchema,
 modelId:uuid,providerModel:z.string(),summaryModelId:uuid.nullable(),summaryProviderModel:z.string().nullable(),summaryMaxTokens:z.number().nullable(),
 preferenceRefs:preferenceReference.array().max(40),evidenceIds:uuid.array(),basis:z.record(z.string(),z.object({version:z.number(),reviewVersion:z.number()})),body:z.string().max(2000)});
async function deadline<T>(value:PromiseLike<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;
 return Promise.race([Promise.resolve(value),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));}
/** Loads only the immutable execution's selected method; never a caller's method text. */
export async function loadSliceContext(user:SupabaseClient,admin:SupabaseClient,executionId:string){
 uuid.parse(executionId);const auth=await deadline(user.auth.getUser());
 if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
 const response=await admin.rpc('agent_slice_context',{p_actor_id:auth.data.user.id,p_execution_id:executionId}).abortSignal(AbortSignal.timeout(10000));
 if(response.error)throw new Error(response.error.code==='42501'?'SLICE_DENIED':'SLICE_CONTEXT_CHANGED');
 const fixed=context.parse(response.data);
 const snapshot=await deadline(workbenchService(user,admin).read(fixed.projectId,fixed.roundId));
 const step=fixed.workflow.steps.find(s=>s.id===fixed.stepId);if(!step||snapshot.packageHash!==fixed.packageHash)throw new Error('SLICE_CONTEXT_CHANGED');
 for(const [key,basis] of Object.entries(fixed.basis)){
  const current=snapshot.steps[key];
  if(!current||current.available===false||current.version!==basis.version||current.reviewVersion!==basis.reviewVersion)throw new Error('SLICE_CONTEXT_CHANGED');
 }
 const source=databaseSkillSource({userClient:user,privateClient:admin,moduleId:fixed.moduleId,skillId:fixed.skillId,revisionId:fixed.revisionId});
 const descriptor=(await deadline(source.list()))[0];
 if(!descriptor||descriptor.packageHash!==fixed.packageHash)throw new Error('SLICE_CONTEXT_CHANGED');
 const loaded=await deadline(activateSkill(source,identityOf(descriptor),{resources:step.resources,maxContextBytes:2097152}));
 const preferences=await deadline(confirmedPreferences(user,admin).resolve(fixed.preferenceRefs));
 const data={instruction:fixed.body,discussion:fixed.discussion,preferences:preferences.map(p=>({scope:p.scope,name:p.name,value:p.value})),
  step:{id:step.id,title:step.title,minLength:step.minLength,maxLength:step.maxLength},
  currentStepResult:{body:snapshot.steps[step.id].body,version:snapshot.steps[step.id].version},
  steps:Object.fromEntries(Object.keys(fixed.basis).filter(key=>key!==step.id).map(key=>[key,{body:snapshot.steps[key].body,version:snapshot.steps[key].version}]))};
 checkInputSecurity(JSON.stringify(data));
 return {fixed,data,loaded};
}
