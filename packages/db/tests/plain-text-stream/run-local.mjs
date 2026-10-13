/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CHAT-NATIVE-OUTPUT (0239): 停止 on free chat (v6) and Skill (v2) turns frozen with
// textStream='plain-text-v1'. Local only: node packages/db/tests/plain-text-stream/run-local.mjs --local-only
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
const database=await localDb(),db=database.client;
const migration=read('packages/db/migrations/0239_runtime_plain_text_stream.sql');
const report={checks:[],failed:null};
const MARK={textStream:'plain-text-v1'};
const FREE_CHAT={role:'ordinary',providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{effort:'low'}};
const SKILL={role:'skill',providerRequestFormat:'serial-tools-v2'};
try{
 await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 async function setup(extra){
  const f=await createFixture(db);
  const session=await rpc(db,'runtime_start',f.actor,randomUUID(),{scope:f.payload.scope});
  const context={version:'runtime.v1',sdkVersion:'0.18.0',input:'input',instructions:'Answer',
   model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:1,historyItems:0,
   tools:[],network:'deny',nativeOutput:'native-output-v1',...extra};
  const admission=await rpc(db,'runtime_admit',f.actor,session.sessionId,randomUUID(),context,{...f.payload,operation:'question',input:context});
  const begin=await rpc(db,'runtime_execution',f.actor,admission.executionId,'begin',null);
  return {...f,run:admission.runId,execution:admission.executionId,session:session.sessionId,epoch:begin.epoch};
 }
 const action=(f,name,value,client=db)=>rpc(client,'runtime_execution',f.actor,f.execution,name,value);
 const complete=(f,result,client=db)=>action(f,'complete',{epoch:f.epoch,value:result},client);
 const result=(body,extra={})=>({kind:'usable_result',body,stopped:true,completeness:'stopped',
  evidenceRef:'synthetic-stop',evidenceHash:'a'.repeat(64),...extra});
 const facts=async f=>(await db.query(`SELECT to_jsonb(b) b,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM credit_transactions t WHERE t.bill2_run_id=b.id) ledger,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.sequence) FROM bill2_calls c WHERE c.run_id=b.id) calls,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.revision) FROM runtime_session_history h WHERE h.execution_id=$2) history
  FROM bill2_runs b WHERE b.id=$1`,[f.run,f.execution])).rows[0];

 for(const [label,shape] of [['free chat',FREE_CHAT],['Skill',SKILL]]){
  const f=await setup({...shape,...MARK});
  const call=await claim(db,f);
  // In flight: the stop is recorded, the dispatched call is held, nothing settles twice.
  assert.equal((await action(f,'stop',{stopAt:2,source:'assistant'})).state,'stopping',label);
  assert.deepEqual((await action(f,'read',null)).stop,{stopAt:2,source:'assistant'},label);
  await action(f,'stop',{stopAt:5,source:'final'});
  assert.deepEqual((await action(f,'read',null)).stop,{stopAt:2,source:'assistant'},label+': first stop intent kept');
  await receipt(db,f,call);await rpc(db,'bill2_finalize',f.actor,f.run);
  const settled=await facts(f);
  assert.equal(settled.calls.length,1,label);assert.ok(settled.calls[0].settled_at,label);
  // The kept text is plain: no envelope parsing, at most stopAt code points.
  await assert.rejects(complete(f,result('中😀后')),/RUNTIME_STOP_POSITION_EXCEEDED/);
  const other=new pg.Client(db.connectionParameters);await other.connect();
  try{
   const outcomes=await Promise.all([complete(f,result('{"')),complete(f,result('{"'),other)]);
   assert.ok(outcomes.every(o=>o.state==='completed'),label+': concurrent completion converges');
  }finally{await other.end();}
  const once=await facts(f);
  assert.deepEqual(once.ledger,settled.ledger,label+': completion adds no charge beyond the settled call');
  await complete(f,result('{"'));assert.deepEqual(await facts(f),once,label+': repeat completion is read-only');
  await assert.rejects(complete(f,result('别')),/RUNTIME_RESULT_CONFLICT/);
  assert.equal((await action(f,'stop',{stopAt:1,source:'assistant'})).state,'completed');
  assert.deepEqual(await facts(f),once,label+': a late stop changes nothing');
  const visible=(await db.query('SELECT item FROM runtime_session_history WHERE execution_id=$1 AND NOT internal_control ORDER BY revision',
   [f.execution])).rows;
  assert.deepEqual(visible.map(row=>row.item),[{role:'user',content:'input'},{role:'assistant',content:'{"'}],label);
  assert.equal((await rpc(db,'runtime_view',f.actor,f.session)).executions.find(e=>e.executionId===f.execution).stopped,true);
 }
 report.checks.push('marked v6/v2: stop keeps first intent, settles the dispatched call once, saves plain prefix (never an envelope), '+
  'concurrent/repeat completion once, late stop read-only, history holds the shown text');

 const pending=await setup({...FREE_CHAT,...MARK});const unstarted=await claim(db,pending,1,false);
 assert.equal((await action(pending,'stop',{stopAt:3,source:'assistant'})).state,'stopped_pending_result');
 const unused=(await db.query('SELECT state,charged_delta,settled_at FROM bill2_calls WHERE id=$1',[unstarted.id])).rows[0];
 assert.equal(unused.state,'cancelled');assert.equal(unused.charged_delta,0);assert.ok(unused.settled_at);
 assert.equal((await complete(pending,null)).state,'cancelled');
 const emptyOnce=await facts(pending);await complete(pending,null);assert.deepEqual(await facts(pending),emptyOnce);
 report.checks.push('stop before dispatch releases the prepared call uncharged; empty completion cancels once');

 for(const [label,shape] of [['unmarked free chat',FREE_CHAT],['unmarked Skill',SKILL]]){
  const legacy=await setup(shape);await claim(db,legacy,1,false);
  assert.equal((await action(legacy,'stop',{stopAt:2,source:'assistant'})).state,'cancelled',label);
  const run=(await db.query('SELECT paused_reason,cancel_requested,closed FROM bill2_runs WHERE id=$1',[legacy.run])).rows[0];
  assert.notEqual(run.paused_reason,'user_stop',label);assert.equal(run.cancel_requested,true,label);assert.equal(run.closed,true,label);
 }
 report.checks.push('unmarked v6/v2 turns keep the legacy runtime_cancel');

 // The report only lists quiet rounds: age both rounds past the cutoff and drop the live dispatch lease
 // that `begin` holds (a round still inside its lease is never a stale-round candidate).
 const stale=await setup({...FREE_CHAT,...MARK});
 const staleCall=await claim(db,stale);await receipt(db,stale,staleCall);await rpc(db,'bill2_finalize',stale.actor,stale.run);
 const plain=await setup(FREE_CHAT);
 const plainCall=await claim(db,plain);await receipt(db,plain,plainCall);await rpc(db,'bill2_finalize',plain.actor,plain.run);
 for(const r of [stale,plain]){
  await db.query("UPDATE runtime_executions SET created_at=created_at-interval '2 days' WHERE id=$1",[r.execution]);
  await db.query("UPDATE bill2_runs SET runtime_dispatch_deadline=NULL WHERE id=$1",[r.run]);
  await db.query(`UPDATE bill2_calls SET created_at=created_at-interval '2 days',
   dispatched_at=dispatched_at-interval '2 days',settled_at=settled_at-interval '2 days' WHERE run_id=$1`,[r.run]);
 }
 const cutoff=(await db.query("SELECT clock_timestamp()-interval '1 day' t")).rows[0].t;
 const rounds=(await db.query('SELECT runtime_stale_charged_rounds($1,500) r',[cutoff])).rows[0].r;
 const reported=id=>rounds.rounds?.find(r=>r.executionId===id);
 if(!reported(stale.execution)||!reported(plain.execution)){
  // Show every filter the report applies, so a miss names its reason instead of passing silently.
  const why=await db.query(`SELECT e.id,e.state,e.created_at,r.contract_version,r.closed,r.cancel_requested,r.paused_reason,
   r.runtime_dispatch_deadline,(SELECT is_deleted FROM profiles p WHERE p.id=e.actor_id) deleted,
   (SELECT jsonb_agg(jsonb_build_object('state',c.state,'charged',c.charged_delta,'created',c.created_at,'dispatched',c.dispatched_at,
     'settled',c.settled_at,'compensated',c.compensated_at)) FROM bill2_calls c WHERE c.run_id=r.id) calls
   FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id WHERE e.id=ANY($1)`,[[stale.execution,plain.execution]]);
  assert.fail('stale-round fixture not reported: '+JSON.stringify({cutoff,rows:why.rows}));
 }
 assert.equal(reported(stale.execution).evidence.streamed,true,'marked plain-text turn is reported as streamed');
 assert.equal(reported(plain.execution).evidence.streamed,false,'unmarked v6 turn is reported as not streamed');
 report.checks.push('stale charged rounds report a marked turn as streamed and an unmarked v6 turn as not');

 for(const sig of ['public.runtime_execution(uuid,uuid,text,jsonb)','public.runtime_stale_charged_rounds(timestamptz,integer)']){
  const def=(await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d;
  await db.query(migration);await db.query(migration);
  assert.equal((await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d,def,sig);
  assert.match(def,/textStream/);
 }
 const sig='public.runtime_execution(uuid,uuid,text,jsonb)';
 const def=(await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d;
 await db.query(def.replace('BEGIN','BEGIN\n -- synthetic source drift'));
 await assert.rejects(db.query(migration),/PLAIN_TEXT_STREAM_SOURCE_MISMATCH/);await db.query('ROLLBACK');
 await db.query(def);
 report.checks.push('migration twice unchanged; changed source rejected transactionally');
}catch(error){report.failed=String(error)+"\n"+error.stack;process.exitCode=1;}
finally{await database.close();console.log(JSON.stringify(report,null,2));}
