/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure,router } from '../trpc';
import { runtimeAdmissionService,runtimeAdmission,runtimeMaterialInput } from '../services/runtime/admission';
import {loadStagingPolicy,loadStagingRecoveryPolicy,assertStagingReadAccess} from '../services/runtime/stagingPolicy';
import {stagingTransport} from '../services/runtime/stagingTransport';
import { runtimeExecutor } from '../services/runtime/execute';
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
const maintenanceProcedure=protectedProcedure.use(async({ctx,next})=>{
 if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new TRPCError({code:'PRECONDITION_FAILED'});
 let maintenanceEndpoint:string|undefined;
 try{maintenanceEndpoint=localEndpoint();}catch{await assertStagingReadAccess(ctx.supabaseAdmin,ctx.user.id,process.env);}
 return next({ctx:{...ctx,maintenanceEndpoint}});
});
const procedure=protectedProcedure.use(async({ctx,next})=>{
 try{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('RUNTIME_DISABLED');
  let endpoint:string|undefined,real;
  try{endpoint=localEndpoint();}catch{real=await loadStagingPolicy(ctx.supabaseAdmin,ctx.user.id,process.env);}
  const actor=async()=>{const a=await ctx.userScopedSupabase.auth.getUser();if(a.error||!a.data.user||a.data.user.id!==ctx.user.id)throw new Error('RUNTIME_DENIED');return a.data.user.id;};
  const admission=runtimeAdmissionService(ctx.userScopedSupabase,ctx.supabaseAdmin,{...(real?{real}:{}),account:'runtime-local',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:32000,historyItems:100,searchEnabled:!real});
  const executor=runtimeExecutor({database:ctx.supabaseAdmin,actor,endpoint,...(real?{adapter:stagingTransport(ctx.supabaseAdmin,real)}:{}),activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)});
  const result=await next({ctx:{...ctx,admission,executor,real}});
  if(!result.ok)throw new Error('RUNTIME_UNAVAILABLE');
  return result;
 }catch{throw new TRPCError({code:'PRECONDITION_FAILED',message:'当前执行不可用，请检查原任务状态；未发送的请求不会自动重试。'});}
});
export const runtimeRouter=router({
 choices:procedure.input(z.object({sessionId:z.string().uuid().optional()}).optional()).query(async({ctx,input})=>{
  let work=false;let workModuleId:string|null=null;let workRevisionId:string|null=null;
  if(input?.sessionId){const listing=await ctx.supabaseAdmin!.rpc('opc_query',{p_actor_id:ctx.user.id});if(!listing.error){const item=(listing.data.accounts??[]).flatMap((a:{items:Array<{sessionId:string;workItemId:string;moduleId?:string;methodRevisionId?:string}>})=>a.items).find((i:{sessionId:string})=>i.sessionId===input.sessionId);work=Boolean(item);if(item){workModuleId=item.moduleId??null;workRevisionId=item.methodRevisionId??null;}}}

  // This loopback-only Owner entry advertises its two acceptance fixtures,
  // not the unrelated fault/organizer fixtures left by the integration suite.
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
   for(const s of list.filter(s=>ctx.real||work||s.public.name==='runtime-demo')){
    const descriptor=descriptors.find(d=>d.revisionId===s.public.revisionId);
    if(!descriptor||Object.keys(descriptor.tasks).length)continue;
    skills.push({moduleId:m.id,revisionId:s.public.revisionId,name:work?m.title:s.public.name});
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
  const actor=async()=>{const r=await ctx.userScopedSupabase.auth.getUser();if(r.error||r.data.user?.id!==ctx.user.id)throw new Error('RUNTIME_DENIED');return ctx.user.id;};
  if(ctx.maintenanceEndpoint)return runtimeExecutor({database:ctx.supabaseAdmin!,actor,endpoint:ctx.maintenanceEndpoint,activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)}).execute(input.executionId);
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
   const adapter=stagingTransport(ctx.supabaseAdmin!,original);
   const state=await runtimeExecutor({database:ctx.supabaseAdmin!,actor,adapter:{dispatch:async()=>{throw new Error('RUNTIME_DISPATCH_DISABLED');},lookup:adapter.lookup}}).recoverFinancial(input.executionId);
   return {state:state.state};
  }
  // Execution/recovery always uses its original quote and credential namespace,
  // even if a later test window is now selected in the host environment.
  const original=await loadStagingRecoveryPolicy(ctx.supabaseAdmin!,ctx.user.id,input.executionId,process.env);
  return runtimeExecutor({database:ctx.supabaseAdmin!,actor,adapter:stagingTransport(ctx.supabaseAdmin!,original),activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)}).execute(input.executionId);
 }),
 view:maintenanceProcedure.input(z.object({sessionId:z.string().uuid()}).strict()).query(async({ctx,input})=>{
  const result=await ctx.supabaseAdmin!.rpc('runtime_view',{p_actor_id:ctx.user.id,p_session_id:input.sessionId});if(result.error)throw new Error('RUNTIME_VIEW_DENIED');return {...result.data,mode:ctx.maintenanceEndpoint?'isolated':'staging_test'};
 }),
});
