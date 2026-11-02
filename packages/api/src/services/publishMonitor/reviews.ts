/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {logger} from '../../lib/logger';
import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {turnClients,turnDatabase} from '../turn/db';
import {redisCounterStore} from '../turn/limiter';
import {newWorkGate} from '../turn/admission/newWorkGate';
import {resolvePostSource} from '../turn/agent/workspacePosts';
import type {SessionRpc} from '../turn/agent/session';
import {runReviewTurn,type ReviewTurnDeps} from '../turn/review';
import {readTurnRouteEnv} from '../../lib/envValidator';
import type {RuntimeBudget} from '../turn/settings/budget';
import {readReviewSettings} from './reviewSettings';

/*
 * CORE-PATH-V2 V2-12 B8b: the scheduled weekly review on the turn core. The scheduler claims a review (publish_monitor_review_claim), the
 * host computes the user's own-posts result and review tables in code, and one kind='review' turn writes the reading of them
 * (turn/review.ts). The review row follows the turn through publish_monitor_review_step: a delivered completed turn completes it, a
 * turn that delivered nothing is retried as a new attempt (up to three, sharing one cost cap) or ends the week, and a turn whose cost is
 * not final yet keeps the claim for the turn recovery job.
 */
const claimSchema=z.object({id:z.string().uuid(),actorId:z.string().uuid(),token:z.string().uuid(),
 requestId:z.string().uuid(),sessionId:z.string().uuid(),modelId:z.string().uuid().nullable(),maxCostUsd:z.string()}).strict();
export type ReviewClaim=z.infer<typeof claimSchema>;
export type ReviewStep={env:Record<string,string|undefined>;defer:(work:()=>Promise<void>)=>void;budget:RuntimeBudget;turn?:ReviewTurnDeps};
const stepResult=z.object({allowed:z.boolean(),actorId:z.string().uuid(),turnId:z.number().int().positive().nullable().optional(),
 state:z.string().nullable().optional(),expired:z.boolean().nullish().transform(v=>v===true)}).passthrough();
