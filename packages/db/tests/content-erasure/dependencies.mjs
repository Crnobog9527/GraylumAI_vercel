/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,outcome} from '../erasure-b2a/cases.mjs';
import {erase,preview} from './cases.mjs';
export async function runDependencies(db,report){
 const f=(await db.query('SELECT runtime_perf_test.seed(3,true) v')).rows[0].v;
 await db.query('UPDATE runtime_executions SET result=result||$2::jsonb WHERE session_id=$1',[f.session,outcome]);
 const rows=(await db.query('SELECT id FROM runtime_executions WHERE session_id=$1 ORDER BY created_at',[f.session])).rows;
 assert.equal((await rpc(db,'runtime_view',f.actor,f.session)).executions.length,3);
 const root=rows[0].id;
 const p=await preview(db,f,'answer',root);assert.equal(p.affectedExecutions,3);
 await erase(db,f,'answer',root,p.previewHash);
 const view=await rpc(db,'runtime_view',f.actor,f.session);
 assert.equal(view.executions.length,3);
 assert.ok(view.executions.every(e=>e.contentDeleted===true&&e.input==='Synthetic input'));
 assert.doesNotMatch(JSON.stringify(view),/中文 fixture|Synthetic history/);
 for(const {id} of rows)await assert.rejects(rpc(db,'runtime_execution',f.actor,id,'read',null),/CONTENT_ERASED/);
 await assert.rejects(db.query('UPDATE runtime_executions SET result=$2 WHERE id=$1',[root,{body:'RESTORE_DENIED'}]),/CONTENT_ERASED/);
 const request=(await db.query('SELECT start_request_id FROM runtime_sessions WHERE id=$1',[f.session])).rows[0].start_request_id;
 await erase(db,f,'session',f.session);
 await assert.rejects(rpc(db,'runtime_start',f.actor,request,{}),/CONTENT_ERASED/);
 report.checks.push('dependency closure scrubs copied history and execution bodies; original questions retained; read and start replay denied');
 const g=(await db.query('SELECT runtime_perf_test.seed(1,false) v')).rows[0].v;
 await db.query('UPDATE runtime_executions SET result=result||$2::jsonb WHERE session_id=$1',[g.session,outcome]);
 const art=(await db.query('SELECT d7_test.artifacts($1) v',[g.actor])).rows[0].v;
 const round=randomUUID();
 const information={value:'CAPTURE_PRIVATE_BODY',status:'confirmed',nature:'fact'};
 const fp=(await db.query('SELECT artifact_hash($1::jsonb) h',[information])).rows[0].h;
 const steps={s:{version:1,valid:false,information:{captured:information,manual:{value:'KEEP_MANUAL',status:'confirmed'}},
  fieldMeta:{captured:{source:'capture',executionId:g.execution,fp},manual:{source:'manual'}}}};
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
  VALUES($1,$2,$3,$4,'{}',$5,$5,$6)`,[round,art.project,art.revision,'b'.repeat(64),'c'.repeat(64),steps]);
 const evidenceId=randomUUID();
 await db.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind,current_version)
  VALUES($1,$2,$3,$4,'result',1)`,[g.execution,g.actor,art.module,art.skill]);
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
  VALUES($1,$1,$2,$3,'{"steps":[]}', $4,$4,'published','{}')`,[g.execution,art.revision,'b'.repeat(64),'c'.repeat(64)]);
 await db.query(`INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash)
  VALUES($1,$2,'user',$3,$4)`,[evidenceId,g.execution,{executionId:g.execution},'d'.repeat(64)]);
 await db.query('INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES($1)',[evidenceId]);
 await db.query("INSERT INTO opc_result_links VALUES($1,$2,$2,'result',NULL)",[evidenceId,g.execution]);
 await db.query(`INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
  VALUES($1,$1,$1,1,$2,$3,$4)`,[g.execution,{sections:[{body:'KEEP_INDEPENDENT_REPORT'}]},'e'.repeat(64),JSON.stringify([evidenceId])]);
 assert.equal((await preview(db,g)).preservedSavedVersions,1);
 await erase(db,g);
 const cleaned=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[round])).rows[0].steps;
 assert.doesNotMatch(JSON.stringify(cleaned),/CAPTURE_PRIVATE_BODY/);
 assert.match(JSON.stringify(cleaned),/KEEP_MANUAL/);
 assert.equal(cleaned.s.version,2);assert.equal(cleaned.s.fieldMeta.captured.executionId,undefined);
 const reportView=await rpc(db,'artifact_transition',g.actor,art.module,art.skill,'report',g.execution,g.execution,null,{});
 assert.equal(reportView.available,true);assert.equal(reportView.sourceAvailable,false);
 assert.match(JSON.stringify(reportView),/KEEP_INDEPENDENT_REPORT/);
 await erase(db,g,'session',g.session);
 assert.match(JSON.stringify(await rpc(db,'opc_work_results',g.actor,g.session)),/KEEP_INDEPENDENT_REPORT/);
 await db.query('UPDATE artifact_evidence_restrictions SET deleted=true WHERE evidence_id=$1',[evidenceId]);
 assert.equal(await rpc(db,'content_erasure_artifact_readable',g.actor,g.execution),false);
 report.checks.push('independent Runtime saved report survives answer/session deletion; explicit evidence revocation still denied');
 report.checks.push('capture provenance and copied information scrubbed together; independent manual field retained');
}
