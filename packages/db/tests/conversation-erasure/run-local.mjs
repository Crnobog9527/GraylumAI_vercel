/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
import {rpc,outcome} from '../erasure-b2a/cases.mjs';

// Disposable PostgreSQL only. Automatically discovered by the existing database behaviour CI job.
const local=await localDb();
const db=local.client;
const report={checks:[],samples:{},failed:null};
try{
 await db.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 await db.query(read('packages/db/tests/content-erasure/fixture.sql'));
 const owner=(await db.query('SELECT runtime_perf_test.seed(0,false) f')).rows[0].f;
 const art=(await db.query('SELECT d7_test.artifacts($1) f',[owner.actor])).rows[0].f;
 const session=owner.session;
 const scope=(await db.query('SELECT scope FROM runtime_sessions WHERE id=$1',[session])).rows[0].scope;
 const ids=[];let first;
 for(let i=0;i<26;i++){
  const f=await createFixture(db,{actor:owner.actor,scope,lookupSupported:true,sameModel:first});
  first??=f;
  const execution=randomUUID();
  const payload={input:`Synthetic question ${i}`,role:'skill',
   attachedOrganizer:{input:JSON.stringify({checklist:[{id:'s',fields:[{id:'goal',status:'confirmed',value:'Confirmed goal'}]}]})},
   instructions:'Synthetic mentor instructions. '.repeat(300),history:ids.map(id=>({executionId:id}))};
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,billing_run_id)
   VALUES($1,$2,$3,$4,$5,$6,'interrupted',$7)`,[execution,owner.actor,session,randomUUID(),payload,i*2,f.run]);
  await db.query('UPDATE bill2_runs SET session_ref=$2 WHERE id=$1',[f.run,session]);
  await db.query('UPDATE runtime_sessions SET active_execution=$2 WHERE id=$1',[session,execution]);
  for(const sequence of [1,2]){
   const c=await claim(db,f,sequence);await receipt(db,f,c);
  }
  await rpc(db,'bill2_close',owner.actor,f.run,'delivered',outcome);
  await rpc(db,'bill2_finalize',owner.actor,f.run);
  await db.query("UPDATE runtime_executions SET result=$2,state='completed' WHERE id=$1",[execution,outcome]);
  await db.query('UPDATE runtime_sessions SET active_execution=NULL,revision=$2 WHERE id=$1',[session,(i+1)*2]);
  await db.query(`INSERT INTO runtime_session_history(session_id,revision,execution_id,item)
   VALUES($1,$2,$3,'{"role":"user","content":"Synthetic user message"}'),
   ($1,$2+1,$3,'{"role":"assistant","content":"Synthetic answer"}')`,[session,i*2+1,execution]);
  await db.query('INSERT INTO runtime_history_dependencies SELECT $1,x FROM unnest($2::uuid[]) x',[execution,ids]);
  ids.push(execution);
 }
 // Attach the completed history to a real positioning draft only after genuine BILL2 admission;
 // the test fixture has no published mentor Skill/token and must not bypass the admission gate.
 const project=randomUUID(),round=randomUUID();
 await db.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,current_version)
  SELECT $1,actor_id,module_id,skill_id,1 FROM artifact_projects WHERE id=$2`,[project,art.project]);
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
  SELECT $1,$2,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps FROM artifact_rounds WHERE id=$3`,
 [round,project,art.round]);
 await db.query(`INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
  SELECT $1,$2,$3,1,report,report_hash,evidence_ids FROM artifact_versions WHERE id=$4`,[randomUUID(),project,round,art.version]);
 await db.query(`INSERT INTO opc_drafts SELECT $1,$2,$3,$4,$5,gen_random_uuid(),registration,'mentor'
  FROM opc_drafts WHERE project_id=$6`,[owner.draft,owner.actor,project,round,session,art.project]);
 const money=async()=>(await db.query(`SELECT
  (SELECT credits FROM profiles WHERE id=$1) credits,
  (SELECT sum(amount) FROM credit_transactions WHERE user_id=$1) ledger_total,
  (SELECT count(*) FROM credit_transactions WHERE user_id=$1) ledger_count,
  (SELECT sum(charged) FROM bill2_runs WHERE actor_id=$1) charged`,[owner.actor])).rows[0];
 const before=await money();
 assert.equal(ids.length,26);
 assert.equal((await db.query('SELECT count(*)::int n FROM artifact_versions WHERE project_id=$1',[project])).rows[0].n,1);
 // A real database statement cancellation rolls the entire RPC back. No simulated success or marker.
 await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='1ms'");
 await assert.rejects(rpc(db,'content_erasure_mark_session',owner.actor,session),{code:'57014'});
 await db.query('ROLLBACK');
 assert.equal((await db.query('SELECT content_deleted_at FROM runtime_sessions WHERE id=$1',[session])).rows[0].content_deleted_at,null);
 assert.deepEqual(await money(),before);
 report.checks.push('26 executions / 52 paid calls / 52 history rows / published report: timeout SQLSTATE 57014 rolls back marker and money');
 // Same 8-second ceiling as staging: no timeout increase, no trigger/constraint disabled.
 await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='8s'");
 const start=performance.now();
 const deleted=await rpc(db,'content_erasure_mark_session',owner.actor,session);
 report.samples.markMs=Math.round(performance.now()-start);
 assert.equal(deleted.status,'deleted');await db.query('COMMIT');
 assert.equal((await rpc(db,'content_erasure_mark_session',owner.actor,session)).alreadyDeleted,true);
 assert.deepEqual(await money(),before);
 assert.equal((await db.query('SELECT count(*)::int n FROM runtime_session_history WHERE session_id=$1 AND item IS NOT NULL',[session])).rows[0].n,0);
 assert.equal((await db.query(`SELECT count(*)::int n FROM runtime_executions
  WHERE session_id=$1 AND (payload IS NOT NULL OR result IS NOT NULL OR content_deleted_at IS NULL)`,[session])).rows[0].n,0);
 await assert.rejects(rpc(db,'runtime_view',owner.actor,session),/CONTENT_ERASED/);
 const other=(await db.query('SELECT runtime_perf_test.seed(0,false) f')).rows[0].f;
 await assert.rejects(rpc(db,'content_erasure_mark_session',other.actor,session),/CONTENT_NOT_FOUND/);
 report.checks.push('same long conversation deletes within 8s; repeat is idempotent; history/payload gone; money unchanged; reads and other actors refused');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.query('ROLLBACK').catch(()=>{});await local.close();console.log(JSON.stringify(report,null,2));}
