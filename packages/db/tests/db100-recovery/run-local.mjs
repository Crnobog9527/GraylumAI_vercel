/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-100 line W (0383): the recovery and reconciliation jobs read only the open rounds. With 40000 settled
// rounds plus 160 open ones in every state the jobs look at, runtime_stale_charged_rounds,
// runtime_pending_financial_batch and runtime_interrupted_recovery must return exactly what they returned
// before 0383 (indexes dropped, 0379 interrupted definition) and read clearly fewer pages.
// Run: node packages/db/tests/db100-recovery/run-local.mjs --local-only
import assert from 'node:assert/strict';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
const database=await localDb(),db=database.client;
const migration=read('packages/db/migrations/0383_db100_recovery_index_scans.sql');
const legacy=read('packages/db/migrations/0379_runtime_never_begun_recovery.sql');
const indexes=['bill2_runs_recovery_open','runtime_executions_open_created','runtime_sessions_active_execution'];
const calls={
 stale:'runtime_stale_charged_rounds(now()-interval \'24 hours\',500+0*g,NULL)',
 pending:'runtime_pending_financial_batch(NULL,20+0*g)',
 interrupted:'runtime_interrupted_recovery(NULL,NULL,NULL,20+0*g)',
};
const report={checks:[],failed:null};
try{
 await db.query('SET session_replication_role=replica');
 await db.query(read('packages/db/tests/db100-recovery/seed.sql'));
 await db.query('RESET session_replication_role');
 await db.query('ANALYZE');
 // One session, 5 calls: the plan is cached the way the long-lived pooled backend caches it.
 async function measure(name){
  const result=(await db.query(`SELECT ${calls[name].replace(/\+0\*g/g,'')} r`)).rows[0].r;
  const plan=(await db.query(`EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) SELECT sum(length(x.r::text)) FROM (SELECT ${calls[name]} r FROM generate_series(1,5) g) x`)).rows[0]['QUERY PLAN'][0].Plan;
  return {result,pages:(plan['Shared Hit Blocks']+plan['Shared Read Blocks'])/5};
 }
 const run=async()=>Object.fromEntries(await Promise.all(Object.keys(calls).map(async name=>[name,await measure(name)])));
 const dropIndexes=()=>db.query(indexes.map(name=>`DROP INDEX IF EXISTS public.${name}`).join(';')+';ANALYZE');
 // Before 0383: no new indexes, the 0379 interrupted definition. Measured one function at a time.
 await db.query(legacy);await dropIndexes();
 const before={};for(const name of Object.keys(calls))before[name]=await measure(name);
 await db.query(migration);await db.query('ANALYZE');
 const after={};for(const name of Object.keys(calls))after[name]=await measure(name);
 for(const name of Object.keys(calls)){
  assert.ok(Array.isArray(before[name].result)||before[name].result?.rounds,`${name}: the fixture lists open rounds`);
  const listed=Array.isArray(before[name].result)?before[name].result.length:before[name].result.total;
  assert.ok(listed>0,`${name}: nothing listed, the fixture proves nothing`);
  assert.deepEqual(after[name].result,before[name].result,`${name}: result changed`);
  assert.ok(after[name].pages<before[name].pages*0.8,`${name}: pages ${after[name].pages} not below 80% of ${before[name].pages}`);
  report.checks.push(`${name}: same result (${listed} listed), pages per call ${Math.round(before[name].pages)} -> ${Math.round(after[name].pages)}`);
 }
 // C7: with 80000 tool calls the per-execution lookups use the primary key and the own-post scan its partial
 // index; no extra index is needed (the 138-row staging table is read by seq scan because it is one page).
 const planOf=async sql=>JSON.stringify((await db.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN']);
 const execution=(await db.query('SELECT id FROM runtime_executions OFFSET 777 LIMIT 1')).rows[0].id;
 for(const [label,sql,index] of [
  ['count per execution',`SELECT count(*) FROM runtime_tool_calls WHERE execution_id='${execution}'`,'runtime_tool_calls_pkey'],
  ['search presence',`SELECT 1 FROM runtime_tool_calls WHERE execution_id='${execution}' AND name='search' AND result IS NOT NULL`,'runtime_tool_calls_pkey'],
  ['own-post scan',`SELECT execution_id FROM runtime_tool_calls t WHERE t.result->>'kind'='my_posts'`,'runtime_tool_calls_my_posts'],
 ]){
  assert.ok((await planOf(sql)).includes(index),`runtime_tool_calls ${label} does not use ${index}`);
  report.checks.push(`runtime_tool_calls ${label}: uses ${index}`);
 }
 // The migration is repeatable.
 await db.query(migration);
 report.checks.push('0383 applies twice');
}catch(error){report.failed=String(error?.stack||error).slice(0,3000);process.exitCode=1;}
finally{console.log(JSON.stringify(report,null,1));await database.close();}
