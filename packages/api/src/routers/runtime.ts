/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {reportEnabled,reportService} from '../services/report/service';
import {reportStart} from '../services/report/contract';
import {readNativeRuntimeView} from '../services/runtime/nativeView';
import {resumeInput} from '../services/runtime/paygRuntime';
import type {inferProcedureBuilderResolverOptions} from '@trpc/server';
import type {RuntimeProgress} from '../services/runtime/progress';
import { z } from 'zod';
import { protectedProcedure,router } from '../trpc';
import { runtimeAdmissionService,runtimeAdmission,runtimeMaterialInput } from '../services/runtime/admission';
import {loadStagingPolicy,assertStagingReadAccess} from '../services/runtime/stagingPolicy';
import {StagingAccessError,stagingProcedureError} from '../services/runtime/stagingErrors';
import {stagingTransport} from '../services/runtime/stagingTransport';
import { runtimeExecutor } from '../services/runtime/execute';
import {newWorkGate} from '../services/runtime/newWorkGate';
import {runtimeActor} from '../services/runtime/actor';
import { databaseSkillSource, userVisibleModules } from '../services/skills/databaseSource';
import { discoverSkills } from '../services/skills/loader';
import { activateRuntimeCandidate } from '../services/runtime/matching';
import {executeOriginalExecution,runtimeLocalEndpoint,streamOriginalExecution} from '../services/runtime/executionStream';

// Viewing original state, cancellation and receipt maintenance do not admit
// new work. Source/actor checks still run in their existing SQL procedures.
const maintenanceProcedure=protectedProcedure.use(async({ctx,next,path})=>{
 ctx.runtimeBudget?.timing?.enter('policy');
 let maintenanceEndpoint:string|undefined;
 try {
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
  try{maintenanceEndpoint=runtimeLocalEndpoint();}catch{await assertStagingReadAccess(ctx.supabaseAdmin,ctx.user.id,process.env);}
 } catch(cause) { throw stagingProcedureError(cause,path); }
 ctx.runtimeBudget?.timing?.enter('host');
 const result=await next({ctx:{...ctx,maintenanceEndpoint}});
 if(!result.ok)throw stagingProcedureError(result.error,path);
 return result;
});
const procedure=protectedProcedure.use(async({ctx,next,path})=>{
 ctx.runtimeBudget?.timing?.enter('policy');
 try{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new StagingAccessError('RUNTIME_STAGING_SERVICE_UNAVAILABLE');
  let endpoint:string|undefined,real;
  try{endpoint=runtimeLocalEndpoint();}catch{real=await loadStagingPolicy(ctx.supabaseAdmin,ctx.user.id,process.env);}
  ctx.runtimeBudget?.timing?.enter('host');
  const actor=runtimeActor(ctx.userScopedSupabase.auth,ctx.user.id,ctx.runtimeBudget,ctx.headers?.get('Authorization'));
  const admissionPolicy={
   ...(real?{real,paygHost:true}:{}),resumeWaitingOrganizer:(token:import('../services/runtime/paygRuntime').ResumeInput)=>executeOriginalExecution({
   admin:ctx.supabaseAdmin!,user:ctx.userScopedSupabase,actorId:ctx.user.id,budget:ctx.runtimeBudget,
   authorization:ctx.headers?.get('Authorization'),maintenanceEndpoint:endpoint,
  },token.executionId,undefined,token),purposeBudgets:true,account:'runtime-local',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:32000,historyItems:100,searchEnabled:!real,workspaceContext:true};
  const admission=runtimeAdmissionService(ctx.userScopedSupabase,ctx.supabaseAdmin,admissionPolicy);
  const report=reportService(ctx.userScopedSupabase,ctx.supabaseAdmin,admissionPolicy);
  const executor=runtimeExecutor({database:ctx.supabaseAdmin,budget:ctx.runtimeBudget,actor,endpoint,
   callGate:newWorkGate(ctx.supabaseAdmin,endpoint?'local':'staging').calls,
   ...(real?{adapter:stagingTransport(ctx.supabaseAdmin,real,ctx.runtimeBudget)}:{}),
   activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)});
  const result=await next({ctx:{...ctx,admission,executor,real,report}});
  if(!result.ok)throw result.error;
  return result;
 }catch(cause){throw stagingProcedureError(cause,path);}
});

