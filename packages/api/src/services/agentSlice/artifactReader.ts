/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {checkInputSecurity} from '../../middleware/securityChecks';

const uuid=z.string().uuid();
// Constructed and persisted by the admission service from a selected report,
// never accepted as a model tool argument. No latest-version lookup.
export const formalArtifactSelection=z.object({
 projectId:uuid,roundId:uuid,versionId:uuid,version:z.number().int().positive(),
 hash:z.string().regex(/^[a-f0-9]{64}$/),targetProjectId:uuid,targetRoundId:uuid,
 account:z.string().min(1).max(160),
 sections:z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(32)
  .refine(value=>new Set(value).size===value.length),
 maxChars:z.number().int().min(1).max(20000),
}).strict();

const source=z.object({kind:z.literal('formal_report'),version:z.number().int().positive(),sections:z.array(z.object({title:z.string(),body:z.string()})).min(1).max(32)});
/** One production reader: SQL resolves the execution's immutable source and current permission. */
export async function readSelectedArtifact(user:SupabaseClient,admin:SupabaseClient,executionId:string){
 uuid.parse(executionId);let timer:ReturnType<typeof setTimeout>|undefined;
 const auth=await Promise.race([user.auth.getUser(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SLICE_UNAVAILABLE')),10000);})]).finally(()=>clearTimeout(timer));
 if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('SLICE_DENIED');
 const selected=await admin.rpc('agent_slice_selected_source',{p_actor_id:auth.data.user.id,p_execution_id:executionId}).abortSignal(AbortSignal.timeout(10000));
 if(selected.error)throw new Error('SLICE_SOURCE_UNAVAILABLE');
 const body=JSON.stringify(source.parse(selected.data));checkInputSecurity(body);return body;
}
