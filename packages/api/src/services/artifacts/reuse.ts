/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isEmailVerified } from '../../lib/auth';
const uuid = z.string().uuid();
export const createWorkInput = z.object({
  projectId: uuid, roundId: uuid, requestId: uuid,
  sourceVersionId: uuid, configId: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
  title: z.string().trim().min(1).max(160), fromRoundId: uuid.optional(),
}).strict();
export const workSourceScope = z.object({projectId:uuid,roundId:uuid}).strict();
export const sourceSchema = z.object({
  evidenceId: uuid, sourceProjectId: uuid, sourceRoundId: uuid, sourceVersionId: uuid,
  version: z.number().int().positive(), hash:z.string(), configId:z.string(),
  sections:z.array(z.object({title:z.string(),stepId:z.string(),body:z.string(),confirmationId:uuid,evidenceIds:z.array(uuid)})),
});
export function artifactReuse(userClient:SupabaseClient, privateClient:SupabaseClient|null) {
  async function rpc(name:string,args:Record<string,unknown>) {
    if(typeof window!=='undefined'||!privateClient)throw new Error('ARTIFACT_UNAVAILABLE');
    const auth=await userClient.auth.getUser();
    if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('ARTIFACT_DENIED');
    const result=await privateClient.rpc(name,{...args,p_actor_id:auth.data.user.id}).abortSignal(AbortSignal.timeout(10000));
    if(result.error)throw new Error(result.error.code==='42501'?'ARTIFACT_DENIED':'ARTIFACT_REFERENCE_UNAVAILABLE');
    return result.data;
  }
  return {
    async create(input:z.infer<typeof createWorkInput>) {
      const {projectId,roundId,requestId,...payload}=createWorkInput.parse(input);
      return workSourceScope.parse(await rpc('artifact_create_work',{p_project_id:projectId,p_round_id:roundId,p_request_id:requestId,p_payload:payload}));
    },
    async source(input:z.infer<typeof workSourceScope>) {
      const v=workSourceScope.parse(input);
      return sourceSchema.nullable().parse(await rpc('artifact_work_source',{p_project_id:v.projectId,p_round_id:v.roundId}));
    },
    async choices(sourceVersionId:string) {
      return z.array(z.object({id:z.string(),label:z.string()})).parse(await rpc('artifact_reference_choices',{p_source_version_id:uuid.parse(sourceVersionId)}));
    },
  };
}
