/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-RW-A (0416): the per-turn path takes no row lock on the rows every user shares (model, module, skill, skill revision, start-threshold setting). Counted on the database itself, not by time.
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
 // 1. runtime_admit: shared catalog rows locked by the open admission.
 await c.query('BEGIN');
 let admitError=null;
 try{await one('select runtime_admit($1,$2,gen_random_uuid(),$3,$4) v',[f.actor,f.session,f.payload,billing]);}
 catch(e){admitError=e.message;}
 const rows=await locked();
 const relLocks=await one("SELECT jsonb_build_object('relation',count(*) FILTER (WHERE locktype='relation'),'nonFastPath',count(*) FILTER (WHERE locktype='relation' AND NOT fastpath)) v FROM pg_locks WHERE pid=pg_backend_pid()");
 await c.query('ROLLBACK');
 // Recorded for the next steps of DB-RW (the admission split must lower it); not asserted here.
 report.checks.push(`runtime_admit (${admitError??'ok'}): row locks on shared rows ${JSON.stringify(rows)}; relation locks held at the end of the admission ${JSON.stringify(relLocks)}`);
 // 2. bill2_payg_claim: the start-threshold setting row.
 const pf=await createFixture(c,{credits:1000,threshold:1});
 await c.query('BEGIN');
 await claim(c,pf);
 const claimRows=await locked();
 await c.query('ROLLBACK');
 report.checks.push(`bill2_payg_claim: row locks on shared rows ${JSON.stringify(claimRows)}`);
 // 3. The fixed state.
 for(const [table,n] of Object.entries(rows))assert.equal(n,0,`ROW_LOCK_ON_SHARED_ROW ${table} (admit)`);
 for(const [table,n] of Object.entries(claimRows))assert.equal(n,0,`ROW_LOCK_ON_SHARED_ROW ${table} (claim)`);
 assert.ok(admitError===null,admitError);
 // 4. An administrator can change those rows while a turn is open (the old locks made this wait for the turn).
 await c.query('BEGIN');
 await one('select runtime_admit($1,$2,gen_random_uuid(),$3,$4) v',[f.actor,f.session,f.payload,billing]);
 const peer=new c.constructor({host:'127.0.0.1',port:c.connectionParameters.port,database:c.connectionParameters.database,user:'postgres'});
 await peer.connect();
 try{
  await peer.query("SET lock_timeout='1500ms'");
  await peer.query('UPDATE modules SET title=title WHERE id=$1',[art.module]);
  await peer.query('UPDATE skills SET status=status WHERE id=$1',[art.skill]);
  await peer.query('UPDATE ai_models SET name=name WHERE id=$1',[f.model]);
 }finally{await peer.end();await c.query('ROLLBACK');}
 report.checks.push('while a turn is admitted and not yet committed, an administrator can update the model, module and skill rows without waiting');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
