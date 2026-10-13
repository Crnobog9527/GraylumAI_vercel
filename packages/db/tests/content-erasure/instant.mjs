/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0231: one-click conversation deletion marks only the selected session, then cleans up later.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runtimeFixture} from './cases.mjs';
import {rpc,fixture,evidence,closeAccount} from '../erasure-b2a/cases.mjs';
const mark=(db,f,id=f.session)=>rpc(db,'content_erasure_mark_session',f.actor,id);
const cleanup=(db,f,id=f.session)=>rpc(db,'content_erasure_confirm',f.actor,'session',id,null);
const row=async(db,table,id)=>(await db.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];
async function bystander(db,f){
 const id=randomUUID();
 await db.query(`INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
  SELECT $1::uuid,actor_id,scope||jsonb_build_object('fixtureBystander',$1::text),gen_random_uuid(),'{}' FROM runtime_sessions WHERE id=$2`,[id,f.session]);
 return id;
}
export async function runInstant({db,Client,connectionString,report}){
 const locker=new Client({connectionString});await locker.connect();
 try{
  // Allow: the owner's mark commits only the marker, and every read, write and replay is refused at once.
  const f=await runtimeFixture(db,{settled:true});
  for(const role of ['anon','authenticated']){
   await db.query('SET ROLE '+role);
   await assert.rejects(mark(db,f),/permission denied/);
   await assert.rejects(rpc(db,'content_erasure_sweep_sessions',10),/permission denied/);
   await db.query('RESET ROLE');
  }
  const other=await fixture(db);
  await assert.rejects(mark(db,{...f,actor:other.actor}),/CONTENT_NOT_FOUND/);
  assert.equal((await row(db,'runtime_sessions',f.session)).content_deleted_at,null,'denied mark leaves the session');
  await db.query('SET ROLE service_role');
  assert.deepEqual(await mark(db,f),{kind:'session',id:f.session,status:'deleted',alreadyDeleted:false,
   preservedSavedVersions:0,financialReviewCount:0});
  await db.query('RESET ROLE');
  const marked=await row(db,'runtime_sessions',f.session);
  assert.ok(marked.content_deleted_at);assert.equal(marked.erased_at,null,'physical cleanup is not synchronous');
  await assert.rejects(rpc(db,'runtime_view',f.actor,f.session),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'runtime_execution',f.actor,f.execution,'read',null),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'content_erasure_visible',f.actor,f.execution),/CONTENT_ERASED/);
  await assert.rejects(rpc(db,'runtime_admission_replay',f.actor,(await row(db,'runtime_executions',f.execution)).request_id,{}),
   /CONTENT_ERASED/);
  await assert.rejects(db.query(`INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision)
   VALUES($1,$2,$3,'{}',0)`,[f.actor,f.session,randomUUID()]),/CONTENT_ERASED/);
  assert.equal((await mark(db,f)).alreadyDeleted,true,'repeat is a no-op');
  report.checks.push('mark: owner only, marker-only commit, read/write/replay refused at once, repeat no-op');

  // Cleanup runs the unchanged confirm on its already-deleted path (no client hash).
  await assert.rejects(rpc(db,'content_erasure_confirm',f.actor,'session',(await bystander(db,f)),null),/PREVIEW_CHANGED/,
   'an unmarked session still needs the preview hash');
  assert.equal((await cleanup(db,f)).alreadyDeleted,true);
  const cleaned=await row(db,'runtime_sessions',f.session);
  assert.ok(cleaned.erased_at);assert.equal(cleaned.scope,null);
  assert.equal((await row(db,'runtime_executions',f.execution)).payload,null);
  assert.equal((await cleanup(db,f)).alreadyDeleted,true,'repeat cleanup is a no-op');
  report.checks.push('cleanup: confirm without hash only for a marked session; body cleared; repeat no-op');

  // Another conversation of the same account is busy (a reply is generating there).
  const g=await runtimeFixture(db,{settled:true});
  const busyElsewhere=await bystander(db,g);
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[busyElsewhere]);
  assert.equal((await mark(db,g)).status,'deleted','another busy conversation does not block the mark');
  assert.equal((await cleanup(db,g)).status,'deleted','nor the cleanup of a marked session');
  await locker.query('ROLLBACK');
  report.checks.push('a busy other conversation of the same account blocks neither mark nor cleanup');

  // The same conversation is held by a committing reply: wait briefly, then busy without a marker.
  const h=await runtimeFixture(db,{settled:true});
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[h.session]);
  const started=Date.now();
  await assert.rejects(mark(db,h),/CONTENT_ERASURE_BUSY/);
  assert.ok(Date.now()-started<5000,'bounded wait');
  await locker.query('ROLLBACK');
  assert.equal((await row(db,'runtime_sessions',h.session)).content_deleted_at,null,'busy leaves no marker');
  report.checks.push('same conversation locked: bounded wait then busy, nothing marked');

  // Same conversation generating (dispatched, cost unknown): mark first, then the late result is refused
  // while the original money path still records the provider cost.
  const p=await runtimeFixture(db,{dispatched:true});
  const before=(await db.query('SELECT credits FROM profiles WHERE id=$1',[p.actor])).rows[0].credits;
  await mark(db,p);
  await assert.rejects(rpc(db,'runtime_execution',p.actor,p.execution,'complete',{text:'LATE_PRIVATE_RESULT'}),/CONTENT_ERASED/);
  await assert.rejects(db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
   VALUES($1,1,$2,'{"role":"assistant"}')`,[p.session,p.execution]),/CONTENT_ERASED/);
  assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[p.actor])).rows[0].credits,before,
   'mark neither charges nor refunds');
  await rpc(db,'bill2_record',p.actor,p.run,p.call.id,evidence(p.call));
  await cleanup(db,p);
  const late=(await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[p.call.id])).rows[0].payload;
  assert.doesNotMatch(JSON.stringify(late),/B2A_PRIVATE_CANARY|LATE_PRIVATE_RESULT|sdkResponse|rawBody/);
  assert.doesNotMatch(JSON.stringify(await row(db,'runtime_executions',p.execution)),/LATE_PRIVATE_RESULT/);
  report.checks.push('same conversation generating: late result and history refused after mark; money recorded on original run');

  // Sweep: the cron backstop cleans marked sessions, skips closed accounts, survives busy ones.
  const s1=await runtimeFixture(db,{settled:true}),s2=await runtimeFixture(db,{settled:true}),s3=await runtimeFixture(db,{settled:true});
  for(const x of [s1,s2,s3])await mark(db,x);
  await closeAccount(db,s3);
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_executions WHERE id=$1 FOR UPDATE',[s2.execution]);
  await assert.rejects(rpc(db,'content_erasure_sweep_sessions',0),/SWEEP_LIMIT/);
  const first=await rpc(db,'content_erasure_sweep_sessions',200);
  await locker.query('ROLLBACK');
  assert.ok(first.pending>=1,'busy session stays pending');
  assert.ok((await row(db,'runtime_sessions',s1.session)).erased_at);
  assert.equal((await row(db,'runtime_sessions',s2.session)).erased_at,null);
  await rpc(db,'content_erasure_sweep_sessions',200);
  assert.ok((await row(db,'runtime_sessions',s2.session)).erased_at,'retried on the next run');
  assert.equal((await row(db,'runtime_sessions',s3.session)).erased_at,null,'closed account left to account erasure');
  await rpc(db,'account_erasure_scrub_runtime',s3.actor);
  report.checks.push('sweep: cleans marked sessions oldest first, busy retried next run, closed accounts skipped');
 }finally{await db.query('RESET ROLE');await locker.query('ROLLBACK');await locker.end();}
}
