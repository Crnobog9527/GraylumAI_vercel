/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runtimeFixture,erase,preview} from './cases.mjs';
import {closeAccount,rpc} from '../erasure-b2a/cases.mjs';
export async function runConcurrency({db,Client,connectionString,report}){
 const locker=new Client({connectionString});await locker.connect();
 try{
  const f=await runtimeFixture(db,{settled:true});
  await locker.query('BEGIN');await locker.query('SELECT id FROM runtime_sessions WHERE id=$1 FOR UPDATE',[f.session]);
  await assert.rejects(erase(db,f),/CONTENT_ERASURE_BUSY/);
  assert.equal((await db.query('SELECT content_deleted_at FROM runtime_executions WHERE id=$1',[f.execution])).rows[0].content_deleted_at,null);
  await locker.query('ROLLBACK');
  await locker.query('BEGIN');await closeAccount(locker,f);
  await assert.rejects(erase(db,f),/CONTENT_ERASURE_BUSY/);
  await locker.query('COMMIT');
  await assert.rejects(preview(db,f),/BILL2_ACTOR_DENIED/);
  await rpc(db,'account_erasure_scrub_runtime',f.actor);
  const g=await runtimeFixture(db,{settled:true});
  await db.query('BEGIN');await erase(db,g,'session',g.session);
  await locker.query("SET statement_timeout='5s'");
  const pid=(await locker.query('SELECT pg_backend_pid() id')).rows[0].id;
  const closing=closeAccount(locker,g);
  let waiting=false;
  for(let i=0;i<100&&!waiting;i++){
   waiting=(await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(waiting,'account confirmation waits on the deletion transaction');
  await db.query('COMMIT');await closing;
  await rpc(db,'account_erasure_scrub_runtime',g.actor);
  report.checks.push('independent session lock returns retry without partial erasure; account-first closes API; deletion-first serializes account confirmation');
  const h=await runtimeFixture(db,{settled:true});
  await erase(db,h,'session',h.session);
  await assert.rejects(db.query(`INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision)
   VALUES($1,$2,$3,'{}',0)`,[h.actor,h.session,randomUUID()]),/CONTENT_ERASED/);
  await assert.rejects(db.query(`INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
   VALUES($1,1,$2,'{}','{}',$3)`,[h.session,randomUUID(),'a'.repeat(64)]),/CONTENT_ERASED/);
  report.checks.push('late runtime execution and material inserts rejected after deletion');
 }finally{await db.query('ROLLBACK');await locker.query('ROLLBACK');await locker.end();}
}
