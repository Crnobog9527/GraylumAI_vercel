/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {sliceCallId} from './accounting';
export const sliceRecoveryInput=z.object({executionId:z.string().uuid()}).strict();
const callState=z.object({state:z.enum(['prepared','dispatched','unknown','responded','settled','refunded'])});
/** Financial recovery never loads a method, source, model credential or answer. */
export async function recoverSlice(user:SupabaseClient,admin:SupabaseClient,input:z.infer<typeof sliceRecoveryInput>){
 const {executionId}=sliceRecoveryInput.parse(input);let timer:ReturnType<typeof setTimeout>|undefined;
 const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
 if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
 const statuses=[];
 for(const [phase,sequence] of [['reply',1],['reply',2],['summary',1]] as const){
  const args={p_actor_id:auth.data.user.id,p_execution_id:executionId,p_call_id:sliceCallId(executionId,sequence,phase)};
  const read=await admin.rpc('agent_slice_call',{...args,p_action:'get'}).abortSignal(AbortSignal.timeout(10000));
  if(read.error)throw new Error(read.error.code==='42501'?'SLICE_DENIED':'SLICE_UNAVAILABLE');
  if(!read.data)continue;
  let current=callState.parse(read.data);
  if(current.state==='responded'){
   const settled=await admin.rpc('agent_slice_call',{...args,p_action:'settle'}).abortSignal(AbortSignal.timeout(10000));
   if(settled.error)throw new Error('SLICE_UNAVAILABLE');current=callState.parse(settled.data);
  }
  statuses.push({phase,sequence,state:current.state});
 }
 return {calls:statuses};
}
