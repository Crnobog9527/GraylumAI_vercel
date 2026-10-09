/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {transport} from '../monthly-refund/adapter.mjs';
import {provider} from '../monthly-refund/provider.mjs';
import {syntheticSdk} from './sdk.mjs';
import {checkLegacy} from './legacy.mjs';
export async function runCombined(input){
 const {db,service,webhook,report,require,processAccountErasure,createErasureAuthAdapter,
  createErasureStorageTransport,createErasureStorageAdapter}=input;
 await checkLegacy(input);
 const {createClient}=require('@supabase/supabase-js');const database=transport(db);
 const rpc=async(name,args)=>{
  await db.query('SET ROLE service_role');
  try {return await database.rpc(name,args);}finally{await db.query('RESET ROLE');}
 };
 for(const kind of ['normal','page_failure','budget','shared','auth_unknown','cash_late','cash_conflict']){
  let profileId;let monthly;let remote;let approval;
  if(kind.startsWith('cash_')){
   monthly=(await db.query('select monthly_test.fixture() f')).rows[0].f;profileId=monthly.user;remote=provider(monthly);
   const args={orderId:monthly.order,ticketId:monthly.ticket,feePermitted:'confirmed',feeEvidence:'fixture:law'};
   const quote=await service.quoteMonthlyRefund(database,remote.stripe,monthly.actor,args);
   approval=await service.approveMonthlyRefund(database,remote.stripe,monthly.actor,{...args,...quote});
   remote.setFailure('refund');
   assert.equal((await service.executeMonthlyRefund(database,remote.stripe,monthly.actor,monthly.order,approval.id)).status,'review_required');
  }else{
   profileId=randomUUID();await db.query('insert into profiles(id,credits) values($1,37)',[profileId]);
  }
  const closed=(await db.query('select account_erasure_confirm($1,$2) v',[profileId,randomUUID()])).rows[0].v;
  const hash=createHash('sha256').update('synthetic-progress:'+profileId).digest('hex');
  const issue=await rpc('account_erasure_progress_issue',{p_profile_id:profileId,p_request_id:closed.requestId,p_token_hash:hash});
  assert.deepEqual(issue.data,{issued:true});
  const progress=async()=>(await rpc('account_erasure_progress_read',{p_request_id:closed.requestId,p_token_hash:hash})).data;
  const sdk=syntheticSdk(createClient,profileId);sdk.setMode(kind);let shared=kind==='shared';
  const manifest={async list(){return {items:[],nextCursor:null};},
   async classify({paths}){return paths.map(path=>({path,state:shared?'shared':'unreferenced'}));}};
  const process=async(limited=false)=>processAccountErasure({profileId,database:{rpc},
   storageAdapter:createErasureStorageAdapter({storage:createErasureStorageTransport(sdk.client),manifest,
    limits:limited?{pageSize:1,maxPages:1}:{pageSize:2}}),
   authAdapter:createErasureAuthAdapter(sdk.client,profileId),budget:{deadline:Date.now()+30000,operationTimeoutMs:5000}});
  const original=monthly?(await service.readMonthlyRefundStatus(database,monthly.order)):null;
  let first=await process(kind==='budget');
  if(kind==='normal')assert.equal(first.stage,'completed',JSON.stringify(first));
  else assert.notEqual(first.stage,'completed',JSON.stringify({kind,first}));
  if(kind==='page_failure'||kind==='shared'){
   assert.equal(sdk.storageDeletes(),0);assert.equal(sdk.objects.size,3);assert.equal(sdk.authDeletes(),0);
  }
  if(kind==='budget'){assert.equal(sdk.objects.size,2);assert.equal(sdk.authDeletes(),0);}
  if(kind==='auth_unknown'){
   assert.equal(sdk.authDeletes(),1);assert.ok((await progress()).needsReview);
   sdk.setAuth('present');await process();assert.equal(sdk.authDeletes(),1,'fresh SDK adapter cannot retry durable Auth intent');
   sdk.setAuth('absent');
  }
  if(monthly){
   assert.equal(sdk.authDeletes(),0);assert.deepEqual(await service.readMonthlyRefundStatus(database,monthly.order),original);
   assert.equal((await progress()).stage,'billing_pending');
   const writes=remote.writes.length;
   await webhook.syncMonthlyRefundSubscription(database,remote.stripe,remote.sub.id);
   assert.equal(remote.writes.length,writes,'webhook records original cash without external dispatch');
   if(kind==='cash_conflict'){
    await service.recordMonthlyRefund(database,remote.stripe,monthly.order,{...remote.refunds[0],status:'failed'});
    await process();assert.equal(sdk.authDeletes(),0);
    assert.equal((await progress()).stage,'billing_pending');
    const denied=(await db.query('select account_erasure_auth_begin($1,$2) v',[profileId,closed.requestId])).rows[0].v;
    assert.equal(denied.ready,false);assert.equal(denied.claimed,false);
    continue;
   }
   remote.setFailure(null);
   const final=await service.executeMonthlyRefund(database,remote.stripe,monthly.actor,monthly.order,approval.id);
   assert.equal(final.status,'succeeded');assert.deepEqual(final.terms,approval.terms);assert.equal(final.versionHash,approval.versionHash);
   assert.equal(remote.writes.filter(row=>row.stage==='refund').length,1);
  }
  sdk.setMode('normal');shared=false;
  const done=await process();assert.equal(done.stage,'completed',JSON.stringify({kind,done}));assert.equal(done.retry,false);
  assert.equal(sdk.authDeletes(),1);assert.equal(sdk.objects.size,0);
  const view=await progress();assert.equal(view.stage,'completed');assert.equal(view.needsReview,false);
  assert.deepEqual(Object.keys(view).sort(),['confirmedAt','needsReview','stage','updatedAt']);
  assert.equal((await rpc('account_erasure_progress_issue',{
   p_profile_id:profileId,p_request_id:closed.requestId,p_token_hash:'f'.repeat(64)})).data.issued,false,'no replacement credential');
  assert.equal((await rpc('account_erasure_progress_read',{p_request_id:closed.requestId,p_token_hash:'0'.repeat(64)})).data,null);
  const expiry=(await db.query('select progress_expires_at>clock_timestamp() valid from account_erasure_requests where profile_id=$1',[profileId])).rows[0];
  assert.equal(expiry.valid,true);
  assert.equal((await db.query('select credits from profiles where id=$1',[profileId])).rows[0].credits,monthly?400:37);
 }
 report.checks.push('combined actual SDK + mock HTTP + processor + service-role SQL: multipage failure/budget/shared reference/Auth uncertainty preserve completion barriers');
 report.checks.push('monthly held/conflicting cash blocks Auth; original late cash resumes once; actual progress capability remains minimal and non-reissuable through completion');
}
