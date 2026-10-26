/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {createHash} from 'node:crypto';
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {aggregateCredits,decimal} from '../bill2/decimal';
import {openRouterCallBound} from '../bill2/openRouterPolicy';
import type {FrozenRun,FrozenPaygRun} from '../bill2/service';

export type WeeklyReview={id:string;token:string;maxCostUsd:string};
export async function admissionActor(user:SupabaseClient,admin:SupabaseClient,review?:WeeklyReview):Promise<string>{
 if(!review){
  const r=await user.auth.getUser();
  if(r.error||!r.data.user||!isEmailVerified(r.data.user))throw new Error('RUNTIME_AUTH_REQUIRED');
  return r.data.user.id;
 }
 const r=await admin.rpc('publish_monitor_review_step',{p_id:review.id,p_token:review.token,p_action:'authorize'});
 if(r.error||!r.data?.allowed||typeof r.data.actorId!=='string')throw new Error('PUBLISH_MONITOR_REVIEW_DENIED');
 return r.data.actorId;
}
/** Reuse BILL2's run budget and per-call freeze. A small cap lowers calls; never raises it or adds hidden calls. */
export function capReviewAdmission(context:{maxTurns:number;maxToolCalls:number;ownPosts?:boolean;weeklyReview?:WeeklyReview;
 maxOutputTokens?:number;purposeBudget?:{inputBytes:number}},
 billing:FrozenRun|FrozenPaygRun,review?:WeeklyReview){
 if(!review)return;
 if(!context.ownPosts||billing.contractVersion!=='bill2.v2')throw new Error('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
 // Keep the approved window quote intact. PAYG prices the final request; this run reserves the
 // largest permitted review request, including the same frozen template and safety overhead.
 const upper=billing.callPolicy.reduce((maximum,p)=>{
  if(!p.payg||!p.providerLimits||!context.purposeBudget||!context.maxOutputTokens)
   throw new Error('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
  const bytes=Math.min(context.purposeBudget.inputBytes,p.inputLimit,p.payg.maxBytes);
  const output=Math.min(context.maxOutputTokens,p.outputLimit);
  const bound=decimal(openRouterCallBound(p.providerLimits,output,bytes+p.payg.templateTokens+p.payg.marginTokens).upperUsd);
  return bound>maximum?bound:maximum;
 },0n);
 if(upper<=0n)throw new Error('PUBLISH_MONITOR_REVIEW_UNAVAILABLE');
 const count=Math.min(3,context.maxTurns,billing.limits.maxCalls,Number(decimal(review.maxCostUsd)/upper));
 // One source read and a final answer. The prompt addresses the fixed Gold window directly, so no index round is needed.
 if(count<2)throw new Error('PUBLISH_MONITOR_REVIEW_CAP_TOO_LOW');
 const total=upper*BigInt(count),cost=String(total/1_000_000_000_000n)+'.'+String(total%1_000_000_000_000n).padStart(12,'0');
 context.maxTurns=Math.min(context.maxTurns,count);context.maxToolCalls=Math.min(context.maxToolCalls,context.maxTurns-1);
 context.weeklyReview=review;
 billing.limits.costUsd=cost;billing.limits.maxCalls=count;
 billing.limits.maxPreDeduct=aggregateCredits([cost],billing.rules.creditsPerUsd,billing.rules.multiplier);
 billing.sourceHash=createHash('sha256').update(JSON.stringify(context)).digest('hex');
}
