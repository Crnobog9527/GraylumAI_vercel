/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {fixture,closeAccount} from '../erasure-b2a/cases.mjs';
import {insertUsage,row,scrub} from './cases.mjs';

export async function runConcurrency({db,Client,connectionString,report}){
 const f=await fixture(db);
 const busy='00000000-0000-4000-8000-000000000011',ready='00000000-0000-4000-8000-000000000012';
 await insertUsage(db,f.actor,busy);await insertUsage(db,f.actor,ready);await closeAccount(db,f);
 const locker=new Client({connectionString});await locker.connect();
 try{
  assert.notEqual((await locker.query('SELECT pg_backend_pid() id')).rows[0].id,
   (await db.query('SELECT pg_backend_pid() id')).rows[0].id);
  await locker.query('BEGIN');await locker.query('SELECT id FROM ai_usage_logs WHERE id=$1 FOR UPDATE',[busy]);
  await db.query("SET statement_timeout='2s'");
  const first=await scrub(db,f.actor,'ai_usage_logs',1);
  assert.deepEqual(first,{processed:1,remaining:1,manualReview:0,nextRowId:ready});
  assert.equal((await row(db,'ai_usage_logs',busy)).content_erased_at,null);
  const tail=await scrub(db,f.actor,'ai_usage_logs',1,first.nextRowId);
  assert.equal(tail.processed,0);assert.equal(tail.remaining,1);assert.equal(tail.nextRowId,null);
  await locker.query('COMMIT');
  const retry=await scrub(db,f.actor,'ai_usage_logs',1);
  assert.equal(retry.processed,1);assert.equal(retry.remaining,0);
  assert.ok((await row(db,'ai_usage_logs',busy)).content_erased_at);
  report.checks.push('real independent row lock skipped within timeout; cursor reports remaining busy row; fresh pass clears after unlock');
 }finally{
  await db.query('RESET statement_timeout');await locker.query('ROLLBACK');await locker.end();
 }
}
