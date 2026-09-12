/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {continueSliceWork,continueWorkInput} from '../services/agentSlice/continueWork';
import {sliceEntry,sliceOpenInput} from '../services/agentSlice/entry';
import {readSliceConversation,sliceConversationInput} from '../services/agentSlice/conversation';
import {TRPCError} from '@trpc/server';
import {protectedProcedure, router} from '../trpc';
import {confirmedPreferences, preferenceScope, preferenceChange} from '../services/agentSlice/preferences';
import {recoverSlice,sliceRecoveryInput} from '../services/agentSlice/recovery';
import {sliceAdmission,sliceAdmissionInput} from '../services/agentSlice/admission';
import {sliceExecutor,slicePhase} from '../services/agentSlice/execute';
import {sliceResults} from '../services/agentSlice/results';
import {sliceLinks,sliceLinkInput,sliceLinkScope} from '../services/agentSlice/links';

const procedure=protectedProcedure.use(async({ctx,next})=>{
 const result=await next({ctx:{...ctx,preferences:confirmedPreferences(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null)}});
 if(!result.ok) {
  const reason=result.error.cause instanceof Error?result.error.cause.message:result.error.message;
  if(reason==='SLICE_DENIED')throw new TRPCError({code:'FORBIDDEN',message:'无法访问这次对话。'});
  if(reason?.startsWith('SLICE_')||['OUTCOME_UNKNOWN','TRUNCATED','CALL_LIMIT','MODEL_NOT_ALLOWED'].includes(reason))throw new TRPCError({code:'CONFLICT',message:'本轮尚未完成，请重试以查看原请求状态。'});
  if(reason==='PREFERENCE_CONFLICT')throw new TRPCError({code:'CONFLICT',message:'偏好已在其他页面更新，请重新加载后修改。'});
  if(reason==='PREFERENCE_DENIED')throw new TRPCError({code:'FORBIDDEN',message:'无法访问此偏好。'});
  if(reason==='ARTIFACT_DENIED')throw new TRPCError({code:'FORBIDDEN',message:'无法访问这份成果。'});
  if(reason==='ARTIFACT_EVIDENCE_UNAVAILABLE')throw new TRPCError({code:'CONFLICT',message:'引用成果已不可用，请重新查看来源。'});
  if(reason==='ARTIFACT_UNAVAILABLE')throw new TRPCError({code:'SERVICE_UNAVAILABLE',message:'暂时无法读取成果，请重试。'});
  throw new TRPCError({code:'SERVICE_UNAVAILABLE',message:'暂时无法读取或保存偏好，请重试。'});
 }
 return result;
});
export const agentSliceRouter=router({
 continueWork:procedure.input(continueWorkInput).mutation(({ctx,input})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return continueSliceWork(ctx.userScopedSupabase,ctx.supabaseAdmin,input);
 }),
 open:procedure.input(sliceOpenInput).mutation(({ctx,input})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return sliceEntry(ctx.userScopedSupabase,ctx.supabaseAdmin).open(input);
 }),
 sources:procedure.query(({ctx})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return sliceEntry(ctx.userScopedSupabase,ctx.supabaseAdmin).sources();
 }),
 targets:procedure.query(({ctx})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return sliceEntry(ctx.userScopedSupabase,ctx.supabaseAdmin).targets();
 }),
 conversation:procedure.input(sliceConversationInput).query(({ctx,input})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return readSliceConversation(ctx.userScopedSupabase,ctx.supabaseAdmin,input);
 }),
 recover:procedure.input(sliceRecoveryInput).mutation(({ctx,input})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return recoverSlice(ctx.userScopedSupabase,ctx.supabaseAdmin,input);
 }),
 begin:procedure.input(sliceAdmissionInput).mutation(({ctx,input})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return sliceAdmission(ctx.userScopedSupabase,ctx.supabaseAdmin).begin(input);
 }),
 executePhase:procedure.input(slicePhase).mutation(({ctx,input})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return sliceExecutor(ctx.userScopedSupabase,ctx.supabaseAdmin).execute(input);
 }),
 result:procedure.input(slicePhase).query(({ctx,input})=>{
  if(!ctx.hasSupabaseAdminPrivileges||!ctx.supabaseAdmin)throw new Error('SLICE_UNAVAILABLE');
  return sliceResults(ctx.userScopedSupabase,ctx.supabaseAdmin).read(input);
 }),
 link:procedure.input(sliceLinkInput).mutation(({ctx,input})=>sliceLinks(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null).link(input)),
 source:procedure.input(sliceLinkScope).query(({ctx,input})=>sliceLinks(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null).read(input)),
 preferences:procedure.input(preferenceScope).query(({ctx,input})=>ctx.preferences.read(input)),
 confirmPreference:procedure.input(preferenceChange).mutation(({ctx,input})=>ctx.preferences.change(input)),
});
