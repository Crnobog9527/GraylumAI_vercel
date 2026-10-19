/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CRON-IDLE-COST (0317): runtime_pending_financial_batch must not run the billing-permission chain
// (runtime_history_available) for runs that were not stopped by the user, and must return exactly
// the same inventory as before. Run: node packages/db/tests/cron-idle-cost/run-local.mjs --local-only
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
const database=await localDb(),db=database.client;
const migration=read('packages/db/migrations/0317_runtime_recovery_inventory_null_guard.sql');
const sig='public.runtime_pending_financial_batch(uuid,integer)';
const fixed=`r.paused_reason IS NOT DISTINCT FROM 'user_stop' AND NOT r.cancel_requested AND e.result IS NULL AND runtime_history_available`;
const legacy=`r.paused_reason='user_stop' AND NOT r.cancel_requested AND e.result IS NULL AND runtime_history_available`;
const report={checks:[],failed:null};
try{
 await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 async function setup(fixtureOptions={}){
  const f=await createFixture(db,fixtureOptions);
  const session=await rpc(db,'runtime_start',f.actor,randomUUID(),{scope:f.payload.scope});
  const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'input',instructions:'Answer',
   model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:1,historyItems:0,
   tools:[],network:'deny',nativeOutput:'native-output-v1',providerRequestFormat:'agent-turn-v5-stream'};
  const admission=await rpc(db,'runtime_admit',f.actor,session.sessionId,randomUUID(),context,{...f.payload,operation:'question',input:context});
  const begin=await rpc(db,'runtime_execution',f.actor,admission.executionId,'begin',null);
  return {...f,run:admission.runId,execution:admission.executionId,session:session.sessionId,epoch:begin.epoch};
 }
 const action=(f,name,value)=>rpc(db,'runtime_execution',f.actor,f.execution,name,value);
 const definition=async()=>(await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d;
 // Inventory plus the number of runtime_history_available calls made by that one batch call.
 async function inventory(actor){
  await db.query('BEGIN');
  try{
   // Pending (unflushed) function stats can include earlier transactions, so count the delta around this call.
   const count=async()=>(await db.query("SELECT coalesce(pg_stat_get_xact_function_calls('public.runtime_history_available(uuid)'::regprocedure),0)::int n")).rows[0].n;
   const start=await count();
   const batch=await rpc(db,'runtime_pending_financial_batch',actor,20);
   return {batch,calls:await count()-start};
  }finally{await db.query('ROLLBACK');}
 }
 const fixedSource=await definition();
 assert.equal(fixedSource.split(fixed).length,3);assert.equal(fixedSource.includes(legacy),false);
 const legacySource=fixedSource.replaceAll(fixed,legacy);

 // Ordinary open runs (paused_reason NULL): one listed (dispatched call with a pending lookup), one not listed.
 const listed=await setup({lookupSupported:true});
 const listedCall=await claim(db,listed);
 await rpc(db,'bill2_record',listed.actor,listed.run,listedCall.id,{
  provider:listed.claimPayload.provider,account:'sandbox',model:listed.claimPayload.model,
  protocol:listed.claimPayload.protocol,providerId:'generation-'+listedCall.id,source:'response',
  sourceHash:'e'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:false,cost:null,currency:'USD'});
 const idle=await setup();
 // A user-stopped run with a settled receipt: listed with userStop true (the guarded branch still runs).
 const stopped=await setup();const stoppedCall=await claim(db,stopped);
 await receipt(db,stopped,stoppedCall);await rpc(db,'bill2_finalize',stopped.actor,stopped.run);
 assert.equal((await action(stopped,'stop',{stopAt:2,source:'assistant'})).state,'stopped_pending_result');
 const paused=r=>db.query('SELECT paused_reason FROM bill2_runs WHERE id=$1',[r]).then(x=>x.rows[0].paused_reason);
 assert.equal(await paused(listed.run),null);assert.equal(await paused(idle.run),null);assert.equal(await paused(stopped.run),'user_stop');

 // Red: the pre-0317 source evaluates the history chain for ordinary runs.
 await db.query(legacySource);
 const before={all:await inventory(null),listed:await inventory(listed.actor),idle:await inventory(idle.actor),stopped:await inventory(stopped.actor)};
 assert.ok(before.listed.calls>0,'legacy guard should reach runtime_history_available for a NULL paused_reason');
 assert.ok(before.idle.calls>0,'legacy guard should reach runtime_history_available for a NULL paused_reason');
 report.checks.push(`legacy source calls runtime_history_available for ordinary runs (listed ${before.listed.calls}, idle ${before.idle.calls})`);

 // Green: same inventory, no history check for ordinary runs, user_stop still evaluated.
 await db.query(migration);
 assert.equal(await definition(),fixedSource);
 const after={all:await inventory(null),listed:await inventory(listed.actor),idle:await inventory(idle.actor),stopped:await inventory(stopped.actor)};
 for(const key of Object.keys(before)) assert.deepEqual(after[key].batch,before[key].batch,key);
 assert.equal(after.listed.calls,0);assert.equal(after.idle.calls,0);
 assert.ok(after.stopped.calls>0);
 const ordinaryEntry=after.listed.batch.find(item=>item.executionId===listed.execution);
 assert.equal(ordinaryEntry.userStop,false);
 assert.equal(after.idle.batch.find(item=>item.executionId===idle.execution),undefined);
 assert.equal(after.stopped.batch.find(item=>item.executionId===stopped.execution).userStop,true);
 assert.ok(after.all.calls<before.all.calls);
 report.checks.push('0317 keeps every inventory identical (all actors, listed, idle, user_stop); ordinary runs make 0 history calls; user_stop still evaluated');

 await db.query(migration);await db.query(migration);
 assert.equal(await definition(),fixedSource);
 await db.query(legacySource.replace('BEGIN','BEGIN\n -- synthetic source drift').replace(legacy,legacy.replace(' AND NOT',' AND  NOT')));
 await db.query('BEGIN');
 await assert.rejects(db.query(migration),/RUNTIME_RECOVERY_INVENTORY_SOURCE_MISMATCH/);await db.query('ROLLBACK');
 report.checks.push('migration repeatable without change; drifted source rejected');
}catch(error){report.failed=String(error)+"\n"+error.stack;process.exitCode=1;}
finally{await database.close();console.log(JSON.stringify(report,null,2));}
