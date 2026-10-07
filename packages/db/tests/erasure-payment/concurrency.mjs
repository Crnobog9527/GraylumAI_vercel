/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {fresh,subscription,close,scrub,row,CANARY} from './cases.mjs';
export async function runConcurrency({db,Client,connectionString,report}){
 const f=await fresh(db),busy='00000000-0000-4000-8000-000000000041',ready='00000000-0000-4000-8000-000000000042';
 await subscription(db,f,{body:CANARY},busy);await subscription(db,f,{body:CANARY},ready);await close(db,f);
 const locker=new Client({connectionString});await locker.connect();
 try{
  assert.notEqual((await db.query('SELECT pg_backend_pid() p')).rows[0].p,(await locker.query('SELECT pg_backend_pid() p')).rows[0].p);
  await locker.query('BEGIN');await locker.query('SELECT id FROM user_subscriptions WHERE id=$1 FOR UPDATE',[busy]);
  await db.query("SET statement_timeout='2s'");
  assert.deepEqual(await scrub(db,f.user,'user_subscriptions',1),{processed:1,remaining:1,manualReview:0,nextRowId:ready});
  assert.equal((await row(db,'user_subscriptions',busy)).metadata_scrubbed_at,null);
  const tail=await scrub(db,f.user,'user_subscriptions',1,ready);assert.equal(tail.processed,0);assert.equal(tail.remaining,1);
  await locker.query('COMMIT');assert.equal((await scrub(db,f.user,'user_subscriptions')).remaining,0);
  report.checks.push('real separate-backend lock skips busy subscription, retains pending count and completes fresh pass after unlock');
 }finally{await db.query('RESET statement_timeout');await locker.query('ROLLBACK');await locker.end();}
}
