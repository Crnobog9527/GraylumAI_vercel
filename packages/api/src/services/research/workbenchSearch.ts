/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isEmailVerified } from '../../lib/auth';
import { checkRateLimitAsync, preAICallSecurityChecks } from '../../middleware/securityChecks';
import { databaseSkillSource } from '../skills/databaseSource';
import { activateSkill, identityOf } from '../skills/loader';
import { workflowSchema } from '../artifacts/workflow';
import { snapshotSchema } from '../artifacts/public';
import { connectAgentKey, researchIdentity, type AdapterOptions } from './agentKey';
import { databaseBilledResearchStore, type OperationRecord } from './store';
import { tavilyCapabilities, tavilyContract, tavilyParameters as parameters } from './tavilyContract';

const uuid=z.string().uuid();
export const workbenchSearchInput=z.object({
 projectId:uuid,roundId:uuid,requestId:uuid,
 stepId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
 query:z.string().min(1).max(200).refine(value=>value===value.trim()),
}).strict();
type Input=z.infer<typeof workbenchSearchInput>;
type Connection=Awaited<ReturnType<typeof connectAgentKey>>;

const publicResult=(requestId:string,value:OperationRecord)=>({requestId,state:value.state,
 result:value.result?{objects:value.result.objects,fetchedAt:value.result.fetchedAt,pagination:value.result.pagination,fixture:value.result.fixture}:null,
 restricted:value.resultAccess==='restricted',
});
/** One explicit query, one durable operation, no model-selected tools or hidden
 * context transfer. Factory injection is server-only and used by local tests. */
