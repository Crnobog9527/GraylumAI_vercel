/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {isEmailVerified} from '../../lib/auth';
import {databaseSkillSource} from '../skills/databaseSource';
import {validateWorkflow,type Workflow} from './workflow';
const uuid=z.string().uuid();
const scope=z.object({projectId:uuid,roundId:uuid}).strict();
const step=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const mutation={...scope.shape,requestId:uuid};
const evidenceIds=z.array(uuid).max(64).refine(v=>new Set(v).size===v.length);
export const commandSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('read'),...scope.shape}).strict(),
 z.object({action:z.literal('report'),...scope.shape}).strict(),
 z.object({action:z.literal('save'),...mutation,stepId:step,expectedVersion:z.number().int().nonnegative(),body:z.string().max(20000),evidenceIds}).strict(),
 z.object({action:z.literal('candidate'),...mutation,stepId:step,body:z.string().max(20000),evidenceIds}).strict(),
 z.object({action:z.literal('confirm'),...mutation,stepId:step,expectedVersion:z.number().int().nonnegative()}).strict(),
 z.object({action:z.literal('publish'),...mutation}).strict(),
 z.object({action:z.literal('abandon'),...mutation}).strict(),
 z.object({action:z.literal('researchEvidence'),...mutation,planId:uuid,operationId:uuid}).strict(),
 z.object({action:z.literal('userEvidence'),...mutation,body:z.string().min(1).max(20000),observedAt:z.string().datetime().nullable(),supersedes:uuid.nullable()}).strict(),
 z.object({action:z.literal('restrictEvidence'),...mutation,evidenceId:uuid,deleted:z.boolean(),expiresAt:z.string().datetime().nullable()}).strict(),
]);
export type ArtifactCommand=z.infer<typeof commandSchema>;
/** Server-only factory. Registrations are host-reviewed PUBLIC UI data, never an
 * untrusted request payload. No browser route, provider, model or environment load.
 * actorId is never accepted from commands; every call uses verified getUser. */
export function databaseArtifactStore(options:{userClient:SupabaseClient;privateClient:SupabaseClient|null;
 moduleId:string;skillId:string;registrations:Readonly<Record<string,{revisionId:string;workflow:Workflow}>>}) {
 const {userClient,privateClient,moduleId,skillId}=options;
 const registrations=structuredClone(options.registrations);
 async function actor(){
  if(typeof window!=='undefined'||!privateClient)throw new Error('ARTIFACT_UNAVAILABLE');
  const auth=await userClient.auth.getUser();
  if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('ARTIFACT_UNAVAILABLE');
  return auth.data.user.id;
 }
 async function call(actorId:string,action:string,projectId:string,roundId:string,requestId:string|null,payload:Record<string,unknown>){
  const {data,error}=await privateClient!.rpc('artifact_transition',{p_actor_id:actorId,p_module_id:moduleId,p_skill_id:skillId,p_action:action,p_project_id:projectId,p_round_id:roundId,p_request_id:requestId,p_payload:payload}).abortSignal(AbortSignal.timeout(10000));
  if(error)throw new Error(['42501','P0001','23505','23514','40001'].includes(error.code)?'ARTIFACT_CONFLICT_OR_DENIED':'ARTIFACT_UNAVAILABLE');
  return data;
 }
 return {
  async start(input:{projectId:string;roundId:string;requestId:string;registration:string;account:string|null;fromRoundId?:string}){
   const v=z.object({projectId:uuid,roundId:uuid,requestId:uuid,registration:z.string().min(1).max(100),account:z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,159}$/).nullable(),fromRoundId:uuid.optional()}).strict().parse(input);
   const actorId=await actor(),entry=registrations[v.registration];if(!entry)throw new Error('ARTIFACT_INVALID_WORKFLOW');
   const source=databaseSkillSource({userClient,privateClient,moduleId,skillId,revisionId:entry.revisionId});
   const [descriptor]=await source.list();const workflow=validateWorkflow(entry.workflow,descriptor);
   if((workflow.kind==='social')!==(v.account!==null))throw new Error('ARTIFACT_INVALID_WORKFLOW');
   return call(actorId,'start',v.projectId,v.roundId,v.requestId,{account:v.account,fromRoundId:v.fromRoundId??null,revisionId:descriptor.revisionId,packageHash:descriptor.packageHash,workflow});
  },
  async execute(input:ArtifactCommand){
   const value=commandSchema.parse(input),actorId=await actor();
   const {action,projectId,roundId,...rest}=value;
   const requestId='requestId' in rest?rest.requestId:null;
   const payload={...rest};if('requestId' in payload)delete (payload as {requestId?:string}).requestId;
   // SQL checks the fixed package on writes. RLS module visibility is also checked
   // with the user client, never with an unverified caller's service identity.
   if(!['read','report','restrictEvidence','abandon'].includes(action)){
    const visible=await userClient.from('modules').select('id,active').eq('id',moduleId).eq('active',true).single();
    if(visible.error||visible.data?.id!==moduleId)throw new Error('ARTIFACT_UNAVAILABLE');
   }
   return call(actorId,action,projectId,roundId,requestId,payload);
  },
 };
}
