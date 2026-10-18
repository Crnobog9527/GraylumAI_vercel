/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {TRPCError} from '@trpc/server';
import {z} from 'zod';
import {adminProcedure,protectedProcedure,router} from '../trpc';
import {createSafeInternalError} from '../lib/publicError';
import {readMembershipEntitlements} from '../services/membershipEntitlements';
import {assertPublishMonitorEnabled} from '../services/publishMonitor/foundation';
import {readReviewData} from '../services/publishMonitor/reviewData';
import {readReviews,exportReview} from '../services/publishMonitor/reviewOutput';
import {readReviewSettings,REVIEW_SWITCH,REVIEW_CAP,REVIEW_MODEL} from '../services/publishMonitor/reviewSettings';

type Context=Parameters<typeof readMembershipEntitlements>[0];
async function days(db:Context,actor:string){
 await assertPublishMonitorEnabled(db);
 if(!(await readReviewSettings(db)).enabled)throw new TRPCError({code:'FORBIDDEN',message:'PUBLISH_MONITOR_REVIEW_DISABLED'});
 const entitlements=await readMembershipEntitlements(db,actor);
 if(entitlements.ownDataWindowDays<1)throw new TRPCError({code:'FORBIDDEN',message:'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED'});
 return entitlements.ownDataWindowDays;
}
async function safe<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  if(error instanceof TRPCError)throw error;
  throw createSafeInternalError('复盘暂时不可用，请稍后再试。');
 }
}
const settingInput=z.object({enabled:z.boolean(),modelId:z.string().uuid().nullable(),
 maxCostUsd:z.string().regex(/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/)}).strict();
export const publishMonitorReviewRouter=router({
 data:protectedProcedure.query(({ctx})=>safe(async()=>readReviewData(ctx.supabaseAdmin,ctx.profileId,
  await days(ctx.supabaseAdmin,ctx.profileId)))),
 list:protectedProcedure.query(({ctx})=>safe(async()=>{
  await days(ctx.supabaseAdmin,ctx.profileId);
  return readReviews(ctx.supabaseAdmin,ctx.profileId);
 })),
 export:protectedProcedure.input(z.object({id:z.string().uuid()}).strict()).query(({ctx,input})=>safe(async()=>{
  await days(ctx.supabaseAdmin,ctx.profileId);
  return exportReview(ctx.supabaseAdmin,ctx.profileId,input.id);
 })),
 // Backend contract for PR-7's model picker; no provider request or credential read on settings access.
 adminSettings:adminProcedure.query(({ctx})=>safe(()=>readReviewSettings(ctx.supabaseAdmin))),
 saveAdminSettings:adminProcedure.input(settingInput).mutation(({ctx,input})=>safe(async()=>{
  if(input.modelId){
   const r=await ctx.supabaseAdmin.from('ai_models').select('id,is_active,provider').eq('id',input.modelId).maybeSingle();
   if(r.error)throw new Error('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
   if(!r.data||r.data.is_active!=='true'||!['openrouter','openai','anthropic'].includes(r.data.provider))
    throw new TRPCError({code:'BAD_REQUEST',message:'PUBLISH_MONITOR_REVIEW_MODEL_UNAVAILABLE'});
  }
  const r=await ctx.supabaseAdmin.from('system_settings').upsert([
   {key:REVIEW_SWITCH,value:input.enabled},{key:REVIEW_MODEL,value:input.modelId},{key:REVIEW_CAP,value:input.maxCostUsd},
  ],{onConflict:'key'});
  if(r.error)throw new Error('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
  return readReviewSettings(ctx.supabaseAdmin);
 })),
});
