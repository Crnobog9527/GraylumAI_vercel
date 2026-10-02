/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {localDb,read,root} from './local-db.mjs';
const db=await localDb();const c=db.client;
const migration=read('packages/db/migrations/0158_runtime_view_perf.sql');
const rollback=read('packages/db/tests/runtime-view-perf/rollback.sql');
const report={checks:[],failed:null};
try {
 await c.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 const f=(await c.query('select runtime_perf_test.seed(8) f')).rows[0].f;
 const other=(await c.query('select runtime_perf_test.seed(2) f')).rows[0].f;
 const ids=(await c.query('select id from runtime_executions where session_id=$1 order by created_at',[f.session])).rows.map(r=>r.id);
 const roots=[...ids,other.execution,'00000000-0000-0000-0000-000000000000'];
 const changes={
  dense:async()=>{},
  diamond:async()=>{
   await c.query('delete from runtime_history_dependencies where execution_id=ANY($1::uuid[])',[ids]);
   for(const [i,j] of [[7,6],[7,5],[6,0],[5,0]]) await c.query('insert into runtime_history_dependencies values($1,$2)',[ids[i],ids[j]]);
  },
  cycle:()=>c.query('insert into runtime_history_dependencies values($1,$2)',[ids[0],ids[7]]),
  foreign:()=>c.query('insert into runtime_history_dependencies values($1,$2)',[ids[7],other.execution]),
  missingAncestorRun:()=>c.query('update runtime_executions set billing_run_id=NULL where id=$1',[ids[1]]),
  missingRootRun:()=>c.query('update runtime_executions set billing_run_id=NULL where id=$1',[ids[7]]),
  deniedAncestor:()=>c.query("update runtime_executions set unavailable_reason='revoked' where id=$1",[ids[0]]),
 };
 for(const [name,change] of Object.entries(changes)) {
  await c.query('BEGIN');try{
   await change();
   const expected=(await c.query('select id execution_id,runtime_history_available(id) available from unnest($1::uuid[]) id order by id',[roots])).rows;
   const actual=(await c.query('select * from runtime_history_availability($1) order by execution_id',[roots])).rows;
   assert.deepEqual(actual,expected,name);
  }finally{await c.query('ROLLBACK');}
  report.checks.push('batch equals scalar oracle: '+name);
 }
 const freeze=async()=>{
  const results=[];
  for(const mode of ['valid','duplicate','outside','revoked','repeat']) {
   await c.query('BEGIN');
   try {
    const e=(await c.query('select runtime_admit($1,$2,gen_random_uuid(),$3,$4) v',[f.actor,f.session,f.payload,f.billing])).rows[0].v;
    if(mode==='revoked') await c.query("update runtime_executions set unavailable_reason='revoked' where id=$1",[ids[0]]);
    const selected=mode==='duplicate'?[1,1]:mode==='outside'?[99999]:[1,2,3];
    await c.query('SAVEPOINT perf_freeze');
    try {
     const result=(await c.query("select runtime_session_items($1,$2,$3,'freeze',$4)::text v",[f.actor,f.session,e.executionId,JSON.stringify(selected)])).rows[0].v;
     if(mode==='repeat')assert.equal((await c.query("select runtime_session_items($1,$2,$3,'freeze',$4)::text v",[f.actor,f.session,e.executionId,JSON.stringify(selected)])).rows[0].v,result);
     const deps=(await c.query('select dependency_id from runtime_history_dependencies where execution_id=$1 order by dependency_id',[e.executionId])).rows;
     results.push({mode,result,deps});
    }catch(error){await c.query('ROLLBACK TO SAVEPOINT perf_freeze');results.push({mode,code:error.code,message:error.message});}
   }finally{await c.query('ROLLBACK');}
  }
  return results;
 };
 const after=await freeze();await c.query(rollback);const before=await freeze();assert.deepEqual(after,before);
 assert.ok(after.filter(x=>['duplicate','outside','revoked'].includes(x.mode)).every(x=>x.message==='RUNTIME_HISTORY_SELECTION'));
 assert.ok(after.filter(x=>['valid','repeat'].includes(x.mode)).every(x=>x.result==='[1, 2, 3]'));
 await c.query(migration);
 report.checks.push('freeze valid/repeat/duplicate/outside/revoked results and dependencies match original');
 const snapshot=async()=>(await c.query(`select jsonb_build_object('view',runtime_view($1,$2),'executions',
  (select count(*) from runtime_executions),'history',(select count(*) from runtime_session_history),
  'runs',(select count(*) from bill2_runs),'ledger',(select count(*) from credit_transactions))::text v`,[f.actor,f.session])).rows[0].v;
 const precheck=await c.query(read('packages/db/tests/runtime-view-perf/precheck.sql'));
 assert.ok(precheck[1].rows.every(r=>r.source_matches===true));
 const state=await snapshot();await c.query(rollback);await c.query(rollback);assert.equal(await snapshot(),state);await c.query(migration);assert.equal(await snapshot(),state);
 report.checks.push('populated rollback/reapply preserves exact view and execution/history/run/ledger counts');
 const {Client}=createRequire(root+'/package.json')('pg');
 const writer=new Client({host:'127.0.0.1',port:c.connectionParameters.port,user:'postgres',database:'perf'});
 await writer.connect();
 try {
  await c.query('BEGIN');await c.query('select runtime_view($1,$2)',[f.actor,f.session]);
  await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
  await assert.rejects(writer.query("update ai_models set is_active='false' where id=$1",[f.model]),e=>e.code==='55P03');
  await writer.query('ROLLBACK');await c.query('COMMIT');
  await writer.query("update ai_models set is_active='false' where id=$1",[f.model]);
  const denied=(await c.query('select runtime_view($1,$2) v',[f.actor,f.session])).rows[0].v;
  assert.ok(denied.executions.every(e=>e.contentAvailable===false&&e.body===null));
  await writer.query("update ai_models set is_active='true' where id=$1",[f.model]);
  report.checks.push('successful batch retains permission SHARE locks; next statement sees committed model revocation');
 }finally{await c.query('ROLLBACK');await writer.end();}

}catch(e){report.failed=String(e.stack??e);process.exitCode=1;console.error(report.failed);}
finally{await db.close();report.cleanup='PASS';writeFileSync(root+'/docs/validation/runtime-view-perf/extra-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
