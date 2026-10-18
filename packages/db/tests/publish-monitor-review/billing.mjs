/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,receipt} from '../payg/fixture.mjs';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
export async function billingCases({c,report}){
 const one=async(sql,args=[])=>{await c.query('RESET ROLE');
  try{return (await c.query(sql,args)).rows[0]?.v;}finally{await c.query('SET ROLE service_role');}};
 const f=await createFixture(c,{credits:1000,threshold:1});
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_review_model_id',$1::jsonb),
  ('publish_monitor_review_max_usd','"0.009"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify(f.payload.modelId)]);
 await rpc(c,'publish_monitor_set_auto_review',f.actor,true);
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1",[f.actor]);
 const params=c.connectionParameters;
 const other=new c.constructor({connectionString:`postgres://postgres@127.0.0.1:${params.port}/${params.database}`});
 await other.connect();await c.query('SET ROLE service_role');await other.query('SET ROLE service_role');
 let all;
 try{all=await Promise.all([c,other].map(client=>rpc(client,'publish_monitor_review_claim',20)));}
 finally{await other.end();}
 const claims=all.flat().filter(r=>r.actorId===f.actor);assert.equal(claims.length,1);
 const r=claims[0];
 report.checks.push('concurrent independent database connections produce exactly one weekly claim');
 const session=await rpc(c,'runtime_session_context',f.actor,r.sessionId);
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Review fixture',instructions:'Read real data',
  model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:3,historyItems:0,
  tools:['read_source'],maxToolCalls:2,workspaceContext:true,ownPosts:true,sources:[],network:'deny',
  request:{sessionId:r.sessionId,requestId:r.requestId,input:'Review fixture',selection:{kind:'ordinary',modelId:f.payload.modelId},network:'deny'},
  weeklyReview:{id:r.id,token:r.token,maxCostUsd:r.maxCostUsd}};
 const payload={...f.payload,scope:session.scope,input:context,limits:{...f.payload.limits,costUsd:'0.009',maxCalls:3}};
 const before=await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]);
 const missingToken={...context,weeklyReview:{id:r.id,maxCostUsd:r.maxCostUsd}};
 await assert.rejects(rpc(c,'runtime_admit',f.actor,r.sessionId,r.requestId,missingToken,
  {...payload,input:missingToken}),/PUBLISH_MONITOR_REVIEW_DENIED/);
 report.checks.push('missing private lease token is denied atomically, without creating an execution or charge');
 const admitted=await rpc(c,'runtime_admit',f.actor,r.sessionId,r.requestId,context,payload);
 const repeated=await rpc(c,'runtime_admit',f.actor,r.sessionId,r.requestId,context,payload);
 assert.equal(repeated.executionId,admitted.executionId);
 const saved=await one('SELECT to_jsonb(r) v FROM social_review_runs r WHERE id=$1',[r.id]);
 assert.equal(saved.runtime_execution_id,admitted.executionId);assert.equal(saved.bill2_run_id,admitted.runId);
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]),before);
 report.checks.push('native admission atomically binds one execution/run; repeated admission does not charge');
 const ordinary=await rpc(c,'runtime_start',f.actor,randomUUID(),{scope:{kind:'positioning_draft'}});
 await one(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
  VALUES(gen_random_uuid(),$1,$2,gen_random_uuid(),'{"role":"ordinary","input":"A real free conversation"}',0,'completed') RETURNING id v`,
  [f.actor,ordinary.sessionId]);
 await c.query('BEGIN');await c.query('RESET ROLE');
 await c.query(read('packages/db/migrations/0130_runtime_conversations.sql').replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));
 await c.query('SET ROLE service_role');
 assert.ok((await rpc(c,'opc_free_conversations',f.actor)).some(row=>row.sessionId===r.sessionId));
 report.checks.push('RED: the old free-chat projection exposes the native weekly-review session and scheduler input');
 await c.query('ROLLBACK');
 const chats=await rpc(c,'opc_free_conversations',f.actor);
 assert.ok(chats.some(row=>row.sessionId===ordinary.sessionId));assert.ok(!chats.some(row=>row.sessionId===r.sessionId));
 assert.doesNotMatch(JSON.stringify(chats),/Review fixture/);
 report.checks.push('GREEN: automatic reviews stay out of free chat; a real ordinary chat remains visible');

 const live=await rpc(c,'runtime_execution',f.actor,admitted.executionId,'begin',null);assert.equal(live.epoch,1);
 await rpc(c,'runtime_execution',f.actor,admitted.executionId,'owner_session',
  {epoch:1,value:{action:'freeze',items:[]}});
 const linked={...f,run:admitted.runId};
 const first=await rpc(c,'bill2_claim',f.actor,linked.run,1,{...f.claimPayload,runtimeEpoch:1});
 const again=await rpc(c,'bill2_claim',f.actor,linked.run,1,{...f.claimPayload,runtimeEpoch:1});assert.equal(again.id,first.id);assert.equal(again.dispatchToken,null);
 assert.equal((await rpc(c,'bill2_dispatch',f.actor,linked.run,first.id,first.dispatchToken)).dispatch,true);
 await receipt(c,linked,first,'0.001');
 const balance=await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]);assert.ok(balance<before);
 await receipt(c,linked,first,'0.001');
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]),balance);
 await assert.rejects(rpc(c,'bill2_claim',f.actor,linked.run,2,{...f.claimPayload,runtimeEpoch:1}),/BILL2_CALL_BUDGET_OR_CONTRACT/);
 assert.equal(await one('SELECT count(*)::int v FROM bill2_calls WHERE run_id=$1',[linked.run]),1);
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]),balance);
 report.checks.push('BILL2 fixture dispatch/receipt charges once; repeated receipt and over-cap next call cannot debit again');
 await rpc(c,'runtime_execution',f.actor,admitted.executionId,'owner_session',
  {epoch:1,value:{action:'append',items:[{role:'assistant',content:'Model says 999'}],batch:0}});
 const complete=()=>rpc(c,'runtime_execution',f.actor,admitted.executionId,'complete',
  {epoch:1,value:{kind:'usable_result',body:'Model says 999',evidenceRef:admitted.executionId,
   evidenceHash:createHash('sha256').update(JSON.stringify({body:'Model says 999'})).digest('hex')}});
 // A missing required source is a platform failure: native compensation restores user charges, not supplier cost.
 await c.query('BEGIN');await c.query('RESET ROLE');
 await c.query('DROP TRIGGER publish_monitor_review_result_guard ON runtime_executions');await c.query('SET ROLE service_role');
 assert.equal((await complete()).state,'completed');
 report.checks.push('RED: without the host result guard, a model answer with no source is marked completed and charged');
 await c.query('ROLLBACK');
 await c.query('BEGIN');
 await assert.rejects(complete(),/PUBLISH_MONITOR_REVIEW_SOURCE_REQUIRED/);
 await c.query('ROLLBACK');
 await c.query('BEGIN');
 const failed=await rpc(c,'runtime_execution',f.actor,admitted.executionId,'fail_platform',
  {epoch:1,value:{unavailable_reason:'preflight'}});
 assert.equal(failed.state,'cancelled');
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]),before);
 await c.query('ROLLBACK');
 const tool=(action,result=null,days=90)=>rpc(c,'runtime_execution',f.actor,admitted.executionId,'owner_tool',
  {epoch:1,value:{callId:'review-data-'+days,name:'read_source',arguments:{query:'my_posts:'+days},action,result}});
 await tool('claim',null,14);await tool('complete',{kind:'my_posts',status:'available',window_days:14,
  dependencies:[],review:{rows:[{views:333}]}},14);
 await assert.rejects(complete(),/PUBLISH_MONITOR_REVIEW_SOURCE_REQUIRED/);
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]),balance);
 report.checks.push('no source and wrong 14-day source cannot complete; native platform-failure compensation restores charged credits');
 await tool('claim');await tool('complete',{kind:'my_posts',status:'available',window_days:90,dependencies:[],review:{rows:[{views:12}]}});
 await complete();
 await rpc(c,'publish_monitor_review_step',r.id,r.token,'observe',null);
 const history=await rpc(c,'publish_monitor_reviews',f.actor);
 assert.deepEqual(history.find(x=>x.id===r.id).tables,{rows:[{views:12}]});
 report.checks.push('model prose/completion cannot write the host numeric table');
 await c.query('RESET ROLE');await c.query("UPDATE profiles SET membership_level='pro' WHERE id=$1",[f.actor]);
 await c.query('SET ROLE service_role');
 assert.equal((await rpc(c,'publish_monitor_reviews',f.actor)).find(x=>x.id===r.id).tables,null);
 await c.query('RESET ROLE');await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 await c.query('SET ROLE service_role');
 report.checks.push('history/export projection rechecks visibility: Pro cannot receive the saved Gold 90-day table');
 await rpc(c,'runtime_cancel',f.actor,admitted.executionId);
 await c.query('RESET ROLE');await closeAccount(c,{actor:f.actor});
 await assert.rejects(rpc(c,'publish_monitor_reviews',f.actor),/PUBLISH_MONITOR_ACCOUNT_CLOSED|BILL2_ACTOR_DENIED/);
 report.checks.push('account closure denies review reads and new calls; settled accounting remains native BILL2');
 const low=await createFixture(c,{credits:1,threshold:2});
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[low.actor]);
 await c.query("UPDATE system_settings SET value=$1::jsonb WHERE key='publish_monitor_review_model_id'",[JSON.stringify(low.payload.modelId)]);
 await rpc(c,'publish_monitor_set_auto_review',low.actor,true);
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1",[low.actor]);
 await c.query('SET ROLE service_role');
 const lowClaim=(await rpc(c,'publish_monitor_review_claim',20)).find(row=>row.actorId===low.actor);
 const lowSession=await rpc(c,'runtime_session_context',low.actor,lowClaim.sessionId);
 const lowContext={...context,model:low.claimPayload.model,modelId:low.payload.modelId,
  request:{...context.request,sessionId:lowClaim.sessionId,requestId:lowClaim.requestId,
   selection:{kind:'ordinary',modelId:low.payload.modelId}},
  weeklyReview:{id:lowClaim.id,token:lowClaim.token,maxCostUsd:lowClaim.maxCostUsd}};
 const lowPayload={...low.payload,scope:lowSession.scope,input:lowContext,
  limits:{...low.payload.limits,costUsd:'0.009',maxCalls:3}};
 const lowAdmission=await rpc(c,'runtime_admit',low.actor,lowClaim.sessionId,lowClaim.requestId,lowContext,lowPayload);
 await rpc(c,'runtime_execution',low.actor,lowAdmission.executionId,'begin',null);
 const paused=await rpc(c,'bill2_claim',low.actor,lowAdmission.runId,1,{...low.claimPayload,runtimeEpoch:1});
 assert.equal(paused.state,'waiting_credits');assert.equal(paused.dispatchToken,null);
 await rpc(c,'runtime_cancel',low.actor,lowAdmission.executionId);
 await rpc(c,'publish_monitor_review_step',lowClaim.id,lowClaim.token,'skip','BALANCE_LOW');
 assert.equal(await one('SELECT count(*)::int v FROM bill2_calls WHERE run_id=$1',[lowAdmission.runId]),0);
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[low.actor]),1);
 assert.equal(await one('SELECT skip_reason v FROM social_review_runs WHERE id=$1',[lowClaim.id]),'BALANCE_LOW');
 report.checks.push('native insufficient-credit claim issues no dispatch token, creates zero calls and skips the period without debit');
 await c.query('RESET ROLE');

}
