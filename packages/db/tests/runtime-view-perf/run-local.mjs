/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {localDb,read,root} from './local-db.mjs';
import {observations} from './cases.mjs';
const db=await localDb();const {client:c}=db;
const migration=read('packages/db/migrations/0158_runtime_view_perf.sql');
const rollback=read('packages/db/tests/runtime-view-perf/rollback.sql');
const fp=read('packages/db/tests/baseline/fingerprint.sql');
const catalogSql=fp.slice(0,fp.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) value FROM grouped;';
const catalog=async()=>(await c.query(catalogSql)).rows[0].value;
const digest=s=>createHash('sha256').update(s).digest('hex');
const report={build:db.build,checks:[],samples:[],failed:null};
const save=()=>writeFileSync(root+'/docs/validation/runtime-view-perf/result.json',JSON.stringify(report,null,2)+'\n');
try {
 const optimized=await catalog();await c.query(migration);assert.deepEqual(await catalog(),optimized);
 await c.query(rollback);const original=await catalog();
 const source=JSON.parse(read('packages/db/tests/runtime-view-perf/source-md5.json'));
 for(const [sig,md5] of Object.entries(source)) {
  assert.equal((await c.query('select md5(pg_get_functiondef($1::regprocedure)) v',[sig])).rows[0].v,md5);
 }
 report.checks.push('original source MD5; repeat migration identical catalog; rollback restores originals');
 // Every original function and the new helper are drift-guarded atomically.
 for(const sig of [...Object.keys(source),'runtime_history_availability(uuid[])']) {
  await c.query(migration);
  await c.query('BEGIN');
  await c.query(`ALTER FUNCTION ${sig} COST 101`);
  const drift=await catalog();await c.query('COMMIT');
  await assert.rejects(c.query(migration),/RUNTIME_VIEW_PERF_SOURCE_MISMATCH/);await c.query('ROLLBACK');
  assert.deepEqual(await catalog(),drift);
  await c.query(`ALTER FUNCTION ${sig} COST 100`);
  assert.deepEqual(await catalog(),optimized);
 }
 report.checks.push('all five function drift guards refuse atomically');
 await c.query(rollback);assert.deepEqual(await catalog(),original);
 await c.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 const fixtures=[];
 for(const n of [15,50,100,300]) {
  const f=(await c.query('select runtime_perf_test.seed($1) f',[n])).rows[0].f;
  fixtures.push({n,f});
 }
 const security=(await c.query('select runtime_perf_test.seed(4,true) f')).rows[0].f;
 security.otherActor=fixtures[0].f.actor;
 await c.query('ANALYZE');
 const beforeCases=await observations(c,security);
 report.checks.push('baseline permission scenarios recorded, including material revocation');save();
 // Store only hashes/sizes in evidence, never synthetic private bodies or local identities.
 for(const fixture of fixtures) {
  const {n,f}=fixture;const started=performance.now();
  fixture.before=(await c.query('select runtime_view($1,$2)::text value',[f.actor,f.session])).rows[0].value;
  fixture.beforeMs=performance.now()-started;
  console.log('baseline byte snapshot',n,Math.round(fixture.beforeMs));
 }
 await c.query(migration);
 assert.deepEqual(await observations(c,security),beforeCases,'allow/deny/error/limit/null outputs unchanged');
 report.checks.push('byte-identical permission, limit and malformed-scope observations');
 for(const {n,f,before,beforeMs} of fixtures) {
  const after=(await c.query('select runtime_view($1,$2)::text value',[f.actor,f.session])).rows[0].value;
  assert.equal(after,before,'runtime_view byte equivalence '+n);
  console.log('byte-identical',n);
  const sample={executions:n,history:n*5,viewBytes:Buffer.byteLength(after),viewSha256:digest(after),byteIdentical:true,
   beforeViewWallMs:beforeMs,timings:{},plans:{}};
  const queries={
   context:['select runtime_context_allowed($1,$2)',[f.actor,f.payload]],
   direct:['select runtime_direct_billing_allowed($1,$2,$3)',[f.actor,f.billing,f.run]],
   billing:['select runtime_billing_allowed($1,$2,$3)',[f.actor,f.billing,f.run]],
   available:['select runtime_history_available($1)',[f.execution]],
   view:['select runtime_view($1,$2)',[f.actor,f.session]],
   items:["select runtime_session_items($1,$2,$3,'read')",[f.actor,f.session,f.execution]],
   admit:['select runtime_admit($1,$2,gen_random_uuid(),$3,$4)',[f.actor,f.session,f.payload,f.billing]],
  };
  for(const [name,[sql,args]] of Object.entries(queries)) {
   const times=[];
   for(let i=0;i<3;i++) {
    await c.query('BEGIN');
    const initialCalls=Number((await c.query("select calls from pg_stat_xact_user_functions where funcname='runtime_direct_billing_allowed'")).rows[0]?.calls??0);
    const plan=(await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,args)).rows[0]['QUERY PLAN'];
    times.push(plan[0]['Execution Time']);
    if(i===0)sample.plans[name]=plan;
    if(name==='view') {
     const count=(await c.query("select calls::int from pg_stat_xact_user_functions where funcname='runtime_direct_billing_allowed'")).rows[0]?.calls;
     assert.equal(count-initialCalls,n,'exactly one direct permission check per distinct execution');
    }
    await c.query('ROLLBACK');
   }
   sample.timings[name]={runsMs:times,maxMs:Math.max(...times)};
   if(n<=100&&['view','items'].includes(name))assert.ok(Math.max(...times)<1000,`${n} ${name} must be <1s`);
  }
  report.samples.push(sample);console.log('PASS',n,JSON.stringify(sample.timings));save();
 }
 // The helper is an internal implementation detail, never a client/service RPC.
 for(const role of ['anon','authenticated','service_role']) {
  assert.equal((await c.query("select has_function_privilege($1,'runtime_history_availability(uuid[])','EXECUTE') v",[role])).rows[0].v,false);
 }
 report.checks.push('internal helper has no anon/authenticated/service_role execute grant');
 // Storage/transaction errors must escape, while exactly the original denial classes return false.
 for(const code of ['P0001','42501','40001','XX000']) {
  await c.query('BEGIN');
  try {
   await c.query(`CREATE OR REPLACE FUNCTION runtime_direct_billing_allowed(a uuid,p jsonb,p_run_id uuid)
    RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'probe' USING ERRCODE='${code}';END $$`);
   const f=security;
   if(['P0001','42501'].includes(code)) {
    const rows=(await c.query('select * from runtime_history_availability(ARRAY[$1::uuid])',[f.execution])).rows;
    assert.equal(rows[0].available,false);
   }else await assert.rejects(c.query('select * from runtime_history_availability(ARRAY[$1::uuid])',[f.execution]),e=>e.code===code);
  }finally{await c.query('ROLLBACK');}
 }
 report.checks.push('permission errors exclude; serialization/internal errors propagate unchanged');
 await c.query(rollback);await c.query(migration);
 report.checks.push('populated-data rollback and reapply preserve output and rows');
}catch(e){report.failed=String(e.stack??e);process.exitCode=1;console.error(report.failed);}
finally{await db.close();report.cleanup='PASS';save();}