async function step(db:SupabaseClient,c:ReviewClaim,action:string,reason?:string){
 const r=await db.rpc('publish_monitor_review_step',{p_id:c.id,p_token:c.token,p_action:action,p_reason:reason??null});
 if(r.error)throw new Error('PUBLISH_MONITOR_REVIEW_STEP_FAILED');
 return stepResult.parse(r.data);
}
/** No user is present to resume a scheduled review: a turn still running past its deadline is closed as interrupted, then skipped. */
async function finishExpiredReview(db:SupabaseClient,c:ReviewClaim,turnId:number|null|undefined){
 if(turnId)await turnDatabase(turnClients(db)).close({actorId:c.actorId,turnId,kind:'interrupted',messages:[],delivered:false});
 await step(db,c,'skip','RUNTIME_INTERRUPTED');
}
const POST_STATUSES=['available','stale','no_recent_posts','not_connected'];
/** Looks at the review's turn (found by the claim's request id, never invented): what is already settled ends here, what is expired is closed. */
export async function prepareReview(db:SupabaseClient,c:ReviewClaim):Promise<boolean>{
 const observed=await step(db,c,'observe');
 // completed / skipped by the step itself, a retry already scheduled, or a cost the recovery job still owns.
 if(['completed','failed','cost_pending','retrying'].includes(observed.state??''))return false;
 if(observed.expired){await finishExpiredReview(db,c,observed.turnId);return false;}
 if(!observed.allowed){
  if(observed.turnId)await turnDatabase(turnClients(db)).close({actorId:c.actorId,turnId:observed.turnId,kind:'interrupted',messages:[],delivered:false});
  await step(db,c,'skip','DISABLED');return false;
 }
 // A turn still running belongs to another invocation (or a killed one the 15-minute deadline will release).
 if(observed.state==='running')return false;
 if(!c.modelId||Number(c.maxCostUsd)<=0){
  logger.warn('billing','weekly_review_configuration_refused',{reviewId:c.id,code:'PUBLISH_MONITOR_REVIEW_UNAVAILABLE'});
  await step(db,c,'skip','CONFIGURATION_REQUIRED');return false;
 }
 return true;
}
/** The user's own posts of the last 90 days with the review tables, all computed in code (no model, no refresh, no provider). */
export async function readReviewPack(db:SupabaseClient,actor:string){
 const window=await db.rpc('runtime_workspace_post_window',{p_actor_id:actor});
 if(window.error||typeof window.data!=='number')throw new Error('PUBLISH_MONITOR_REVIEW_DATA_UNAVAILABLE');
 const pack=await resolvePostSource(db as unknown as SessionRpc,actor,{kind:'workspace_posts_request',windowDays:90,entitled:window.data>=90,review:true}) as
  {kind?:string;status?:string;review?:unknown}|null;
 return pack&&pack.kind==='my_posts'&&POST_STATUSES.includes(pack.status??'')&&typeof pack.review==='object'&&pack.review!==null?pack:null;
}
function turnDeps(db:SupabaseClient,options:ReviewStep):ReviewTurnDeps{
 return options.turn??{admin:db,clients:turnClients(db),slots:redisCounterStore(),newWork:newWorkGate(db,readTurnRouteEnv().environment)};
}
/** Runs outside the cron response, under the turn core's own freeze, receipts and recovery. */
export async function advanceReview(db:SupabaseClient,c:ReviewClaim,options:ReviewStep){
 try{
  const state=await step(db,c,'authorize');
  if(!state.allowed){await step(db,c,'skip','DISABLED');return;}
  const pack=await readReviewPack(db,c.actorId);
  if(!pack){await step(db,c,'skip','CONFIGURATION_REQUIRED');return;}
  const saved=await db.rpc('publish_monitor_review_save_pack',{p_id:c.id,p_token:c.token,p_pack:pack});
  if(saved.error||saved.data!==true)return;
  const result=await runReviewTurn(turnDeps(db,options),{id:c.id,actorId:c.actorId,sessionId:c.sessionId,requestId:c.requestId,
   modelId:c.modelId!,maxCostUsd:c.maxCostUsd},pack,async()=>(await step(db,c,'authorize')).allowed);
  if(result.kind==='skipped'){await step(db,c,'skip',result.reason);return;}
  if(result.kind==='deferred'){
   // Nothing opened: the claim expires and the next batch takes it again.
   logger.warn('billing','weekly_review_deferred',{reviewId:c.id,code:result.code});return;
  }
  // A turn that delivered nothing is an interruption of the week (retried as a new attempt); an erased one ends it.
  if(result.delivered)await step(db,c,'observe');
  else await step(db,c,'skip',result.closeKind==='erased'?'RUNTIME_ENDED':'RUNTIME_INTERRUPTED');
 }catch(error){
  logger.warn('billing','weekly_review_interrupted',{reviewId:c.id,code:error instanceof Error?error.message.slice(0,64):'UNKNOWN'});
  // The same request keeps its turn and receipts; the expired claim is reclaimed later and observes what the turn did.
 }
}
export async function runWeeklyReviews(db:SupabaseClient,options:ReviewStep,until:number,now:()=>number=Date.now){
 const result={claimed:0,scheduled:0,skipped:0,failed:0};
 // Existing claims still need closing/recovery after the global switch is turned off.
 const settings=await readReviewSettings(db);
 const r=await db.rpc('publish_monitor_review_claim',{p_limit:5});
 if(r.error){
  if(!settings.enabled&&['PGRST202','42883'].includes(r.error.code))return {...result,enabled:false};
  throw new Error('PUBLISH_MONITOR_REVIEW_CLAIM_FAILED');
 }
 const claims=z.array(claimSchema).parse(r.data);
 result.claimed=claims.length;
 for(const c of claims){
  if(now()>=until)break;
  try{
   if(await prepareReview(db,c)){options.defer(()=>advanceReview(db,c,options));result.scheduled++;}
   else result.skipped++;
  }catch{result.failed++;}
 }
 return {...result,enabled:settings.enabled};
}
