/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
export const continueWorkInput=z.object({requestId:z.string().uuid(),projectId:z.string().uuid(),sourceVersionId:z.string().uuid(),pairId:z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),purpose:z.enum(['script','title']),title:z.string().trim().min(1).max(160),fromRoundId:z.string().uuid().optional()}).strict();
export async function continueSliceWork(user:SupabaseClient,admin:SupabaseClient,input:z.infer<typeof continueWorkInput>){
 const v=continueWorkInput.parse(input);let timer:ReturnType<typeof setTimeout>|undefined;
 const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
 if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
 const r=await admin.rpc('agent_slice_continue_work',{p_actor_id:auth.data.user.id,p_request_id:v.requestId,p_project_id:v.projectId,p_source_version_id:v.sourceVersionId,p_pair_id:v.pairId,p_purpose:v.purpose,p_title:v.title,p_from_round_id:v.fromRoundId??null}).abortSignal(AbortSignal.timeout(10000));
 if(r.error)throw new Error(r.error.code==='42501'?'SLICE_DENIED':'SLICE_TRANSITION_CONFLICT');
 return z.object({projectId:z.string().uuid(),roundId:z.string().uuid()}).parse(r.data);
}
