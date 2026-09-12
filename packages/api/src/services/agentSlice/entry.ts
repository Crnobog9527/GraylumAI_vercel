/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
export const sliceOpenInput=z.object({requestId:z.string().uuid()}).strict();
const targets=z.array(z.object({projectId:z.string().uuid(),roundId:z.string().uuid(),pairId:z.string(),purpose:z.enum(['script','title']),title:z.string(),account:z.string().nullable(),steps:z.array(z.object({id:z.string(),title:z.string()})).min(1)})).max(100);
export function sliceEntry(user:SupabaseClient,admin:SupabaseClient){
 async function call(name:'agent_slice_open'|'agent_slice_targets',requestId?:string){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
  if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
  const r=await admin.rpc(name,{p_actor_id:auth.data.user.id,...(requestId?{p_request_id:requestId}:{})}).abortSignal(AbortSignal.timeout(10000));
  if(r.error)throw new Error(r.error.code==='42501'?'SLICE_DENIED':'SLICE_UNAVAILABLE');return r.data;
 }
 return {open:async(input:z.infer<typeof sliceOpenInput>)=>z.object({conversationId:z.string().uuid()}).parse(await call('agent_slice_open',sliceOpenInput.parse(input).requestId)),targets:async()=>targets.parse(await call('agent_slice_targets'))};
}
