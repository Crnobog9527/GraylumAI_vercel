/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { protectedProcedure,router } from '../trpc';
import { runtimeAdmissionService,runtimeAdmission,runtimeMaterialInput } from '../services/runtime/admission';
import {loadStagingPolicy,loadStagingRecoveryPolicy,assertStagingReadAccess} from '../services/runtime/stagingPolicy';
import {StagingAccessError,stagingProcedureError} from '../services/runtime/stagingErrors';
import {stagingTransport} from '../services/runtime/stagingTransport';
import {retainedOutputReason} from '../services/runtime/view';
import { runtimeExecutor } from '../services/runtime/execute';
import {runtimeActor} from '../services/runtime/actor';
import { databaseSkillSource } from '../services/skills/databaseSource';
import { discoverSkills } from '../services/skills/loader';
import { activateRuntimeCandidate } from '../services/runtime/matching';

/** Loopback tests remain separate from the explicitly enabled Staging host. */
function localEndpoint(){
 const endpoint=process.env.V3_RUNTIME_LOCAL_ENDPOINT;
 for(const value of [endpoint,process.env.NEXT_PUBLIC_SUPABASE_URL]){
  if(!value)throw new Error('RUNTIME_DISABLED');const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password)throw new Error('RUNTIME_DISABLED');
 }
 return endpoint!;
}
// Viewing original state, cancellation and receipt maintenance do not admit
// new work. Source/actor checks still run in their existing SQL procedures.
const maintenanceProcedure=protectedProcedure.use(async({ctx,next,path})=>{
 let maintenanceEndpoint:string|undefined;
 try {
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
  try{maintenanceEndpoint=localEndpoint();}catch{await assertStagingReadAccess(ctx.supabaseAdmin,ctx.user.id,process.env);}
 } catch(cause) { throw stagingProcedureError(cause,path); }
 const result=await next({ctx:{...ctx,maintenanceEndpoint}});
 if(!result.ok)throw stagingProcedureError(result.error,path);
 return result;
});
const procedure=protectedProcedure.use(async({ctx,next,path})=>{
 try{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
  let endpoint:string|undefined,real;
  try{endpoint=localEndpoint();}catch{real=await loadStagingPolicy(ctx.supabaseAdmin,ctx.user.id,process.env);}
  const actor=runtimeActor(ctx.userScopedSupabase.auth,ctx.user.id,ctx.runtimeBudget,ctx.headers?.get('Authorization'));
  const admission=runtimeAdmissionService(ctx.userScopedSupabase,ctx.supabaseAdmin,{...(real?{real}:{}),account:'runtime-local',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:32000,historyItems:100,searchEnabled:!real,workspaceContext:true});
  const executor=runtimeExecutor({database:ctx.supabaseAdmin,budget:ctx.runtimeBudget,actor,endpoint,...(real?{adapter:stagingTransport(ctx.supabaseAdmin,real,ctx.runtimeBudget)}:{}),activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)});
  const result=await next({ctx:{...ctx,admission,executor,real}});
  if(!result.ok)throw result.error;
  return result;
 }catch(cause){throw stagingProcedureError(cause,path);}
});
export const runtimeRouter=router({
 choices:procedure.input(z.object({sessionId:z.string().uuid().optional()}).optional()).query(async({ctx,input})=>{
  let work=false;let workModuleId:string|null=null;let workRevisionId:string|null=null;
  if(input?.sessionId){const listing=await ctx.supabaseAdmin!.rpc('opc_query',{p_actor_id:ctx.user.id});if(!listing.error){const item=(listing.data.accounts??[]).flatMap((a:{items:Array<{sessionId:string;workItemId:string;moduleId?:string;methodRevisionId?:string}>})=>a.items).find((i:{sessionId:string})=>i.sessionId===input.sessionId);work=Boolean(item);if(item){workModuleId=item.moduleId??null;workRevisionId=item.methodRevisionId??null;}}}

  // Loopback advertises the curated ordinary model. Free-chat skills must use
  // that same model, excluding fault/organizer fixtures without name matching.
  const modelQuery=ctx.supabaseAdmin!.from('ai_models').select('id,name').eq('is_active','true');
  const models=await (ctx.real?modelQuery.in('id',ctx.real.callPolicies.map(q=>q.modelId)):modelQuery.eq('provider','fixture').eq('name','Runtime local'));
  if(models.error)throw new Error('RUNTIME_MODELS_UNAVAILABLE');
  const visible=await ctx.userScopedSupabase.from('modules').select('id,active').eq('active',true).limit(64);
  if(visible.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  // Respect the narrow public column grant; private metadata is fetched only
  // for visible modules and the loader independently rechecks current access.
  const modules=visible.data.length?await ctx.supabaseAdmin!.from('modules').select('id,skill_id,title,model_id').in('id',visible.data.map(m=>m.id)).eq('active',true):{data:[],error:null};
  if(modules.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  const skills:Array<{moduleId:string;revisionId:string;name:string}>=[];
  for(const m of modules.data){if(!m.skill_id||(ctx.real&&!ctx.real.callPolicies.some(q=>q.modelId===m.model_id)))continue;try{
   const source=databaseSkillSource({userClient:ctx.userScopedSupabase,privateClient:ctx.supabaseAdmin,moduleId:m.id,skillId:m.skill_id,...(m.id===workModuleId&&workRevisionId?{revisionId:workRevisionId}:{})});
   const descriptors=await source.list();
   const list=await discoverSkills(source);
   for(const s of list.filter(()=>ctx.real||work||models.data.some(model=>model.id===m.model_id))){
    const descriptor=descriptors.find(d=>d.revisionId===s.public.revisionId);
    if(!descriptor||Object.keys(descriptor.tasks).length)continue;
    skills.push({moduleId:m.id,revisionId:s.public.revisionId,name:m.title});
   }
  }catch{/* unavailable packages are not advertised as runnable */}}
  return {models:models.data,skills,defaultSkill:skills.find(skill=>skill.moduleId===workModuleId)??null,mode:ctx.real?'staging_test' as const:'isolated' as const};
 }),
 start:procedure.input(z.object({requestId:z.string().uuid(),scope:z.unknown()}).strict()).mutation(({ctx,input})=>ctx.admission.start(input.requestId,input.scope)),
 saveMaterial:procedure.input(runtimeMaterialInput).mutation(({ctx,input})=>ctx.admission.saveMaterial(input)),
 revokeMaterial:procedure.input(z.object({sessionId:z.string().uuid(),revision:z.number().int().positive()}).strict()).mutation(({ctx,input})=>ctx.admission.revokeMaterial(input.sessionId,input.revision)),
 prepare:procedure.input(runtimeAdmission).mutation(({ctx,input})=>ctx.admission.prepare(input)),
 cancel:maintenanceProcedure.input(z.object({executionId:z.string().uuid()}).strict()).mutation(async({ctx,input})=>{
  const r=await ctx.supabaseAdmin!.rpc('runtime_cancel',{p_actor_id:ctx.user.id,p_execution_id:input.executionId});
  if(r.error)throw new Error('RUNTIME_CANCEL_DENIED');return r.data;
 }),
 execute:maintenanceProcedure.input(z.object({executionId:z.string().uuid()}).strict()).mutation(async({ctx,input})=>{
  const actor=runtimeActor(ctx.userScopedSupabase.auth,ctx.user.id,ctx.runtimeBudget,ctx.headers?.get('Authorization'));
  const outcome=async<T extends {state:string}>(result:T)=>{
   if(!['cancelled','cost_pending'].includes(result.state))return result;
   const reason=await retainedOutputReason(ctx.supabaseAdmin!,ctx.user.id,input.executionId);
   return {...result,...(reason?{unavailable:reason}:{})};
  };
  if(ctx.maintenanceEndpoint)return outcome(await runtimeExecutor({database:ctx.supabaseAdmin!,budget:ctx.runtimeBudget,actor,endpoint:ctx.maintenanceEndpoint,activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)}).execute(input.executionId));
  try{await loadStagingPolicy(ctx.supabaseAdmin!,ctx.user.id,process.env);}catch{
   const original=await loadStagingRecoveryPolicy(ctx.supabaseAdmin!,ctx.user.id,input.executionId,process.env);
   // This branch never constructs/runs an SDK request. It only looks up the
   // persisted original provider ID and finishes existing financial state.
   if(process.env.V3_RUNTIME_STAGING_ENABLED!=='true'){
    // An explicit host stop also closes this original execution. A failed or
    // lost cancellation response is inspected by financial recovery below;
    // there is no repeated cancellation or assumption of a refund.
    await ctx.supabaseAdmin!.rpc('runtime_cancel',{p_actor_id:ctx.user.id,p_execution_id:input.executionId});
   }
   const adapter=stagingTransport(ctx.supabaseAdmin!,original,ctx.runtimeBudget);
   const state=await runtimeExecutor({database:ctx.supabaseAdmin!,budget:ctx.runtimeBudget,actor,adapter:{dispatch:async()=>{throw new Error('RUNTIME_DISPATCH_DISABLED');},lookup:adapter.lookup}}).recoverFinancial(input.executionId);
   return outcome({state:state.state});
  }
  // Execution/recovery always uses its original quote and credential namespace,
  // even if a later test window is now selected in the host environment.
  const original=await loadStagingRecoveryPolicy(ctx.supabaseAdmin!,ctx.user.id,input.executionId,process.env);
  return outcome(await runtimeExecutor({database:ctx.supabaseAdmin!,budget:ctx.runtimeBudget,actor,adapter:stagingTransport(ctx.supabaseAdmin!,original,ctx.runtimeBudget),activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)}).execute(input.executionId));
 }),
 view:maintenanceProcedure.input(z.object({sessionId:z.string().uuid()}).strict()).query(async({ctx,input})=>{
  const result=await ctx.supabaseAdmin!.rpc('runtime_view',{p_actor_id:ctx.user.id,p_session_id:input.sessionId});if(result.error)throw new Error('RUNTIME_VIEW_DENIED');return {...result.data,mode:ctx.maintenanceEndpoint?'isolated':'staging_test'};
 }),
});