export function workbenchSearch(userClient:SupabaseClient,privateClient:SupabaseClient|null,
 connect:(options:AdapterOptions)=>Promise<Connection>=options=>connectAgentKey(options,process.env.AGENTKEY_API_KEY??'')) {
 async function actor(){
  if(typeof window!=='undefined'||!privateClient)throw new Error('RESEARCH_DISABLED');
  const auth=await userClient.auth.getUser();
  if(auth.error||!auth.data.user||!isEmailVerified(auth.data.user))throw new Error('ARTIFACT_DENIED');
  return auth.data.user.id;
 }
 async function resolve(input:Input,id:string){
  if(await actor()!==id)throw new Error('ARTIFACT_DENIED');
  const fixed=await privateClient!.rpc('artifact_query',{p_actor_id:id,p_project_id:input.projectId,p_round_id:input.roundId,p_action:'resolve'});
  if(fixed.error)throw new Error('ARTIFACT_DENIED');
  const binding=z.object({moduleId:uuid,skillId:uuid,revisionId:uuid,workflow:workflowSchema}).parse(fixed.data);
  if(!binding.workflow.steps.some(step=>step.id===input.stepId))throw new Error('RESEARCH_SCOPE_UNAVAILABLE');
  return binding;
 }
 async function admission(input:Input,id:string){
  const binding=await resolve(input,id);
  const read=await privateClient!.rpc('artifact_query',{p_actor_id:id,p_project_id:input.projectId,p_round_id:input.roundId,p_action:'read'});
  if(read.error)throw new Error('ARTIFACT_DENIED');
  const snapshot=snapshotSchema.parse(read.data),step=binding.workflow.steps.find(s=>s.id===input.stepId);
  if(!step||snapshot.state!=='draft')throw new Error('RESEARCH_SCOPE_UNAVAILABLE');
  const source=databaseSkillSource({userClient,privateClient,...binding}),descriptor=(await source.list())[0];
  if(descriptor.packageHash!==snapshot.packageHash)throw new Error('RESEARCH_SCOPE_UNAVAILABLE');
  // Validate required resources locally. None of their content enters params.
  await activateSkill(source,identityOf(descriptor),{resources:step.resources,maxContextBytes:2097152});
 }
 return {
  async cancel(raw:Input){
   const input=workbenchSearchInput.parse(raw),id=await actor();
   await resolve(input,id);
   const store=databaseBilledResearchStore(privateClient!,id);
   const identityHash=researchIdentity(tavilyCapabilities[0],parameters(input.query),{projectId:input.projectId,roundId:input.roundId,stepId:input.stepId});
   const lookup=await privateClient!.rpc('research_lookup',{p_actor_id:id,p_plan_id:input.requestId,p_operation_id:input.requestId});
   if(lookup.error)throw new Error('RESEARCH_STATE_UNAVAILABLE');
   if(lookup.data&&lookup.data.identityHash!==identityHash)throw new Error('RESEARCH_IDENTITY_CONFLICT');
   return {cancelled:(await store.cancel(input.requestId))===true};
  },
  async search(raw:Input){
   const input=workbenchSearchInput.parse(raw),id=await actor();
   await resolve(input,id);
   const store=databaseBilledResearchStore(privateClient!,id);
   const params=parameters(input.query);
   const scope={projectId:input.projectId,roundId:input.roundId,stepId:input.stepId};
   const identityHash=researchIdentity(tavilyCapabilities[0],params,scope);
   // Lookup never creates an intent. Only an exact existing terminal request
   // may recover without consuming the new-provider-call rate allowance.
   const lookup=await privateClient!.rpc('research_lookup',{p_actor_id:id,p_plan_id:input.requestId,p_operation_id:input.requestId});
   if(lookup.error)throw new Error('RESEARCH_STATE_UNAVAILABLE');
   const existing=lookup.data as OperationRecord|null;
   if(existing&&existing.identityHash!==identityHash)throw new Error('RESEARCH_IDENTITY_CONFLICT');
   if(existing&&existing.state!=='prepared'){
    const recovered=await store.get(input.requestId,input.requestId);
    if(!recovered)throw new Error('RESEARCH_STATE_UNAVAILABLE');
    return publicResult(input.requestId,recovered);
   }
   await checkRateLimitAsync(id,'ai');
   await store.create(input.requestId,1100000,[{operationId:input.requestId,identityHash,maxQuoteUnits:1100000}]);
   const previous=await store.get(input.requestId,input.requestId);
   if(previous&&previous.identityHash!==identityHash)throw new Error('RESEARCH_IDENTITY_CONFLICT');
   if(previous&&previous.state!=='prepared')return publicResult(input.requestId,previous);
   await admission(input,id);
   const settings=await privateClient!.from('system_settings').select('key,value').in('key',['v3_web_search','search_surcharge_credits']);
   if(settings.error||settings.data?.find(s=>s.key==='v3_web_search')?.value!==true)throw new Error('RESEARCH_DISABLED');
   const price=settings.data.find(s=>s.key==='search_surcharge_credits')?.value;
   if(!Number.isSafeInteger(price)||price<1||price>999999)throw new Error('RESEARCH_BILLING_UNAVAILABLE');
   await preAICallSecurityChecks({supabase:privateClient!,userId:id},previous?0:price,{skipRateLimit:true});
   const authorize=async()=>{
    await admission(input,id);
    const flag=await privateClient!.from('system_settings').select('value').eq('key','v3_web_search').single();
    if(flag.error||flag.data?.value!==true)throw new Error('RESEARCH_DISABLED');
    await preAICallSecurityChecks({supabase:privateClient!,userId:id},0,{skipRateLimit:true});
   };
   const connection=await connect({store,scope,capabilities:tavilyCapabilities,contract:tavilyContract,authorize,timeoutMs:15000,maxResponseBytes:262144,maxCalls:4,maxPages:1});
   try {
    await connection.discover('Tavily web search');
    await connection.createPlan(input.requestId,1.1,[{operationId:input.requestId,capability:'tavily.webSearch',params}]);
    await connection.execute({planId:input.requestId,operationId:input.requestId,capability:'tavily.webSearch',params});
    const result=await store.get(input.requestId,input.requestId);
    if(!result)throw new Error('RESEARCH_STATE_UNAVAILABLE');
    return publicResult(input.requestId,result);
   } finally {await connection.close().catch(()=>{});}
  },
 };
}
