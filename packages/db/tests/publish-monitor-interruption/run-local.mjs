/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
// V2-12 B8b (0467): the weekly review on kind='review' turns. Real local turn core and review functions; no provider calls or remote database.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {rpc as nativeRpc} from '../erasure-b2a/cases.mjs';
import {laterRedefinitions} from '../publish-monitor/fixtures.mjs';

const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
async function service(client,work){
 await client.query('SET ROLE service_role');
 try{return await work();}finally{await client.query('RESET ROLE');}
}
const rpc=(client,...args)=>service(client,()=>nativeRpc(client,...args));
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const svc=(sql,args=[])=>service(c,()=>one(sql,args));
const MIGRATION_PATH='packages/db/migrations/0467_publish_monitor_review_turns.sql';
const step=(r,action,reason=null)=>rpc(c,'publish_monitor_review_step',r.id,r.token,action,reason);
const hash=text=>createHash('sha256').update(text).digest('hex');
const POLICY={q:100,uTurnUsd:0.04,gCredits:24,minCredits:6,uModelCredits:24,historyItems:0,inputBytes:32000,
 limits:{model:1,paidTools:0,freeTools:0,decisions:0},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5},review:{mode:'weekly'}};
async function fixture(cap='0.03'){
 const f=await createFixture(c,{credits:1000,q:'5000',threshold:1});
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_review_model_id',$1::jsonb),
  ('publish_monitor_review_max_usd',$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify(f.payload.modelId),JSON.stringify(cap)]);
 await rpc(c,'publish_monitor_set_auto_review',f.actor,true);
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1",[f.actor]);
 const review=(await rpc(c,'publish_monitor_review_claim',20)).find(r=>r.actorId===f.actor);
 assert.ok(review?.sessionId,'the claim carries the review session (no Runtime start)');
 return {...f,review};
}
const reload=async r=>(await c.query('SELECT * FROM social_review_runs WHERE id=$1',[r.id])).rows[0];
/** The review's turn as the Node side runs it: open on the claimed request, one model call, close. cost null: the call has no receipt. */
async function turn(f,{close='completed',delivered=true,cost='0.01',message='KEEP_GENERATED_REVIEW'}={}){
 const r=f.review,state=await reload(r);
 const opened=await svc('SELECT turn_open($1,$2,$3,$4,$5) v',[f.actor,r.sessionId,state.runtime_request_id,'review',JSON.stringify(POLICY)]);
 const id=opened.turnId;
 await svc("SELECT turn_call_begin($1,$2,1,'model',$3,NULL,NULL,$4,'0.04','6') v",[f.actor,id,randomUUID(),hash('r'+id)]);
 if(cost!==null)await svc("SELECT turn_call_record($1,$2,1,'ok',$3,$3,'{}'::jsonb,NULL,$4,'body') v",[f.actor,id,cost,hash('p'+id)]);
 const messages=close==='completed'?[{role:'user',content:'review request'},{role:'assistant',content:message}]:[];
 const closed=await svc('SELECT turn_close($1,$2,$3,$4,$5,false,NULL) v',[f.actor,id,close,JSON.stringify(messages),delivered]);
 return {id,closed};
}
/** After a retry the claim is immediately claimable: the next batch takes it again with a new lease. */
const reclaim=async f=>{f.review=(await rpc(c,'publish_monitor_review_claim',20)).find(r=>r.id===f.review.id);assert.ok(f.review);};

