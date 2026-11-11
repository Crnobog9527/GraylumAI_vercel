/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { reportDocumentInput, reportEditInput, reportFinalizeInput,
  reportFinalizationService } from '../services/report/finalization';
import {reportRevisionService,revisionApplyInput,revisionProposeInput} from '../services/report/revisionSync';
import {reportEnabled} from '../services/report/service';
import {reportPrice} from '../services/report/fees';
import {reportPreflight,reportPreflightInput} from '../services/report/preflight';
import {readRuntimeSessionScope} from '../services/opc/runtimeSessionScope';
import {runtimeStart} from '../services/opc/runtimeStart';
import { z } from 'zod';
import { protectedProcedure,router } from '../trpc';
import {loadStagingPolicy,assertStagingReadAccess} from '../services/turn/settings/stagingPolicy';
import {StagingAccessError,stagingProcedureError} from '../services/turn/settings/stagingErrors';
import {readAdmissionConfiguration} from '../services/turn/admission/admissionConfiguration';
import {readCoreConfig} from '../services/turn/chat';
import {realContract} from '../services/turn/settings/realHost';
import {realHostMode} from '../services/turn/settings/productionEnvironment';
import { userVisibleModules } from '../services/skills/databaseSource';
import { listChoiceSkills } from '../services/skills/choiceSkills';
import { asRequiredLevel } from '../services/skills/memberOnly';
import { readOwnDataTier } from '../services/membershipEntitlements';
import { defaultModelFirst, freeChatModels, readModelChoiceSettings } from '../services/turn/settings/defaultModel';
import { publicModelChoices } from '../services/modelIdentity/display';
import {runtimeLocalEndpoint} from '../services/turn/settings/stagingEnvironment';
import { swallow } from '../lib/swallow';

// Viewing a conversation's scope and the report document calls do not admit new work. Source/actor checks still run in their
// existing SQL procedures.
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
  let real;
  try{runtimeLocalEndpoint();}catch{real=await loadStagingPolicy(ctx.supabaseAdmin,ctx.user.id,process.env);}
  ctx.runtimeBudget?.timing?.enter('host');
  const result=await next({ctx:{...ctx,real}});
  if(!result.ok)throw result.error;
  return result;
 }catch(cause){throw stagingProcedureError(cause,path);}
});

