/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {TRPCError} from '@trpc/server';
import {protectedProcedure, router} from '../trpc';
import {confirmedPreferences, preferenceScope, preferenceChange} from '../services/agentSlice/preferences';

const procedure=protectedProcedure.use(async({ctx,next})=>{
 const result=await next({ctx:{...ctx,preferences:confirmedPreferences(ctx.userScopedSupabase,ctx.hasSupabaseAdminPrivileges?ctx.supabaseAdmin:null)}});
 if(!result.ok) {
  const reason=result.error.cause instanceof Error?result.error.cause.message:result.error.message;
  if(reason==='PREFERENCE_CONFLICT')throw new TRPCError({code:'CONFLICT',message:'偏好已在其他页面更新，请重新加载后修改。'});
  if(reason==='PREFERENCE_DENIED')throw new TRPCError({code:'FORBIDDEN',message:'无法访问此偏好。'});
  throw new TRPCError({code:'SERVICE_UNAVAILABLE',message:'暂时无法读取或保存偏好，请重试。'});
 }
 return result;
});
export const agentSliceRouter=router({
 preferences:procedure.input(preferenceScope).query(({ctx,input})=>ctx.preferences.read(input)),
 confirmPreference:procedure.input(preferenceChange).mutation(({ctx,input})=>ctx.preferences.change(input)),
});
