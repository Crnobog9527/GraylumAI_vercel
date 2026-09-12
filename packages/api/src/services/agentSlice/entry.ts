/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {workbenchService} from '../artifacts/workbench';
import {artifactReuse} from '../artifacts/reuse';
import {sliceLinks} from './links';
import {isEmailVerified} from '../../lib/auth';
export const sliceOpenInput=z.object({requestId:z.string().uuid()}).strict();
const targets=z.array(z.object({projectId:z.string().uuid(),roundId:z.string().uuid(),pairId:z.string(),purpose:z.enum(['script','title']),state:z.enum(['draft','published']),version:z.number().int().positive().nullable(),sourceVersion:z.number().int().positive().nullable(),sourceTitle:z.string(),title:z.string(),account:z.string().nullable(),steps:z.array(z.object({id:z.string(),title:z.string()})).min(1)})).max(100);
const sources=z.array(z.object({projectId:z.string().uuid(),sourceVersionId:z.string().uuid(),version:z.number().int().positive(),title:z.string(),account:z.string().nullable(),pairId:z.string(),skillTitle:z.string()})).max(100);
export function sliceEntry(user:SupabaseClient,admin:SupabaseClient){
 async function call(name:'agent_slice_open'|'agent_slice_targets'|'agent_slice_sources',requestId?:string){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
  if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
  const r=await admin.rpc(name,{p_actor_id:auth.data.user.id,...(requestId?{p_request_id:requestId}:{})}).abortSignal(AbortSignal.timeout(10000));
  if(r.error)throw new Error(r.error.code==='42501'?'SLICE_DENIED':'SLICE_UNAVAILABLE');return r.data;
 }
 return {sources:async()=>sources.parse(await call('agent_slice_sources')),open:async(input:z.infer<typeof sliceOpenInput>)=>z.object({conversationId:z.string().uuid()}).parse(await call('agent_slice_open',sliceOpenInput.parse(input).requestId)),targets:async()=>targets.parse(await call('agent_slice_targets'))};
}

export const sliceTargetInput=z.object({projectId:z.string().uuid(),roundId:z.string().uuid(),stepId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),pairId:z.string().max(100)}).strict();
/** Read-only selection check. Admission remains authoritative at send/dispatch. */
async function resolveSliceTarget(user:SupabaseClient,admin:SupabaseClient,input:z.infer<typeof sliceTargetInput>){
 const v=sliceTargetInput.parse(input);
 const work=(await sliceEntry(user,admin).targets()).find(w=>w.projectId===v.projectId&&w.roundId===v.roundId&&w.pairId===v.pairId);
 const step=work?.steps.find(s=>s.id===v.stepId);
 if(!work||!step)return {target:null,executable:false};
 const target={...work,stepId:step.id,stepTitle:step.title};
 if(work.state==='published')return {target,executable:false};
 const snapshot=await workbenchService(user,admin).read(v.projectId,v.roundId);
 if(snapshot.state!=='draft'||!snapshot.steps[v.stepId]||snapshot.steps[v.stepId].available===false)return {target,executable:false};
 // A linked title/revision takes precedence over the original positioning reference.
 // Never fall back to a different source when a selected link is restricted.
 const ancestors=new Set<string>();
 const visit=(id:string)=>{if(ancestors.has(id))return;ancestors.add(id);snapshot.workflow.steps.find(s=>s.id===id)?.dependsOn.forEach(visit);};visit(v.stepId);
 if([...ancestors].some(id=>!snapshot.steps[id]||snapshot.steps[id].available===false))return {target,executable:false};
 const used=new Set([...ancestors].flatMap(id=>snapshot.steps[id].evidenceIds));
 // Match the existing execution input provenance rule, without admitting a request.
 if([...ancestors].some(id=>snapshot.steps[id].provenanceIds.some(e=>!used.has(e))))return {target,executable:false};
 const linked=snapshot.evidence.some(e=>used.has(e.id)&&e.payload&&typeof e.payload==='object'&&!Array.isArray(e.payload)&&e.payload.kind==='skill_handoff');
 if(linked)await sliceLinks(user,admin).read({projectId:v.projectId,roundId:v.roundId});
 else if(!await artifactReuse(user,admin).source({projectId:v.projectId,roundId:v.roundId}))return {target,executable:false};
 return {target,executable:true};
}

export async function readSliceTarget(user:SupabaseClient,admin:SupabaseClient,input:z.infer<typeof sliceTargetInput>){
 let timer:ReturnType<typeof setTimeout>|undefined;
 return Promise.race([resolveSliceTarget(user,admin,input),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
}
