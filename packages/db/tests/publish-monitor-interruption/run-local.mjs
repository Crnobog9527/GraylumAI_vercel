/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
// Real local Runtime/BILL2 journals; no provider calls or remote database access.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,receipt as recordReceipt} from '../payg/fixture.mjs';
import {rpc as nativeRpc} from '../erasure-b2a/cases.mjs';
import {laterRedefinitions} from '../publish-monitor/fixtures.mjs';

const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
async function service(client,work){
 await client.query('SET ROLE service_role');
 try{return await work();}finally{await client.query('RESET ROLE');}
}
const rpc=(client,...args)=>service(client,()=>nativeRpc(client,...args));
const receipt=(client,...args)=>service(client,()=>recordReceipt(client,...args));
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const MIGRATION_PATH='packages/db/migrations/0401_publish_monitor_review_interruption.sql';
const rollback=read('packages/db/tests/publish-monitor-interruption/rollback.sql');
const body=sql=>sql.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
const step=(r,action,reason=null)=>rpc(c,'publish_monitor_review_step',r.id,r.token,action,reason);
async function fixture(){
 const f=await createFixture(c,{credits:1000,q:'5000',threshold:1});
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_review_model_id',$1::jsonb),
  ('publish_monitor_review_max_usd','"0.03"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify(f.payload.modelId)]);
 await rpc(c,'publish_monitor_set_auto_review',f.actor,true);
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1",[f.actor]);
 const review=(await rpc(c,'publish_monitor_review_claim',20)).find(r=>r.actorId===f.actor);
 const session=await rpc(c,'runtime_session_context',f.actor,review.sessionId);
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Interrupted weekly review fixture',
  instructions:'Read real data',model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,
  maxTurns:3,historyItems:0,tools:['read_source'],maxToolCalls:2,workspaceContext:true,ownPosts:true,sources:[],network:'deny',
  request:{sessionId:review.sessionId,requestId:review.requestId,input:'Interrupted weekly review fixture',
   selection:{kind:'ordinary',modelId:f.payload.modelId},network:'deny'},
  weeklyReview:{id:review.id,token:review.token,maxCostUsd:review.maxCostUsd}};
 const payload={...f.payload,scope:session.scope,input:context,limits:{...f.payload.limits,costUsd:'0.03',maxCalls:3}};
 const admitted=await rpc(c,'runtime_admit',f.actor,review.sessionId,review.requestId,context,payload);
 const live=await rpc(c,'runtime_execution',f.actor,admitted.executionId,'begin',null);
 return {...f,run:admitted.runId,execution:admitted.executionId,review,epoch:live.epoch};
}
async function debit(f){
 const call=await rpc(c,'bill2_claim',f.actor,f.run,1,{...f.claimPayload,runtimeEpoch:f.epoch});
 assert.equal((await rpc(c,'bill2_dispatch',f.actor,f.run,call.id,call.dispatchToken)).dispatch,true);
 await receipt(c,f,call,'0.001');await receipt(c,f,call,'0.001');
 assert.equal(await one('SELECT charged v FROM bill2_runs WHERE id=$1',[f.run]),5);
 return call;
}
async function stale(f){
 await c.query("UPDATE social_review_runs SET created_at=now()-interval '20 minutes' WHERE id=$1",[f.review.id]);
 await c.query("UPDATE runtime_executions SET created_at=now()-interval '20 minutes' WHERE id=$1",[f.execution]);
 await c.query("UPDATE bill2_runs SET runtime_dispatch_deadline=now()-interval '2 minutes' WHERE id=$1",[f.run]);
 await c.query("UPDATE bill2_calls SET created_at=now()-interval '20 minutes',dispatched_at=CASE WHEN dispatched_at IS NOT NULL THEN now()-interval '20 minutes' END WHERE run_id=$1",[f.run]);
}
const ledger=(f)=>one(`SELECT jsonb_build_object('balance',p.credits,'sum',
 (SELECT sum(amount) FROM credit_transactions WHERE user_id=p.id),'charged',r.charged,
 'theoretical',r.theoretical_credits,'absorbed',r.platform_absorbed_credits,'closed',r.closed,'state',r.state,
 'holds',(SELECT count(*) FROM bill2_calls WHERE run_id=r.id AND settled_at IS NULL),
 'spends',(SELECT count(*) FROM credit_transactions WHERE bill2_run_id=r.id AND reason_code='bill2_spend')) v
 FROM profiles p JOIN bill2_runs r ON r.actor_id=p.id WHERE r.id=$1`,[f.run]);
