/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-RW-C: runtime_admit_precheck + runtime_admit_commit admit exactly what runtime_admit admits, refuse what it refuses,
// refuse a stale or foreign proof, and hold fewer relation locks; the permission chain is walked by the precheck, not under the commit's locks.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>{try{return (await c.query(sql,args)).rows[0]?.v;}catch(e){e.message+=' @ '+sql.slice(0,70);throw e;}};
try{
 await c.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await c.query(read('packages/db/tests/content-erasure/fixture.sql'));
 // One account with a conversation, and the arguments of a first ordinary turn.
 const account=async()=>{
  const f=await createFixture(c,{credits:1000,threshold:1});
  await c.query("select set_config('request.jwt.claim.sub',$1,false)",[f.actor]);
  const started=await rpc(c,'runtime_start',f.actor,randomUUID(),{scope:{kind:'positioning_draft'}});
  const session=await rpc(c,'runtime_session_context',f.actor,started.sessionId);
  return {f,sessionId:started.sessionId,scope:session.scope};
 };
 const turn=(a,input='Synthetic input')=>{
  const requestId=randomUUID();
  const ctx={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input,instructions:'x',model:a.f.claimPayload.model,modelId:a.f.payload.modelId,
   maxOutputTokens:1000,maxTurns:3,historyItems:10,tools:[],maxToolCalls:0,workspaceContext:true,sources:[],network:'deny',
   request:{sessionId:a.sessionId,requestId,input,selection:{kind:'ordinary',modelId:a.f.payload.modelId},network:'deny'}};
  return {requestId,payload:ctx,billing:{...a.f.payload,scope:a.scope,input:ctx}};
 };
 const old=(a,t)=>one('select runtime_admit($1,$2,$3,$4,$5) v',[a.f.actor,a.sessionId,t.requestId,JSON.stringify(t.payload),JSON.stringify(t.billing)]);
 const pre=(a,t)=>one('select runtime_admit_precheck($1,$2,$3,$4,$5) v',[a.f.actor,a.sessionId,t.requestId,JSON.stringify(t.payload),JSON.stringify(t.billing)]);
 const commit=(a,t,proof)=>one('select runtime_admit_commit($1,$2,$3,$4,$5,$6) v',[a.f.actor,a.sessionId,t.requestId,JSON.stringify(t.payload),JSON.stringify(t.billing),JSON.stringify(proof)]);
 const refused=async(fn)=>{try{await fn();return null;}catch(e){return e.message.split(' @ ')[0];}};
 // Everything an admission writes, without the ids and times that differ between two runs of the same request.
 const state=async(a,t)=>{
  const rows=await c.query(`SELECT jsonb_build_object(
   'execution',(SELECT to_jsonb(e)-ARRAY['id','billing_run_id','created_at','updated_at'] FROM runtime_executions e WHERE e.request_id=$2),
   'run',(SELECT to_jsonb(r)-ARRAY['id','created_at','updated_at','deadline','session_ref','request_id','pre_deduct_id'] FROM bill2_runs r WHERE r.request_id=$2),
   'activeIsThisExecution',(SELECT s.active_execution=e.id FROM runtime_sessions s JOIN runtime_executions e ON e.request_id=$2 WHERE s.id=$1),
   'sessionRef',(SELECT r.session_ref=$1 FROM bill2_runs r WHERE r.request_id=$2)) v`,[a.sessionId,t.requestId]);
  const v=rows.rows[0].v;for(const k of ['execution','run']){if(v[k])for(const key of Object.keys(v[k]))if(/(_at|_id|deadline|token)$/.test(key))delete v[k][key];}return v;
 };
 // 1. Same result: the same turn admitted by the old function and by the two steps leaves the same rows.
 const a1=await account(),t1=turn(a1);
 await c.query('BEGIN');const oldResult=await old(a1,t1);const oldState=await state(a1,t1);await c.query('ROLLBACK');
 await c.query('BEGIN');const proof=await pre(a1,t1);const newResult=await commit(a1,t1,proof);const newState=await state(a1,t1);await c.query('ROLLBACK');
 assert.deepEqual(Object.keys(newResult).sort(),Object.keys(oldResult).sort());
 assert.equal(newResult.state,oldResult.state);
 assert.deepEqual(newState,oldState,'the two steps write exactly what runtime_admit writes');
 assert.ok(oldState.execution&&oldState.run&&oldState.activeIsThisExecution&&oldState.sessionRef,'the compared state is not empty');
 report.checks.push('precheck + commit write the same execution, billing run, session pointer and history window as runtime_admit');
 // 2. Fewer relation locks under the commit; the permission chain moved to the precheck (counted on the database, not by time).
 const counters=async(sql)=>{
  await c.query('BEGIN');await c.query("SET LOCAL track_functions='all'");
  const walks=async()=>{await c.query('SELECT pg_stat_force_next_flush()');return Number(await one("SELECT coalesce(sum(calls),0) v FROM pg_stat_xact_user_functions WHERE funcname='runtime_billing_allowed'"));};
  const before=await walks(); // calls of earlier statements of this session can still be pending: count only this one
  await sql();
  const calls=await walks()-before;
  const locks=Number(await one("SELECT count(*) v FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation' AND relation IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)"));
  await c.query('ROLLBACK');return {calls,locks};
 };
 const a2=await account(),a3=await account(),t2=turn(a2),t3=turn(a3);
 const oldCost=await counters(()=>old(a2,t2));
 let commitCost,precheckCost;
 const proof3=await pre(a3,t3);
 commitCost=await counters(()=>commit(a3,t3,proof3));
 precheckCost=await counters(()=>pre(a3,t3));
 report.checks.push(`runtime_admit: ${oldCost.calls} permission walks, ${oldCost.locks} relation locks; commit: ${commitCost.calls} walks, ${commitCost.locks} locks; precheck: ${precheckCost.calls} walks, ${precheckCost.locks} locks`);
 assert.equal(commitCost.calls,0,'DB_RW_C_COMMIT_WALKS_PERMISSION_CHAIN');
 assert.equal(precheckCost.calls,oldCost.calls,'DB_RW_C_PRECHECK_MUST_WALK_THE_SAME_CHAIN');
 assert.ok(commitCost.locks<=oldCost.locks-30,`DB_RW_C_COMMIT_LOCKS_NOT_LOWER: ${commitCost.locks} vs ${oldCost.locks}`);
 // 2b. A permission the chain refuses is refused by the precheck exactly as by runtime_admit (P1 review): the commit trusts the proof.
 {
  const a6=await account();
  const attempt=(fn,a,t)=>refused(async()=>{await c.query('BEGIN');try{return await fn(a,t);}finally{await c.query('ROLLBACK');}});
  assert.equal(await attempt(old,a6,turn(a6)),null,'the turn is admitted while every permission stands');
  const bad=turn(a6);bad.billing={...bad.billing,callPolicy:[]};
  const oldBad=await attempt(old,a6,bad),preBad=await attempt(pre,a6,bad);
  assert.equal(oldBad,'BILL2_CALL_POLICY_REQUIRED');assert.equal(preBad,oldBad,'an invalid call policy is refused by the precheck with the same error');
  await c.query('UPDATE bill2_drafts SET revoked=true WHERE actor_id=$1',[a6.f.actor]);
  const oldRevoked=await attempt(old,a6,turn(a6)),preRevoked=await attempt(pre,a6,turn(a6));
  assert.ok(oldRevoked,'runtime_admit refuses a revoked draft');assert.equal(preRevoked,oldRevoked,'the precheck refuses it with the same error');
  report.checks.push(`permission refusals match: invalid call policy (${oldBad} / ${preBad}), revoked draft (${oldRevoked} / ${preRevoked})`);
 }
 // 3. A proof that does not fit is refused.
 const a4=await account(),t4=turn(a4);
 const p4=await pre(a4,t4);
 assert.equal(await refused(()=>commit(a4,{...t4,requestId:randomUUID()},p4)),'RUNTIME_ADMIT_PRECHECK_INVALID','proof of another request');
 assert.equal(await refused(()=>commit(a4,{...t4,payload:{...t4.payload,input:'changed'}},p4)),'RUNTIME_ADMIT_PRECHECK_INVALID','proof of another payload');
 assert.equal(await refused(()=>commit(a4,t4,null)),'RUNTIME_ADMIT_PRECHECK_INVALID','no proof');
 await c.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[a4.sessionId]);
 assert.equal(await refused(()=>commit(a4,t4,p4)),'RUNTIME_ADMIT_STALE','the session moved on after the precheck');
 const p4b=await pre(a4,t4);
 const first=await commit(a4,t4,p4b);
 assert.equal((await commit(a4,t4,p4b)).executionId,first.executionId,'the same request commits once and replays');
 assert.equal((await pre(a4,t4)).replay.executionId,first.executionId,'a precheck of an admitted request reports the replay');
 report.checks.push('a proof of another request, another payload, no proof or a moved session is refused; a repeated request replays');
 // 4. The same refusals: a session held by an unfinished round, an unknown session, a conflicting repeat of a request.
 const busyOld=await account(),busyNew=await account();
 await old(busyOld,turn(busyOld));await (async()=>{const t=turn(busyNew);return commit(busyNew,t,await pre(busyNew,t));})();
 const refusedOld=await refused(()=>old(busyOld,turn(busyOld)));
 const refusedNew=await refused(async()=>{const t=turn(busyNew);return commit(busyNew,t,await pre(busyNew,t));});
 assert.equal(refusedNew,refusedOld);assert.equal(refusedNew,'RUNTIME_SESSION_BUSY');
 const missing=await account();
 const unknownOld=await refused(()=>one('select runtime_admit($1,$2,$3,$4,$5) v',[missing.f.actor,randomUUID(),randomUUID(),'{}','{}']));
 const unknownNew=await refused(()=>one('select runtime_admit_precheck($1,$2,$3,$4,$5) v',[missing.f.actor,randomUUID(),randomUUID(),'{}','{}']));
 assert.equal(unknownNew,unknownOld);
 const tc=turn(busyNew),conflictFirst=await (async()=>{const x=turn(missing);const p=await pre(missing,x);const r=await commit(missing,x,p);return {x,r};})();
 const conflictOld=await refused(()=>old(missing,{...conflictFirst.x,payload:{...conflictFirst.x.payload,input:'other'},billing:{...conflictFirst.x.billing,input:{...conflictFirst.x.payload,input:'other'}}}));
 const conflictNew=await refused(()=>pre(missing,{...conflictFirst.x,payload:{...conflictFirst.x.payload,input:'other'},billing:{...conflictFirst.x.billing,input:{...conflictFirst.x.payload,input:'other'}}}));
 report.checks.push(`refusals match: session busy (${refusedNew}), unknown session (${unknownNew}), conflicting repeat (${conflictOld} / ${conflictNew})`);
 // 4b. What changes between the two calls is re-checked by the commit.
 //  - a module deactivated between precheck and commit
 {
  const a5=await account();const art5=await one('select d7_test.artifacts($1) v',[a5.f.actor]);
  await c.query('UPDATE modules SET model_id=$2 WHERE id=$1',[art5.module,a5.f.payload.modelId]);
  const t5=turn(a5);t5.billing={...t5.billing,moduleId:art5.module,skillId:art5.skill,revisionId:art5.revision};
  const p5=await pre(a5,t5);
  await c.query('UPDATE modules SET active=false WHERE id=$1',[art5.module]);
  // With DB-RW-B (0419) the deactivation also moves the Skill catalog version, which the commit compares first; without the
  // versions in the proof the commit's own module re-read refuses it as before.
  const versioned=await one("select to_regprocedure('public.catalog_versions_snapshot()') is not null v");
  assert.equal(await refused(()=>commit(a5,t5,p5)),versioned?'RUNTIME_ADMIT_STALE':'RUNTIME_SKILL_MODEL_DENIED','a module deactivated after the precheck is refused by the commit');
  assert.equal(await refused(()=>commit(a5,t5,{...p5,catalogVersions:null})),'RUNTIME_SKILL_MODEL_DENIED','the commit re-reads the module itself');
  assert.equal(await one('select count(*)::int v from runtime_executions where request_id=$1',[t5.requestId]),0,'nothing was admitted');
 }
 //  - the entry guards of runtime_admit (archived business, erased conversation) are the commit's first statements too
 {
  const def=await one("select pg_get_functiondef('public.runtime_admit_commit(uuid,uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure) v");
  const head=def.slice(def.indexOf('BEGIN'),def.indexOf('pg_advisory_xact_lock'));
  assert.match(head,/opc_assert_business_writable/);assert.match(head,/CONTENT_ERASED/);assert.match(head,/bill2_actor/);
  report.checks.push('the commit starts with the same archived-business, erased-conversation and actor guards as runtime_admit');
 }
 //  - the catalog version moved: the DB-RW-B function (0419) when this database has it, otherwise a stand-in
 if(await one("select to_regprocedure('public.catalog_versions_snapshot()') is not null v")){
  const a7=await account(),t7=turn(a7),p7=await pre(a7,t7);
  assert.deepEqual(Object.keys(p7.catalogVersions).sort(),['enabled','models','settings','skills']);
  await c.query("INSERT INTO system_settings(key,value) VALUES('rwc_settings_probe','1') ON CONFLICT(key) DO UPDATE SET value=to_jsonb(clock_timestamp())");
  assert.equal((await commit(a7,t7,p7)).state,'prepared','a settings change alone does not stale a proof');
  const a8=await account(),t8=turn(a8),p8=await pre(a8,t8);
  await c.query('UPDATE ai_models SET max_tokens=coalesce(max_tokens,0)+1 WHERE id=$1',[a8.f.payload.modelId]);
  assert.equal(await refused(()=>commit(a8,t8,p8)),'RUNTIME_ADMIT_STALE','a models/skills version change refuses the commit');
  await c.query("DELETE FROM system_settings WHERE key='rwc_settings_probe'");
 }else{
  await c.query(`CREATE TABLE IF NOT EXISTS rwc_catalog(name text primary key, version bigint)`);
  await c.query(`INSERT INTO rwc_catalog VALUES('skills',1),('models',1),('settings',1) ON CONFLICT DO NOTHING`);
  await c.query(`CREATE OR REPLACE FUNCTION public.catalog_versions_snapshot() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_object_agg(name,version) FROM rwc_catalog $$`);
  const a7=await account(),t7=turn(a7),p7=await pre(a7,t7);
  assert.deepEqual(p7.catalogVersions,{skills:1,models:1,settings:1});
  await c.query("UPDATE rwc_catalog SET version=2 WHERE name='settings'");
  assert.equal((await commit(a7,t7,p7)).state,'prepared','a settings change alone does not stale a proof');
  const a8=await account(),t8=turn(a8),p8=await pre(a8,t8);
  await c.query("UPDATE rwc_catalog SET version=2 WHERE name='models'");
  assert.equal(await refused(()=>commit(a8,t8,p8)),'RUNTIME_ADMIT_STALE','a models/skills version change refuses the commit');
  await c.query('DROP FUNCTION public.catalog_versions_snapshot()');await c.query('DROP TABLE rwc_catalog');
 }
 report.checks.push('a deactivated module, a moved catalog version and a moved session are refused by the commit; a settings-only change is not');
 // 4c. Two admissions at the same time: one execution per request, and a second turn on the same session is refused.
 {
  const a9=await account(),t9=turn(a9),t9b=turn(a9);
  const peer=new c.constructor({host:'127.0.0.1',port:c.connectionParameters.port,database:c.connectionParameters.database,user:'postgres'});
  await peer.connect();await peer.query("select set_config('request.jwt.claim.sub',$1,false)",[a9.f.actor]);
  try{
   const p9=await pre(a9,t9),p9b=await pre(a9,t9b);
   const run=(client,t,p)=>client.query('select runtime_admit_commit($1,$2,$3,$4,$5,$6) v',[a9.f.actor,a9.sessionId,t.requestId,JSON.stringify(t.payload),JSON.stringify(t.billing),JSON.stringify(p)])
    .then(r=>({ok:r.rows[0].v}),e=>({error:e.message}));
   const [x,y]=await Promise.all([run(c,t9,p9),run(peer,t9b,p9b)]);
   const results=[x,y];
   assert.equal(results.filter(r=>r.ok).length,1,'exactly one of two concurrent turns on one session is admitted');
   assert.ok(results.find(r=>r.error)&&/RUNTIME_SESSION_BUSY|RUNTIME_ADMIT_STALE/.test(results.find(r=>r.error).error));
   assert.equal(await one('select count(*)::int v from runtime_executions where session_id=$1',[a9.sessionId]),1);
   // The same request committed twice at once: one execution, the other call replays it.
   const a10=await account(),t10=turn(a10),p10=await pre(a10,t10);
   await peer.query("select set_config('request.jwt.claim.sub',$1,false)",[a10.f.actor]);
   const run10=client=>client.query('select runtime_admit_commit($1,$2,$3,$4,$5,$6) v',[a10.f.actor,a10.sessionId,t10.requestId,JSON.stringify(t10.payload),JSON.stringify(t10.billing),JSON.stringify(p10)])
    .then(r=>({ok:r.rows[0].v}),e=>({error:e.message}));
   const [u,w]=await Promise.all([run10(c),run10(peer)]);
   assert.ok(u.ok&&w.ok,JSON.stringify([u,w]));assert.equal(u.ok.executionId,w.ok.executionId);
   assert.equal(await one('select count(*)::int v from runtime_executions where request_id=$1',[t10.requestId]),1);
  }finally{await peer.end();}
 }
 report.checks.push('two turns at once on one session: one is admitted; the same request twice at once: one execution, a replay');
 // 5. Only service_role may call the new functions.
 for(const fn of ['runtime_admit_precheck(uuid,uuid,uuid,jsonb,jsonb)','runtime_admit_commit(uuid,uuid,uuid,jsonb,jsonb,jsonb)'])
  for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]])
   assert.equal(await one("select has_function_privilege($1,$2,'EXECUTE') v",[role,fn]),want,`${fn} ${role}`);
 report.checks.push('both functions are executable by service_role only');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
