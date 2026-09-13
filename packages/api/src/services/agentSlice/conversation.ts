/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {sliceResultSchema} from './results';
const cursor=z.object({createdAt:z.string().datetime({offset:true}),executionId:z.string().uuid()}).strict();
export const sliceConversationInput=z.object({conversationId:z.string().uuid(),before:cursor.optional(),limit:z.number().int().min(1).max(20).default(20)}).strict();
const response=z.object({items:z.array(z.object({executionId:z.string().uuid(),createdAt:z.string(),projectId:z.string().uuid(),roundId:z.string().uuid(),stepId:z.string(),pairId:z.string(),stepTitle:z.string(),input:z.string().nullable(),reply:sliceResultSchema,summary:sliceResultSchema})).max(20),nextCursor:cursor.nullable()});
/** Pure read: UI pagination never dispatches a model or settles a request. */
export async function readSliceConversation(user:SupabaseClient,admin:SupabaseClient,input:z.input<typeof sliceConversationInput>){
 const v=sliceConversationInput.parse(input);let timer:ReturnType<typeof setTimeout>|undefined;
 const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
 if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
 const read=await admin.rpc('agent_slice_conversation',{p_actor_id:auth.data.user.id,p_conversation_id:v.conversationId,p_before_time:v.before?.createdAt??null,p_before_id:v.before?.executionId??null,p_limit:v.limit}).abortSignal(AbortSignal.timeout(10000));
 if(read.error)throw new Error(read.error.code==='42501'?'SLICE_DENIED':'SLICE_UNAVAILABLE');
 return response.parse(read.data);
}