export const runtimeRouter=router({
 reportDocument:maintenanceProcedure.input(reportDocumentInput).query(({ctx,input})=>
  reportFinalizationService(ctx.userScopedSupabase,ctx.supabaseAdmin!).read(input)),
 reportSave:maintenanceProcedure.input(reportEditInput).mutation(({ctx,input})=>
  reportFinalizationService(ctx.userScopedSupabase,ctx.supabaseAdmin!).save(input)),
 reportFinalize:maintenanceProcedure.input(reportFinalizeInput).mutation(({ctx,input})=>
  reportFinalizationService(ctx.userScopedSupabase,ctx.supabaseAdmin!).finalize(input)),
 // R14: sync an adopted review revision back to the confirmed fields. No model call, no charge.
 reportRevisionPropose:maintenanceProcedure.input(revisionProposeInput).mutation(({ctx,input})=>
  reportRevisionService(ctx.userScopedSupabase,ctx.supabaseAdmin!).propose(input)),
 reportRevisionApply:maintenanceProcedure.input(revisionApplyInput).mutation(({ctx,input})=>
  reportRevisionService(ctx.userScopedSupabase,ctx.supabaseAdmin!).apply(input)),
 // acceptedCredits: the fixed price the button showed (0295); the service refuses a start at another price.
 // Display only: whether the report entry is shown. reportStart checks the same switch again.
 // The fixed price (0295) is shown on the button; null when it cannot be read (the button then shows no number).
 reportAvailable:maintenanceProcedure.query(async({ctx})=>({enabled:await reportEnabled(ctx.supabaseAdmin!),
  priceCredits:await swallow('report_price_read_failed',reportPrice(ctx.supabaseAdmin!),null)})),
 reportPreflight:maintenanceProcedure.input(reportPreflightInput).query(({ctx,input})=>
  reportPreflight(ctx.userScopedSupabase,ctx.supabaseAdmin!,input)),
 // Saved reports stay discoverable whatever the switch or membership is now.
 choices:procedure.input(z.object({sessionId:z.string().uuid().optional()}).optional()).query(async({ctx,input})=>{
  let work=false;let workModuleId:string|null=null;let workRevisionId:string|null=null;
  // Loopback advertises the curated ordinary model. Free-chat skills must use
  // that same model, excluding fault/organizer fixtures without name matching.
  const modelQuery=ctx.supabaseAdmin!.from('ai_models').select('id,name,model_id,max_tokens,config').eq('is_active','true');
  // The work-item lookup, the models and the visible modules do not depend on each other: asked together, checked in the old order.
  const [listing,models,visible]=await Promise.all([
   input?.sessionId?ctx.supabaseAdmin!.rpc('opc_query',{p_actor_id:ctx.user.id}):null,
   ctx.real?modelQuery.in('id',ctx.real.callPolicies.map(q=>q.modelId)):modelQuery.eq('provider','fixture').eq('name','Runtime local'),
   userVisibleModules(ctx.userScopedSupabase,{limit:64}),
  ]);
  if(listing&&!listing.error){
   type WorkRow={sessionId:string;workItemId:string;moduleId?:string;methodRevisionId?:string};
   const item=(listing.data.accounts??[]).flatMap((a:{items:WorkRow[]})=>a.items).find((i:WorkRow)=>i.sessionId===input!.sessionId);
   work=Boolean(item);if(item){workModuleId=item.moduleId??null;workRevisionId=item.methodRevisionId??null;}
  }
  if(models.error)throw new Error('RUNTIME_MODELS_UNAVAILABLE');
  if(visible.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  // Respect the narrow public column grant; private metadata is fetched only
  // for visible modules and the loader independently rechecks current access.
  const modules=visible.data.length?await ctx.supabaseAdmin!.from('modules').select('id,skill_id,title,model_id,required_member_level')
   .in('id',visible.data.map(m=>m.id)).eq('active',true):{data:[],error:null};
  if(modules.error)throw new Error('RUNTIME_SKILLS_UNAVAILABLE');
  // MEMBER-ONLY-MODULES: a Skill limited to members is listed to everyone and marked locked for a plan below it (the page then shows the
  // paywall instead of choosing it); the plan is read only when some listed module has a requirement, and an unreadable plan locks nothing (lockedForTier).
  const tierNeeded=modules.data.some(m=>asRequiredLevel(m.required_member_level));
  const tier=tierNeeded?await swallow('runtime_choices_tier_unavailable',readOwnDataTier(ctx.supabaseAdmin!,ctx.user.id),null):null;
  // AC-0c: the sources reuse this request's user-scoped (RLS) read above, never the service-role row. One identity check for
  // the request and a few modules at a time (services/skills/choiceSkills.ts); the list and its order are as before.
  const real=ctx.real;
  const skills=await listChoiceSkills({userClient:ctx.userScopedSupabase,privateClient:ctx.supabaseAdmin,visible:visible.data,modules:modules.data,
   runnable:m=>!real||real.callPolicies.some(q=>q.modelId===m.model_id),
   listed:m=>Boolean(real)||work||models.data.some(model=>model.id===m.model_id),
   pin:workModuleId&&workRevisionId?{moduleId:workModuleId,revisionId:workRevisionId}:null,tier});
  // Staging hides models a free-chat turn is certain to be refused with; the administrator's default comes first.
  // DB-PERF PR-3: one settings read for the whole list instead of one per offered model.
  const choiceSettings=readModelChoiceSettings(ctx.supabaseAdmin!);
  const offered=ctx.real?await freeChatModels(ctx.supabaseAdmin!,ctx.real,models.data,process.env,choiceSettings):models.data.map(({id,name})=>({id,name}));
  // MODEL-IDENTITY-GUARD: opaque id plus display label only; never model_id or provider.
  const ordered=await defaultModelFirst(ctx.supabaseAdmin!,offered,choiceSettings);
  const choices=publicModelChoices(ordered,{surface:'user'});
  // CORE-PATH-V2 V2-10: which path this page sends on; an unreadable setting keeps the old one.
  const corePathV2=Boolean(readCoreConfig(await readAdmissionConfiguration(ctx.supabaseAdmin!)));
  return {models:choices,skills,defaultSkill:skills.find(skill=>skill.moduleId===workModuleId)??null,mode:realContract(ctx.real).host.mode,corePathV2};
 }),
 start:procedure.input(z.object({requestId:z.string().uuid(),scope:z.unknown()}).strict()).mutation(({ctx,input})=>runtimeStart(ctx.userScopedSupabase,ctx.supabaseAdmin!,input.requestId,input.scope)),
 // Only what the page needs to pick its workspace: which conversation, its scope, the host mode and whether it is an older
 // conversation with no turns (shown as unsupported). No history, executions or work rows are read here.
 view:maintenanceProcedure.input(z.object({sessionId:z.string().uuid()}).strict()).query(async({ctx,input})=>({
  ...await readRuntimeSessionScope(ctx.supabaseAdmin!,ctx.user.id,input.sessionId),
  mode:ctx.maintenanceEndpoint?'isolated':realHostMode(process.env)})),
});
