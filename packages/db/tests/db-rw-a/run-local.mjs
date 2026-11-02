/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-RW-A (0416), behind the switch runtime_rw_v2.sharedRowLocks: with the switch off (the default) the turn path row-locks the
// model, module, skill, skill revision and start-threshold rows exactly as before; with it on none of them is locked, an
// administrator is not made to wait for an open turn, and a module that was deactivated is still refused. Counted on the
// database itself, not by time.
import assert from 'node:assert/strict';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,claim} from '../payg/fixture.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>{try{return (await c.query(sql,args)).rows[0]?.v;}catch(e){e.message+=' @ '+sql.slice(0,70);throw e;}};
// Rows of these tables locked by the open transaction (a row lock by one transaction leaves its id in xmax; aborted earlier lockers are not counted).
const locked=async()=>one(`SELECT jsonb_build_object('ai_models',(SELECT count(*) FROM ai_models WHERE xmax::text=txid_current()::text),
  'modules',(SELECT count(*) FROM modules WHERE xmax::text=txid_current()::text),'skills',(SELECT count(*) FROM skills WHERE xmax::text=txid_current()::text),
  'skill_revisions',(SELECT count(*) FROM skill_revisions WHERE xmax::text=txid_current()::text),
  'thresholds',(SELECT count(*) FROM system_settings WHERE key='billing_payg_start_thresholds' AND xmax::text=txid_current()::text)) v`);
const setSwitch=async on=>c.query(`INSERT INTO system_settings(key,value) VALUES('runtime_rw_v2',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  [JSON.stringify(on===null?{}:{sharedRowLocks:on})]);
try{
 await c.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 await c.query(read('packages/db/tests/content-erasure/fixture.sql'));
 const f=await one('select runtime_perf_test.seed($1,false) v',[120]);
 // The same session now selects a published Skill revision, so the admission takes the module/skill checks too.
 const art=await one('select d7_test.artifacts($1) v',[f.actor]);
 await c.query('UPDATE modules SET model_id=$2 WHERE id=$1',[art.module,f.model]);
 const billing={...f.billing,moduleId:art.module,skillId:art.skill,revisionId:art.revision};
 await c.query("select set_config('request.jwt.claim.sub',$1,false)",[f.actor]);
 await c.query('ANALYZE');
 const pf=await createFixture(c,{credits:1000,threshold:1});
 const admitOpen=async()=>{ // an admission left open, and the shared rows it holds
  await c.query('BEGIN');
  let error=null;
  try{await one('select runtime_admit($1,$2,gen_random_uuid(),$3,$4) v',[f.actor,f.session,f.payload,billing]);}catch(e){error=e.message;}
  return {error,rows:await locked()};
 };
 const claimOpen=async()=>{await c.query('BEGIN');await claim(c,pf);return locked();};
 const peerUpdates=async()=>{
  const peer=new c.constructor({host:'127.0.0.1',port:c.connectionParameters.port,database:c.connectionParameters.database,user:'postgres'});
  await peer.connect();
  try{
   await peer.query("SET lock_timeout='1500ms'");
   await peer.query('UPDATE modules SET title=title WHERE id=$1',[art.module]);
   await peer.query('UPDATE skills SET status=status WHERE id=$1',[art.skill]);
   await peer.query('UPDATE ai_models SET name=name WHERE id=$1',[f.model]);
   return 'not waiting';
  }catch(e){return /lock timeout/.test(e.message)?'waits for the turn':e.message;}
  finally{await peer.end();}
 };
 for(const mode of [null,false,true]) {
  await setSwitch(mode);
  const open=await admitOpen();
  const waiting=await peerUpdates();
  await c.query('ROLLBACK');
  const claimRows=await claimOpen();await c.query('ROLLBACK');
  report.checks.push(`switch ${mode===null?'absent':mode}: runtime_admit (${open.error??'ok'}) row locks ${JSON.stringify(open.rows)}; bill2_payg_claim row locks ${JSON.stringify(claimRows)}; an administrator updating those rows ${waiting}`);
  assert.equal(open.error,null);
  if(mode===true) {
   for(const [table,n] of Object.entries(open.rows))assert.equal(n,0,`ROW_LOCK_ON_SHARED_ROW ${table} (admit, switch on)`);
   for(const [table,n] of Object.entries(claimRows))assert.equal(n,0,`ROW_LOCK_ON_SHARED_ROW ${table} (claim, switch on)`);
   assert.equal(waiting,'not waiting');
  } else {
   // Off (or absent): the locks of today, and the administrator waits.
   assert.equal(open.rows.modules,1);assert.equal(open.rows.skills,1);assert.equal(open.rows.skill_revisions,1);
   assert.equal(claimRows.ai_models,1);assert.equal(claimRows.thresholds,1);
   assert.equal(waiting,'waits for the turn');
  }
  // Either way a deactivated module is refused by a new admission.
  await c.query('UPDATE modules SET active=false WHERE id=$1',[art.module]);
  await assert.rejects(one('select runtime_admit($1,$2,gen_random_uuid(),$3,$4) v',[f.actor,f.session,f.payload,billing]),/RUNTIME_SKILL_MODEL_DENIED/);
  await c.query('UPDATE modules SET active=true WHERE id=$1',[art.module]);
 }
 report.checks.push('with the switch off or absent the locks and the waiting are unchanged; on, none is taken; in every mode a deactivated module is refused');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
