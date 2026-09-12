/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {formalArtifactSelection,bindFormalArtifactReader} from './artifactReader';
import {workbenchService} from '../artifacts/workbench';
export const sliceLinkScope=z.object({projectId:z.string().uuid(),roundId:z.string().uuid()}).strict();
export const sliceLinkInput=sliceLinkScope.extend({sourceVersionId:z.string().uuid(),pairId:z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),requestId:z.string().uuid()}).strict();
export function sliceLinks(user:SupabaseClient,admin:SupabaseClient|null){
 async function call(name:string,input:z.infer<typeof sliceLinkScope>,extra:Record<string,unknown>={}){
  if(!admin)throw new Error('ARTIFACT_UNAVAILABLE');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('ARTIFACT_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
  if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('ARTIFACT_DENIED');
  const r=await admin.rpc(name,{p_actor_id:auth.data.user.id,p_project_id:input.projectId,p_round_id:input.roundId,...extra}).abortSignal(AbortSignal.timeout(10000));
  if(r.error)throw new Error(r.error.code==='42501'?'ARTIFACT_DENIED':'ARTIFACT_EVIDENCE_UNAVAILABLE');
  return r.data;
 }
 const read=async(input:z.infer<typeof sliceLinkScope>)=>formalArtifactSelection.parse(await call('agent_slice_link_read',sliceLinkScope.parse(input)));
 return {
  async link(input:z.infer<typeof sliceLinkInput>){const v=sliceLinkInput.parse(input);return z.object({evidenceId:z.string().uuid()}).parse(await call('agent_slice_link',v,{p_source_version_id:v.sourceVersionId,p_pair_id:v.pairId,p_request_id:v.requestId}));},
  read,
  async reader(input:z.infer<typeof sliceLinkScope>){
   const frozen=await read(input);
   return async()=>{
    const current=await read(input);
    if(JSON.stringify(current)!==JSON.stringify(frozen))throw new Error('ARTIFACT_EVIDENCE_UNAVAILABLE');
    return bindFormalArtifactReader(workbenchService(user,admin),frozen)();
   };
  },
 };
}