// 0407 retries an interruption up to three attempts; these scenarios are about the last one, which ends the period.
async function expire(f,attempt=3){
 await c.query('UPDATE social_review_runs SET attempt=$2 WHERE id=$1',[f.review.id,attempt]);
 assert.equal((await step(f.review,'observe')).expired,true);
 const cancelled=await rpc(c,'runtime_cancel',f.actor,f.execution);
 assert.ok(['cancelled','cost_pending'].includes(cancelled.state));
 return step(f.review,'skip','RUNTIME_INTERRUPTED');
}
try{
 await c.query(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
  own_data_window_days,allow_weekly_auto_review,allow_benchmark_monitor) VALUES('Interruption Gold','gold',true,true,0,90,true,true)`);
 await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_enabled','true'),
  ('publish_monitor_review_enabled','true'),('chat_my_posts_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'`);
 const f=await fixture();const first=await debit(f);
 assert.equal((await step(f.review,'observe')).expired,false,'fresh review can continue with the original run');
 await stale(f);
 // Even beyond the wall-clock deadline a genuinely live owner may finish its current dispatch.
 await c.query("UPDATE bill2_runs SET runtime_dispatch_deadline=now()+interval '1 minute' WHERE id=$1",[f.run]);
 assert.equal((await step(f.review,'observe')).expired,false);
 await c.query("UPDATE bill2_runs SET runtime_dispatch_deadline=now()-interval '2 minutes' WHERE id=$1",[f.run]);
 const released=await rpc(c,'runtime_interrupted_recovery',f.actor,f.execution,f.epoch,20);
 assert.equal(released.state,'released');
 assert.equal(await one('SELECT failure_code v FROM runtime_executions WHERE id=$1',[f.execution]),'RUNTIME_INTERRUPTED_RELEASED');
 assert.deepEqual(await ledger(f),{balance:995,sum:995,charged:5,theoretical:5,absorbed:0,closed:false,state:'prepared',holds:0,spends:1});
 report.checks.push('real deployment/owner-loss recovery reproduces interrupted/released, prepared open BILL2, exactly 5 credits charged');
 await c.query('BEGIN');await c.query(body(rollback));
 assert.equal((await step(f.review,'observe')).expired,undefined);
 assert.equal(await one('SELECT status v FROM social_review_runs WHERE id=$1',[f.review.id]),'claimed');
 await c.query('ROLLBACK');
 report.checks.push('RED: old observe leaves the released charged review claimed without a deadline or recoverable user');
 // 0407: an earlier attempt is retried with a new request; its settled actual cost comes off the same review's cap.
 await c.query('BEGIN');
 const cap=await one('SELECT max_cost_usd::text v FROM social_review_runs WHERE id=$1',[f.review.id]);
 assert.equal((await expire(f,1)).state,'retrying');
 const retried=(await c.query('SELECT * FROM social_review_runs WHERE id=$1',[f.review.id])).rows[0];
 const cost=Number(await one('SELECT provider_cost_usd v FROM bill2_runs WHERE id=$1',[f.run]));
 assert.equal(retried.status,'claimed');assert.equal(retried.attempt,2);assert.notEqual(retried.runtime_request_id,f.review.requestId);
 assert.deepEqual(retried.prior_bill2_run_ids,[f.run]);assert.ok(cost>0);
 assert.equal(await one('SELECT ($1::numeric-provider_cost_usd)::text v FROM bill2_runs WHERE id=$2',[cap,f.run]),
  await one('SELECT max_cost_usd::text v FROM social_review_runs WHERE id=$1',[f.review.id]));
 assert.deepEqual(await ledger(f),{balance:995,sum:995,charged:5,theoretical:5,absorbed:0,closed:true,state:'settled',holds:0,spends:1});
 await c.query('ROLLBACK');
 report.checks.push('0407: an interrupted attempt is retried once more with a new request, its settled 5 credits kept and its cost off the cap');
 await expire(f);
 const final=await ledger(f);
 assert.deepEqual(final,{balance:995,sum:995,charged:5,theoretical:5,absorbed:0,closed:true,state:'settled',holds:0,spends:1});
 const history=(await rpc(c,'publish_monitor_reviews',f.actor)).find(r=>r.id===f.review.id);
 assert.equal(history.status,'skipped');assert.equal(history.skipReason,'RUNTIME_INTERRUPTED');
 assert.equal(await one('SELECT count(*)::int v FROM runtime_executions WHERE actor_id=$1 AND request_id=$2',
  [f.actor,f.review.requestId]),1);
 assert.match(history.notice,/生成中断/);assert.match(history.notice,/实际结算/);assert.equal(history.body,null);
 await rpc(c,'runtime_cancel',f.actor,f.execution);await receipt(c,f,first,'0.001');
 assert.deepEqual(await ledger(f),final,'cancellation and receipt replay cannot create another charge or refund');
 report.checks.push('GREEN: the same review/request/run closes once, keeps actual 5-credit usage and exposes an explicit interruption notice');
 // Previous failure does not occupy the next period forever.
 await c.query(`UPDATE social_review_runs SET period_start=current_date-9,finished_at=now()-interval '8 days',
  created_at=now()-interval '9 days' WHERE id=$1`,[f.review.id]);
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '20 days' WHERE actor_id=$1",[f.actor]);
 const next=(await rpc(c,'publish_monitor_review_claim',20)).find(r=>r.actorId===f.actor);
 assert.ok(next);assert.notEqual(next.id,f.review.id);assert.notEqual(next.requestId,f.review.requestId);
 assert.deepEqual(await ledger(f),final);
 report.checks.push('next weekly period can claim normally without reusing or charging the failed period');
 // A second, never-dispatched call has a real reservation that must be released on timeout.
 const held=await fixture();await debit(held);
 const pending=await rpc(c,'bill2_claim',held.actor,held.run,2,{...held.claimPayload,runtimeEpoch:held.epoch});
 assert.ok(pending.dispatchToken);assert.ok((await ledger(held)).balance<995);
 await stale(held);await expire(held);
 assert.equal((await ledger(held)).balance,995);assert.equal((await ledger(held)).sum,995);
 assert.equal((await ledger(held)).holds,0);assert.equal((await ledger(held)).charged,5);
 report.checks.push('undispatched second-call reservation is fully refunded, while the first settled call remains charged exactly once');
 // Two independent workers racing cancellation serialize on the original native run.
 const concurrent=await fixture();await debit(concurrent);await stale(concurrent);
 const connection=c.connectionParameters;
 const other=new c.constructor({connectionString:`postgres://postgres@127.0.0.1:${connection.port}/${connection.database}`});
 await other.connect();
 try{await Promise.all([c,other].map(client=>rpc(client,'runtime_cancel',concurrent.actor,concurrent.execution)));}
 finally{await other.end();}
 await step(concurrent.review,'skip','RUNTIME_INTERRUPTED');
 assert.deepEqual(await ledger(concurrent),{balance:995,sum:995,charged:5,theoretical:5,absorbed:0,closed:true,state:'settled',holds:0,spends:1});
 await assert.rejects(step({...concurrent.review,token:randomUUID()},'observe'),/REVIEW_LEASE_LOST/);
 report.checks.push('two independent cancellation connections preserve one settlement; a stale/foreign review lease is rejected');
 // Unknown supplier costs cannot be made up to report a successful refund.
 const unknown=await fixture();
 const unresolved=await rpc(c,'bill2_claim',unknown.actor,unknown.run,1,{...unknown.claimPayload,runtimeEpoch:unknown.epoch});
 await rpc(c,'bill2_dispatch',unknown.actor,unknown.run,unresolved.id,unresolved.dispatchToken);
 await stale(unknown);await expire(unknown);
 assert.equal((await ledger(unknown)).state,'cost_pending');assert.equal((await ledger(unknown)).closed,true);
 let pendingHistory=(await rpc(c,'publish_monitor_reviews',unknown.actor)).find(r=>r.id===unknown.review.id);
 assert.equal(pendingHistory.status,'skipped');assert.match(pendingHistory.notice,/费用正在核对/);
 await receipt(c,unknown,unresolved,'0.001');
 const recovered=await ledger(unknown);assert.equal(recovered.state,'settled');assert.equal(recovered.balance,995);
 assert.equal(recovered.sum,995);assert.equal(recovered.spends,1);
 pendingHistory=(await rpc(c,'publish_monitor_reviews',unknown.actor)).find(r=>r.id===unknown.review.id);
 assert.match(pendingHistory.notice,/实际结算/);
 report.checks.push('unknown costs show interruption plus financial reconciliation; a late native receipt settles once and updates the notice');
 // The result may commit after expiry was observed but before native cancellation gets its locks.
 const saved=await fixture();
 await rpc(c,'runtime_execution',saved.actor,saved.execution,'owner_session',
  {epoch:saved.epoch,value:{action:'freeze',items:[]}});
 await debit(saved);
 const late=await rpc(c,'bill2_claim',saved.actor,saved.run,2,{...saved.claimPayload,runtimeEpoch:saved.epoch});
 await rpc(c,'bill2_dispatch',saved.actor,saved.run,late.id,late.dispatchToken);
 const tool={callId:'saved-review-data',name:'read_source',arguments:{query:'my_posts:90'}};
 await rpc(c,'runtime_execution',saved.actor,saved.execution,'owner_tool',
  {epoch:saved.epoch,value:{...tool,action:'claim',result:null}});
 await rpc(c,'runtime_execution',saved.actor,saved.execution,'owner_tool',
  {epoch:saved.epoch,value:{...tool,action:'complete',result:{kind:'my_posts',status:'available',window_days:90,
   dependencies:[],review:{rows:[{views:12}]}}}});
 await rpc(c,'runtime_execution',saved.actor,saved.execution,'owner_session',
  {epoch:saved.epoch,value:{action:'append',items:[{role:'assistant',content:'KEEP_GENERATED_REVIEW'}],batch:0}});
 await stale(saved);
 assert.equal((await step(saved.review,'observe')).expired,true);
 const completed=await rpc(c,'runtime_execution',saved.actor,saved.execution,'complete',
  {epoch:saved.epoch,value:{kind:'usable_result',body:'KEEP_GENERATED_REVIEW',
   evidenceRef:saved.execution,evidenceHash:'a'.repeat(64)}});
 assert.equal(completed.state,'cost_pending');
 assert.equal((await rpc(c,'runtime_cancel',saved.actor,saved.execution)).state,'cost_pending');
 const pendingMoney=await ledger(saved);
 const guarded=await step(saved.review,'skip','RUNTIME_INTERRUPTED');
 assert.equal(guarded.state,'cost_pending');
 assert.equal(await one('SELECT status v FROM social_review_runs WHERE id=$1',[saved.review.id]),'claimed',
  'saved output awaiting costs must remain on the normal completion path, never permanently skipped');
 assert.match((await rpc(c,'publish_monitor_reviews',saved.actor)).find(r=>r.id===saved.review.id).notice,/已生成，费用正在核对/);
 assert.deepEqual(await ledger(saved),pendingMoney);
 assert.equal((await step(saved.review,'observe')).expired,false);
 report.checks.push('a real completion winning expiry with unsettled costs preserves its claimed review and original money facts');
 await receipt(c,saved,late,'0.001');
 assert.equal((await rpc(c,'runtime_financial_recovery',saved.actor,saved.execution,true)).state,'completed');
 // The financial worker can also finish between cancel's response and the final review transaction.
 await step(saved.review,'skip','RUNTIME_INTERRUPTED');
 const savedHistory=(await rpc(c,'publish_monitor_reviews',saved.actor)).find(r=>r.id===saved.review.id);
 assert.equal(savedHistory.status,'completed');assert.equal(savedHistory.body,'KEEP_GENERATED_REVIEW');
 assert.deepEqual(savedHistory.tables,{rows:[{views:12}]});
 const savedMoney=await ledger(saved);assert.equal(savedMoney.balance,990);assert.equal(savedMoney.sum,990);
 assert.equal(savedMoney.charged,10);assert.equal(savedMoney.spends,2);
 await receipt(c,saved,late,'0.001');await rpc(c,'runtime_financial_recovery',saved.actor,saved.execution,true);
 assert.deepEqual(await ledger(saved),savedMoney);
 report.checks.push('late receipt recovery makes the paid saved report visible; completion beats skip and replay never charges twice');
 // Finalization must not read an execution row while its owner is still committing it.
 const busy=await fixture();await debit(busy);await stale(busy);
 await c.query('UPDATE social_review_runs SET attempt=3 WHERE id=$1',[busy.review.id]);
 await rpc(c,'runtime_cancel',busy.actor,busy.execution);
 const params=c.connectionParameters;
 const writer=new c.constructor({connectionString:`postgres://postgres@127.0.0.1:${params.port}/${params.database}`});
 await writer.connect();
 try{
  await writer.query('BEGIN');
  await writer.query('SELECT id FROM runtime_executions WHERE id=$1 FOR UPDATE',[busy.execution]);
  await assert.rejects(step(busy.review,'skip','RUNTIME_INTERRUPTED'),error=>error.code==='55P03');
  assert.equal(await one('SELECT status v FROM social_review_runs WHERE id=$1',[busy.review.id]),'claimed');
 }finally{await writer.query('ROLLBACK');await writer.end();}
 await step(busy.review,'skip','RUNTIME_INTERRUPTED');
 assert.equal(await one('SELECT status v FROM social_review_runs WHERE id=$1',[busy.review.id]),'skipped');
 report.checks.push('a concurrent result writer makes skip retry without waiting; retry terminates only the empty result');
 const fingerprint=read('packages/db/tests/baseline/fingerprint.sql');
 const catalog=fingerprint.slice(0,fingerprint.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
 // Later redefinitions (0407 step) replay after it, as in the publish-monitor suites (MAINT-P1).
 const before=await one(catalog);
 for(const _ of [1,2])for(const path of [MIGRATION_PATH,...laterRedefinitions('0401')])await c.query(read(path));
 assert.deepEqual(await one(catalog),before);
 report.checks.push('0401 reapplies twice without catalog or accounting changes');
 const permissions=(await c.query(`SELECT role,has_function_privilege(role,'publish_monitor_review_step(uuid,uuid,text,text)','EXECUTE') allowed
  FROM unnest(ARRAY['anon','authenticated','service_role']) role ORDER BY role`)).rows;
 assert.deepEqual(permissions,[{role:'anon',allowed:false},{role:'authenticated',allowed:false},{role:'service_role',allowed:true}]);
 report.checks.push('review mutation remains service-role-only');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