try{
 await c.query(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
  own_data_window_days,allow_weekly_auto_review,allow_benchmark_monitor) VALUES('Interruption Gold','gold',true,true,0,90,true,true)`);
 await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_enabled','true'),
  ('publish_monitor_review_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'`);
 // 1. A delivered review completes; the page reads the body from the turn's saved assistant message and the tables from the saved pack.
 const done=await fixture();
 const pack={kind:'my_posts',status:'available',source_connections:[],review:{rows:[{views:12}]}};
 assert.equal(await svc('SELECT publish_monitor_review_save_pack($1,$2,$3) v',[done.review.id,done.review.token,JSON.stringify(pack)]),true);
 assert.equal(await svc('SELECT publish_monitor_review_save_pack($1,$2,$3) v',[done.review.id,randomUUID(),JSON.stringify(pack)]),false,'only under the lease');
 const t1=await turn(done);
 assert.equal(t1.closed.closeKind,'completed');
 const observed=await step(done.review,'observe');
 assert.deepEqual([observed.state,String(observed.turnId)],['completed',String(t1.id)]);
 const row=await reload(done.review);
 assert.deepEqual([row.status,String(row.turn_id),row.finished_at!==null],['completed',String(t1.id),true]);
 const history=(await rpc(c,'publish_monitor_reviews',done.actor)).find(r=>r.id===done.review.id);
 assert.equal(history.status,'completed');assert.equal(history.body,'KEEP_GENERATED_REVIEW');
 assert.deepEqual(history.tables,{rows:[{views:12}]});assert.equal(history.notice,'本周复盘已生成');
 assert.equal(await one('SELECT charged_credits v FROM turns WHERE id=$1',[t1.id]),6,'0.01 USD x 100 x 6 credits, the rest of the freeze back');
 report.checks.push('a delivered turn completes the review; the page body and tables come from the turn message and the saved pack; the user pays the receipt');

 // 2. An interrupted attempt with a known cost is retried as a new attempt with a new request, sharing one cap.
 const retry=await fixture();
 const first=await turn(retry,{close:'interrupted',delivered:false,cost:'0.01'});
 const before=await reload(retry.review);
 const skipped=await step(retry.review,'skip','RUNTIME_INTERRUPTED');
 assert.equal(skipped.state,'retrying');
 const after=await reload(retry.review);
 assert.deepEqual([after.status,after.attempt,after.turn_id],['claimed',2,null]);
 assert.notEqual(after.runtime_request_id,before.runtime_request_id);
 assert.equal(await one('SELECT ($1::numeric-$2::numeric)::text v',[before.max_cost_usd,after.max_cost_usd]),'0.010000000000','the known cost comes off the shared cap');
 assert.equal(after.runtime_session_id,before.runtime_session_id,'the same conversation');
 await reclaim(retry);
 const second=await turn(retry,{close:'interrupted',delivered:false,cost:'0.005'});
 await step(retry.review,'skip','RUNTIME_INTERRUPTED');
 await reclaim(retry);
 assert.equal((await reload(retry.review)).attempt,3);
 await turn(retry,{close:'interrupted',delivered:false,cost:'0.001'});
 await step(retry.review,'skip','RUNTIME_INTERRUPTED');
 const ended=await reload(retry.review);
 assert.deepEqual([ended.status,ended.skip_reason],['skipped','RUNTIME_INTERRUPTED'],'the third attempt ends the period');
 assert.ok(first.id!==second.id);
 const notice=(await rpc(c,'publish_monitor_reviews',retry.actor)).find(r=>r.id===retry.review.id).notice;
 assert.match(notice,/生成中断，已用积分按实际结算/);
 report.checks.push('an interruption is retried up to three attempts with new request ids, the known cost of each taken off one cap');

 // 3. A turn whose cost is unknown (a call without a receipt) keeps the claim and is never retried while its settlement is pending.
 const unknown=await fixture();
 const u=await turn(unknown,{close:'interrupted',delivered:false,cost:null});
 assert.equal(await one('SELECT settlement v FROM turns WHERE id=$1',[u.id]),'pending');
 const kept=await step(unknown.review,'skip','RUNTIME_INTERRUPTED');
 assert.equal(kept.state,'cost_pending');
 const stillClaimed=await reload(unknown.review);
 assert.deepEqual([stillClaimed.status,stillClaimed.attempt],['claimed',1]);
 report.checks.push('a turn with an unknown cost keeps the claim and is not retried');

 // 4. A turn still running keeps its claim on skip; it expires after 15 minutes and is closed by the caller.
 const running=await fixture();
 const opened=await svc('SELECT turn_open($1,$2,$3,$4,$5) v',[running.actor,running.review.sessionId,running.review.requestId,'review',JSON.stringify(POLICY)]);
 const wait=await step(running.review,'skip','RUNTIME_INTERRUPTED');
 assert.equal(wait.state,'running');assert.equal((await reload(running.review)).status,'claimed');
 assert.equal((await step(running.review,'observe')).expired,false);
 await c.query("UPDATE social_review_runs SET created_at=now()-interval '20 minutes' WHERE id=$1",[running.review.id]);
 assert.equal((await step(running.review,'observe')).expired,true);
 await svc("SELECT turn_close($1,$2,'interrupted','[]'::jsonb,false,false,NULL) v",[running.actor,opened.turnId]);
 assert.equal((await step(running.review,'skip','RUNTIME_INTERRUPTED')).state,'retrying');
 report.checks.push('a running turn keeps its claim, expires after 15 minutes, and the interruption is then retried');

 // 5. A turn that delivered nothing (failed, or completed but undelivered) ends the period when observed; other reasons end it at once.
 for(const [close,delivered] of [['failed',false],['completed',false]]){
  const f=await fixture();
  await turn(f,{close,delivered,cost:"0.01"});
  const result=await step(f.review,'observe');
  assert.equal(result.state,'failed');
  assert.deepEqual([(await reload(f.review)).status],['skipped']);
 }
 const balance=await fixture();
 await step(balance.review,'skip','BALANCE_LOW');
 const low=await reload(balance.review);
 assert.deepEqual([low.status,low.skip_reason],['skipped','BALANCE_LOW']);
 assert.equal((await rpc(c,'publish_monitor_reviews',balance.actor)).find(r=>r.id===balance.review.id).notice,'余额不足，未复盘');
 report.checks.push('a turn that delivered nothing ends the period; a balance skip ends it at once and says so');

 // 6. A cap that leaves nothing after the known cost is not retried.
 const capped=await fixture('0.01');
 await turn(capped,{close:'interrupted',delivered:false,cost:'0.01'});
 await step(capped.review,'skip','RUNTIME_INTERRUPTED');
 assert.equal((await reload(capped.review)).status,'skipped');
 report.checks.push('an exhausted cap ends the period instead of retrying');

 const fingerprint=read('packages/db/tests/baseline/fingerprint.sql');
 const catalog=fingerprint.slice(0,fingerprint.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
 const before2=await one(catalog);
 for(const _ of [1,2])for(const path of [MIGRATION_PATH,...laterRedefinitions('0466')])await c.query(read(path));
 assert.deepEqual(await one(catalog),before2);
 report.checks.push('0467 reapplies twice without a catalog change');
 const permissions=(await c.query(`SELECT role,has_function_privilege(role,'publish_monitor_review_step(uuid,uuid,text,text)','EXECUTE') allowed
  FROM unnest(ARRAY['anon','authenticated','service_role']) role ORDER BY role`)).rows;
 assert.deepEqual(permissions,[{role:'anon',allowed:false},{role:'authenticated',allowed:false},{role:'service_role',allowed:true}]);
 for(const f of ['publish_monitor_review_session(uuid,uuid)','publish_monitor_review_save_pack(uuid,uuid,jsonb)'])
  for(const role of ['anon','authenticated'])assert.equal(await one("SELECT has_function_privilege($1,'public."+f+"','EXECUTE') v",[role]),false);
 report.checks.push('review mutation remains service-role-only');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
