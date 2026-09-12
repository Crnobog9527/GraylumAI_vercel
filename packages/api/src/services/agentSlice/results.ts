/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {filterAIOutput} from '../aiOutputFilter';
import {echoesPrivateMethod} from '../artifacts/generation';
const scope=z.object({executionId:z.string().uuid(),phase:z.enum(['reply','summary'])}).strict();
const result=z.discriminatedUnion('state',[
 z.object({state:z.literal('pending')}),z.object({state:z.literal('restricted')}),
 z.object({state:z.literal('saved'),candidateId:z.string().uuid(),body:z.string(),projectId:z.string().uuid(),roundId:z.string().uuid(),stepId:z.string(),adoptable:z.boolean()}),
]);
/** Saving is private to the method-loaded executor, never a public raw-body RPC. */
export function sliceResults(user:SupabaseClient,admin:SupabaseClient){
 async function call(input:z.infer<typeof scope>,action:'read'|'save',body?:string){
  const v=scope.parse(input);let timer:ReturnType<typeof setTimeout>|undefined;
  const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
  if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
  const response=await admin.rpc('agent_slice_result',{p_actor_id:auth.data.user.id,p_execution_id:v.executionId,p_phase:v.phase,p_action:action,p_body:body??null}).abortSignal(AbortSignal.timeout(10000));
  if(response.error)throw new Error(response.error.code==='42501'?'SLICE_DENIED':'SLICE_RESULT_CONFLICT');
  return result.parse(response.data);
 }
 return {
  read:(input:z.infer<typeof scope>)=>call(input,'read'),
  save:async(input:z.infer<typeof scope>,body:string,loadedPrivateMethod:string)=>{
   z.string().max(20000).parse(body);
   const filtered=filterAIOutput(body);
   if(filtered.blocked||!filtered.content.trim()||echoesPrivateMethod(body,loadedPrivateMethod)||echoesPrivateMethod(filtered.content,loadedPrivateMethod))throw new Error('SLICE_OUTPUT_RESTRICTED');
   return call(input,'save',filtered.content);
  },
 };
}
