/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0321: per-session execution reads use the new index. Run: node packages/db/tests/runtime-session-index/run-local.mjs --local-only
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
const database=await localDb(),db=database.client;
const migration=read('packages/db/migrations/0321_runtime_executions_session_index.sql');
const report={checks:[],failed:null};
try{
 const plan=async sql=>(await db.query('EXPLAIN (FORMAT JSON) '+sql,[randomUUID()])).rows[0]['QUERY PLAN'][0].Plan;
 const names=node=>[node['Index Name'],...(node.Plans??[]).flatMap(names)].filter(Boolean);
 await db.query('BEGIN');
 try{
  await db.query('SET LOCAL enable_seqscan=off');
  for(const sql of ['SELECT id FROM runtime_executions WHERE session_id=$1',
   'SELECT id,payload FROM runtime_executions WHERE session_id=$1 ORDER BY created_at,id LIMIT 1',
   'SELECT max(created_at) FROM runtime_executions WHERE session_id=$1'])
   assert.ok(names(await plan(sql)).includes('runtime_executions_session_created_idx'),sql);
 }finally{await db.query('ROLLBACK');}
 report.checks.push('session_id filters and created_at ordering use runtime_executions_session_created_idx');
 const index="SELECT indexdef FROM pg_indexes WHERE indexname='runtime_executions_session_created_idx'";
 const before=(await db.query(index)).rows;
 await db.query(migration);await db.query(migration);
 assert.deepEqual((await db.query(index)).rows,before);assert.equal(before.length,1);
 report.checks.push('migration repeatable without change');
}catch(error){report.failed=String(error)+"\n"+error.stack;process.exitCode=1;}
finally{await database.close();console.log(JSON.stringify(report,null,2));}