const executionProcedure=maintenanceProcedure.input(z.object({executionId:z.string().uuid(),textProtocol:z.literal('textDelta-v1').optional()}).strict());
function executeOriginal({ctx,input}:inferProcedureBuilderResolverOptions<typeof executionProcedure>,onProgress?:(event:RuntimeProgress)=>void){
 return executeOriginalExecution({admin:ctx.supabaseAdmin!,user:ctx.userScopedSupabase,actorId:ctx.user.id,budget:ctx.runtimeBudget,
  authorization:ctx.headers?.get('Authorization'),maintenanceEndpoint:ctx.maintenanceEndpoint},input.executionId,onProgress);
}
export const runtimeRouter=router({
 reportStart:procedure.input(reportStart).mutation(({ctx,input})=>ctx.report.start(input)),
 // Display only: whether the report entry is shown. reportStart checks the same switch again.
 reportAvailable:maintenanceProcedure.query(async({ctx})=>({enabled:await reportEnabled(ctx.supabaseAdmin!).catch(()=>false)})),
 reportStatus:maintenanceProcedure.input(z.object({executionId:z.string().uuid()}).strict()).query(({ctx,input})=>
  reportService(ctx.userScopedSupabase,ctx.supabaseAdmin!,{account:'read-only',costPerCall:'0',creditsPerUsd:'100',
    multiplier:'6',maxCalls:1,maxOutputTokens:1,inputBytes:1024,historyItems:0}).status(input.executionId)),
 choices:procedure.input(z.object({sessionId:z.string().uuid().optional()}).optional()).query(async({ctx,input})=>{
  let work=false;let workModuleId:string|null=null;let workRevisionId:string|null=null;
  if(input?.sessionId){const listing=await ctx.supabaseAdmin!.rpc('opc_query',{p_actor_id:ctx.user.id});if(!listing.error){const item=(listing.data.accounts??[]).flatMap((a:{items:Array<{sessionId:string;workItemId:string;moduleId?:string;methodRevisionId?:string}>})=>a.items).find((i:{sessionId:string})=>i.sessionId===input.sessionId);work=Boolean(item);if(item){workModuleId=item.moduleId??null;workRevisionId=item.methodRevisionId??null;}}}

  // Loopback advertises the curated ordinary model. Free-chat skills must use
  // that same model, excluding fault/organizer fixtures without name matching.
  const modelQuery=ctx.supabaseAdmin!.from('ai_models').select('id,name').eq('is_active','true');
  const models=await (ctx.real?modelQuery.in('id',ctx.real.callPolicies.map(q=>q.modelId)):modelQuery.eq('provider','fixture').eq('name','Runtime local'));
  if(models.error)throw new Error('RUNTIME_MODELS_UNAVAILABLE');
  const visible=await userVisibleModules(ctx.userScopedSupabase,{limit:64});
  if(visible.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  // Respect the narrow public column grant; private metadata is fetched only
  // for visible modules and the loader independently rechecks current access.
  const modules=visible.data.length?await ctx.supabaseAdmin!.from('modules').select('id,skill_id,title,model_id').in('id',visible.data.map(m=>m.id)).eq('active',true):{data:[],error:null};
  if(modules.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  const skills:Array<{moduleId:string;revisionId:string;name:string}>=[];
  for(const m of modules.data){if(!m.skill_id||(ctx.real&&!ctx.real.callPolicies.some(q=>q.modelId===m.model_id)))continue;try{
   // AC-0c: reuse this request's user-scoped (RLS) read above, never the service-role row.
   const userVisibleModule=visible.data.find(v=>v.id===m.id);
   const source=databaseSkillSource({userClient:ctx.userScopedSupabase,privateClient:ctx.supabaseAdmin,moduleId:m.id,skillId:m.skill_id,userVisibleModule,...(m.id===workModuleId&&workRevisionId?{revisionId:workRevisionId}:{})});
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
 cancel:maintenanceProcedure.input(z.object({executionId:z.string().uuid(),
  stopAt:z.number().int().min(0).max(2147483647).optional(),source:z.enum(['assistant','message','final']).optional()}).strict()).mutation(async({ctx,input})=>{
  const r=await ctx.supabaseAdmin!.rpc(input.stopAt===undefined?'runtime_cancel':'runtime_execution',
   {p_actor_id:ctx.user.id,p_execution_id:input.executionId,...(input.stopAt===undefined?{}:{p_action:'stop',
    p_result:{stopAt:input.stopAt,...(input.source?{source:input.source}:{})}})});
  if(!r.error&&r.data?.state==='stopped_pending_result')return executeOriginalExecution({
   admin:ctx.supabaseAdmin!,user:ctx.userScopedSupabase,actorId:ctx.user.id,budget:ctx.runtimeBudget,
   authorization:ctx.headers?.get('Authorization'),maintenanceEndpoint:ctx.maintenanceEndpoint,
  },input.executionId,undefined,undefined,true);
  if(r.error)throw new Error('RUNTIME_CANCEL_DENIED');return r.data;
 }),
 resume:maintenanceProcedure.input(resumeInput).mutation(({ctx,input})=>executeOriginalExecution({
  admin:ctx.supabaseAdmin!,user:ctx.userScopedSupabase,actorId:ctx.user.id,budget:ctx.runtimeBudget,
  authorization:ctx.headers?.get('Authorization'),maintenanceEndpoint:ctx.maintenanceEndpoint,
 },input.executionId,undefined,input)),
 execute:executionProcedure.mutation(options=>executeOriginal(options)),
 executeStream:executionProcedure.mutation(async function*(options){
  // The route returns before this stream ends; release this stream's reference.
  const timing=options.ctx.runtimeBudget?.timing;
  try{yield* streamOriginalExecution(onProgress=>executeOriginal(options,onProgress),timing,'runtime.executeStream',undefined,options.input.textProtocol);}
  finally{timing?.release();}
 }),
 view:maintenanceProcedure.input(z.object({sessionId:z.string().uuid()}).strict()).query(async({ctx,input})=>{
  const view=await readNativeRuntimeView(ctx.supabaseAdmin!,ctx.user.id,input.sessionId);
  return {...view,mode:ctx.maintenanceEndpoint?'isolated':'staging_test'};
 }),
});
