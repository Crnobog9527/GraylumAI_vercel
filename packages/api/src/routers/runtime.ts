/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure,router } from '../trpc';
import { runtimeAdmissionService,runtimeAdmission,runtimeMaterialInput } from '../services/runtime/admission';
import { runtimeExecutor } from '../services/runtime/execute';
import { databaseSkillSource } from '../services/skills/databaseSource';
import { discoverSkills } from '../services/skills/loader';
import { activateRuntimeCandidate } from '../services/runtime/matching';

/** No enabled remote provider/database path in this implementation batch. */
function localEndpoint(){
 const endpoint=process.env.V3_RUNTIME_LOCAL_ENDPOINT;
 for(const value of [endpoint,process.env.NEXT_PUBLIC_SUPABASE_URL]){
  if(!value)throw new Error('RUNTIME_DISABLED');const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password)throw new Error('RUNTIME_DISABLED');
 }
 return endpoint!;
}
const procedure=protectedProcedure.use(async({ctx,next})=>{
 try{
  const endpoint=localEndpoint();
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('RUNTIME_DISABLED');
  const actor=async()=>{const a=await ctx.userScopedSupabase.auth.getUser();if(a.error||!a.data.user||a.data.user.id!==ctx.user.id)throw new Error('RUNTIME_DENIED');return a.data.user.id;};
  const admission=runtimeAdmissionService(ctx.userScopedSupabase,ctx.supabaseAdmin,{account:'runtime-local',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:3,maxOutputTokens:1000,inputBytes:32000,historyItems:100,searchEnabled:true});
  const executor=runtimeExecutor({database:ctx.supabaseAdmin,actor,endpoint,activateSkill:c=>activateRuntimeCandidate(ctx.userScopedSupabase,ctx.supabaseAdmin!,c)});
  const result=await next({ctx:{...ctx,admission,executor}});
  if(!result.ok)throw new Error('RUNTIME_UNAVAILABLE');
  return result;
 }catch{throw new TRPCError({code:'PRECONDITION_FAILED',message:'当前执行不可用，请检查原任务状态；未发送的请求不会自动重试。'});}
});
export const runtimeRouter=router({
 choices:procedure.input(z.object({sessionId:z.string().uuid().optional()}).optional()).query(async({ctx,input})=>{
  let work=false;
  if(input?.sessionId){const listing=await ctx.supabaseAdmin!.rpc('opc_query',{p_actor_id:ctx.user.id});if(!listing.error)work=(listing.data.accounts??[]).some((a:{items:Array<{sessionId:string}>})=>a.items.some(i=>i.sessionId===input.sessionId));}

  // This loopback-only Owner entry advertises its two acceptance fixtures,
  // not the unrelated fault/organizer fixtures left by the integration suite.
  const models=await ctx.supabaseAdmin!.from('ai_models').select('id,name').eq('is_active','true').eq('provider','fixture').eq('name','Runtime local');
  if(models.error)throw new Error('RUNTIME_MODELS_UNAVAILABLE');
  const visible=await ctx.userScopedSupabase.from('modules').select('id,active').eq('active',true).limit(64);
  if(visible.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  // Respect the narrow public column grant; private metadata is fetched only
  // for visible modules and the loader independently rechecks current access.
  const modules=visible.data.length?await ctx.supabaseAdmin!.from('modules').select('id,skill_id,title').in('id',visible.data.map(m=>m.id)).eq('active',true):{data:[],error:null};
  if(modules.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  const skills:Array<{moduleId:string;revisionId:string;name:string}>=[];
  for(const m of modules.data){if(!m.skill_id)continue;try{
   const source=databaseSkillSource({userClient:ctx.userScopedSupabase,privateClient:ctx.supabaseAdmin,moduleId:m.id,skillId:m.skill_id});
   const descriptors=await source.list();
   const list=await discoverSkills(source);
   for(const s of list.filter(s=>work||s.public.name==='runtime-demo')){
    const descriptor=descriptors.find(d=>d.revisionId===s.public.revisionId);
    if(!descriptor||Object.keys(descriptor.tasks).length)continue;
    skills.push({moduleId:m.id,revisionId:s.public.revisionId,name:work?m.title:s.public.name});
   }
  }catch{/* unavailable packages are not advertised as runnable */}}
  return {models:models.data,skills};
 }),
 start:procedure.input(z.object({requestId:z.string().uuid(),scope:z.unknown()}).strict()).mutation(({ctx,input})=>ctx.admission.start(input.requestId,input.scope)),
 saveMaterial:procedure.input(runtimeMaterialInput).mutation(({ctx,input})=>ctx.admission.saveMaterial(input)),
 revokeMaterial:procedure.input(z.object({sessionId:z.string().uuid(),revision:z.number().int().positive()}).strict()).mutation(({ctx,input})=>ctx.admission.revokeMaterial(input.sessionId,input.revision)),
 prepare:procedure.input(runtimeAdmission).mutation(({ctx,input})=>ctx.admission.prepare(input)),
 cancel:procedure.input(z.object({executionId:z.string().uuid()}).strict()).mutation(({ctx,input})=>ctx.executor.cancel(input.executionId)),
 execute:procedure.input(z.object({executionId:z.string().uuid()}).strict()).mutation(({ctx,input})=>ctx.executor.execute(input.executionId)),
 view:procedure.input(z.object({sessionId:z.string().uuid()}).strict()).query(async({ctx,input})=>{
  const result=await ctx.supabaseAdmin!.rpc('runtime_view',{p_actor_id:ctx.user.id,p_session_id:input.sessionId});if(result.error)throw new Error('RUNTIME_VIEW_DENIED');return result.data;
 }),
});
