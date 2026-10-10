/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture,rpc,closeAccount,call,evidence,outcome} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
const hash=body=>createHash('sha256').update(body).digest('hex');
const original='## One\nOriginal confirmed facts.\n## Two\nKnown limitations.';
const edited='## One\nR5_MANUAL_PRIVATE_BODY\n## Two\nManually retained limitations.';
async function seed(db,completeness='complete',evidenceCount=0) {
 const base=await fixture(db);
 const f=(await db.query('SELECT d7_test.artifacts($1) v',[base.actor])).rows[0].v;
 const project=randomUUID(),round=randomUUID(),confirmation=randomUUID(),execution=randomUUID();
 const draft=await rpc(db,'bill2_create_draft',f.actor);
 const session=randomUUID();
 const workflow={id:'r5-fixture',version:1,kind:'document',steps:[{id:'s',title:'Facts',dependsOn:[],
  resources:[],minLength:1,maxLength:20000,requiresEvidence:false,requiredCapabilities:[],information:[]}],
  report:{id:'report',version:1,title:'Positioning',sections:[{title:'Facts',stepId:'s'}]},
  planResources:['report.md'],reportGeneration:{resources:['report.md'],sections:['One','Two'],maxCharacters:12000}};
 const sourceIds=Array.from({length:evidenceCount},()=>randomUUID()).sort();
 const steps={s:{body:'CONFIRMED_FIELDS_UNCHANGED',version:1,reviewVersion:0,valid:true,
  confirmationId:confirmation,evidenceIds:sourceIds,provenanceIds:sourceIds,information:{}}};
 await db.query('INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account) VALUES($1,$2,$3,$4,$5)',
  [project,f.actor,f.module,f.skill,'r5-'+project]);
 for(const id of sourceIds) {
  await db.query(`INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash)
   VALUES($1,$2,'user','{"body":"fixed source"}',repeat('a',64))`,[id,project]);
  await db.query('INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES($1)',[id]);
 }
 await db.query(`INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
  VALUES($1,$2,$3,repeat('b',64),$4,repeat('c',64),repeat('d',64),'draft',$5)`,[round,project,f.revision,workflow,steps]);
 await db.query(`INSERT INTO artifact_confirmations(id,round_id,step_id,version,review_version,body,evidence_ids)
  VALUES($1,$2,'s',1,0,'CONFIRMED_FIELDS_UNCHANGED',$3)`,[confirmation,round,JSON.stringify(sourceIds)]);
 await db.query(`INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload)
  VALUES($1,$2,$3,$4,'{}')`,[session,f.actor,{kind:'positioning_draft',draftId:draft},randomUUID()]);
 await db.query(`INSERT INTO opc_drafts(draft_id,actor_id,project_id,round_id,session_id,request_id,registration,mode)
  VALUES($1,$2,$3,$4,$5,$6,(SELECT id FROM artifact_workflows WHERE module_id=$7 LIMIT 1),'mentor')`,
 [draft,f.actor,project,round,session,randomUUID(),f.module]);
 const source=await rpc(db,'report_source',f.actor,session,project,round);
 const spec={version:1,projectId:project,roundId:round,snapshotHash:source.snapshotHash,
  packageHash:'b'.repeat(64),workflowHash:'c'.repeat(64),templateHash:'d'.repeat(64),
  evidenceIds:[],sections:['One','Two'],maxCharacters:12000};
 const context={reportGeneration:spec,request:{sessionId:session},sources:[],network:'deny',role:'skill',
  moduleId:f.module,skillId:f.skill,revisionId:f.revision,packageHash:'b'.repeat(64)};
 const billing={...base.payload,scope:{kind:'positioning_draft',draftId:draft},input:context,
  moduleId:f.module,skillId:f.skill,revisionId:f.revision};
 const run=await rpc(db,'bill2_prepare',f.actor,randomUUID(),billing);
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result,billing_run_id)
  VALUES($1,$2,$3,$4,$5,0,'completed',$6,$7)`,[execution,f.actor,session,randomUUID(),context,
  {body:original,completeness},run.id]);
 await db.query('UPDATE bill2_runs SET session_ref=$1 WHERE id=$2',[session,run.id]);
 const reportRun={...base,run:run.id};
 const claimed=await call(db,reportRun);
 await rpc(db,'bill2_record',f.actor,run.id,claimed.id,evidence(claimed));
 await rpc(db,'bill2_close',f.actor,run.id,'delivered',{...outcome,body:original});
 await rpc(db,'bill2_finalize',f.actor,run.id);

 return {...f,project,round,session,draft,execution,base};
}
const read=(db,f)=>rpc(db,'report_document',f.actor,f.execution,'read',null,null,null,null);
const save=(db,f,body=edited,revision=0,request=randomUUID())=>rpc(db,'report_document',f.actor,f.execution,'save',request,revision,body,null);
const finalize=(db,f,body=original,revision=0,request=randomUUID())=>rpc(db,'report_document',f.actor,f.execution,'finalize',request,revision,null,hash(body));
export async function runCases({db,Client,connectionString,report}) {
 for(const role of ['anon','authenticated']) {
  await db.query('SET ROLE '+role);
  await assert.rejects(rpc(db,'report_document',randomUUID(),randomUUID(),'read',null,null,null,null),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 await assert.rejects(rpc(db,'report_document_source',randomUUID(),randomUUID()),/permission denied/);
 await db.query('RESET ROLE');
 report.checks.push('public roles denied; service_role cannot invoke private source helper');
 const f=await seed(db);
 await db.query('SET ROLE service_role');
 assert.equal((await read(db,f)).candidate,true);
 await db.query('RESET ROLE');
 const foreign=await fixture(db);
 await assert.rejects(read(db,{...f,actor:foreign.actor}),/REPORT_EXECUTION_REQUIRED/);
 await assert.rejects(read(db,{...f,actor:randomUUID()}),/ACTOR_DENIED|REPORT_EXECUTION_REQUIRED/);
 const request=randomUUID();
 const saved=await save(db,f,edited,0,request);
 assert.equal(saved.revision,1);assert.equal(saved.manuallyEdited,true);assert.equal(saved.bodyHash,hash(edited));
 assert.equal((await save(db,f,edited,0,request)).revision,1);
 await assert.rejects(save(db,f,original,0,request),/REPORT_REQUEST_CONFLICT/);
 await assert.rejects(save(db,f,original,0),/REPORT_VERSION_CONFLICT/);
 const before=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[f.round])).rows[0].steps;
 await assert.rejects(finalize(db,f,original,1),/REPORT_VERSION_CONFLICT/);
 const finalRequest=randomUUID();
 const result=await finalize(db,f,edited,1,finalRequest);
 assert.equal(result.finalized,true);assert.equal(result.version,1);
 assert.deepEqual(result.next,{kind:'first_week_topics',draftId:f.draft,sourceVersionId:result.versionId});
 assert.equal((await finalize(db,f,edited,1,finalRequest)).versionId,result.versionId);
 await assert.rejects(finalize(db,f,edited,1),/REPORT_ALREADY_FINALIZED/);
 await assert.rejects(save(db,f,edited,1),/REPORT_ALREADY_FINALIZED/);
 assert.deepEqual((await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[f.round])).rows[0].steps,before);
 const formal=(await db.query('SELECT report FROM artifact_versions WHERE id=$1',[result.versionId])).rows[0].report;
 assert.equal(formal.generatedReport.body,edited);assert.equal(formal.generatedReport.manuallyEdited,true);
 assert.equal(formal.sections[0].body,'CONFIRMED_FIELDS_UNCHANGED');
 assert.equal(await rpc(db,'opc_source_allowed',f.actor,result.versionId),true);
 const topic=await rpc(db,'opc_topic_consent',f.actor,f.draft,result.versionId);
 assert.equal(topic.bound,true);assert.equal(topic.sourceVersionId,result.versionId);
 assert.equal((await db.query('SELECT count(*) n FROM runtime_executions WHERE session_id=$1',[topic.sessionId])).rows[0].n,'0');
 report.checks.push('edit marker, optimistic concurrency, immutable formal body, unchanged confirmed fields, replay and OPC source compatibility');
 for(const completeness of ['length_limit','stopped',null]) {
  const t=await seed(db,completeness);
  assert.equal((await read(db,t)).candidate,false);
  await save(db,t);
  await assert.rejects(finalize(db,t,edited,1),/REPORT_NOT_COMPLETE/);
  await assert.rejects(rpc(db,'artifact_transition',t.actor,t.module,t.skill,'publish',t.project,t.round,randomUUID(),{}),
   /REPORT_EXECUTION_REQUIRED/);
 }
 const incomplete=await seed(db);
 await save(db,incomplete,'## One\nOnly one section.');
 await assert.rejects(finalize(db,incomplete,'## One\nOnly one section.',1),/REPORT_NOT_COMPLETE/);
 report.checks.push('truncated/stopped/unknown original cannot finalize after hand edit; malformed manual report denied; legacy publish cannot bypass');
 const stale=await seed(db);
 await db.query(`UPDATE artifact_rounds SET steps=jsonb_set(steps,'{s,body}','"Changed facts"') WHERE id=$1`,[stale.round]);
 await assert.rejects(finalize(db,stale),/REPORT_SOURCE_CONFLICT/);
 report.checks.push('changed confirmation snapshot invalidates the report before publication');
 const race=await seed(db);const other=new Client({connectionString});await other.connect();
 try {
  const outcomes=await Promise.allSettled([save(db,race,edited),save(other,race,original)]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.match(String(outcomes.find(x=>x.status==='rejected').reason),/REPORT_VERSION_CONFLICT/);
 } finally {await other.end();}
 report.checks.push('two concurrent edits from revision zero yield exactly one winner');
 await erase(db,f,'artifact',f.project);
 await assert.rejects(read(db,f),/CONTENT_ERASED/);
 const rows=(await db.query('SELECT payload,response,erased_at FROM artifact_requests WHERE project_id=$1',[f.project])).rows;
 assert.ok(rows.length>=2);assert.ok(rows.every(row=>row.erased_at&&row.response===null));
 assert.doesNotMatch(JSON.stringify(rows),/R5_MANUAL_PRIVATE_BODY/);
 assert.equal((await db.query('SELECT report FROM artifact_versions WHERE id=$1',[result.versionId])).rows[0].report,null);
 report.checks.push('D7 artifact deletion scrubs hand edits, formal report and replay rows without changing erasure functions');
 const independent=await seed(db);await save(db,independent);const published=await finalize(db,independent,edited,1);
 await erase(db,independent,'answer',independent.execution);
 const retained=await rpc(db,'artifact_transition',independent.actor,independent.module,independent.skill,'report',
  independent.project,independent.round,null,{});
 assert.equal(retained.available,true);assert.equal(retained.sourceAvailable,false);
 assert.equal(retained.report.generatedReport.body,edited);
 assert.equal(await rpc(db,'opc_source_allowed',independent.actor,published.versionId),false);
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload FROM artifact_requests WHERE project_id=$1',
  [independent.project])).rows),/R5_MANUAL_PRIVATE_BODY/);
 report.checks.push('deleting the report execution preserves the independent formal body but revokes its source and clears edit copies');
 const atLimit=await seed(db,'complete',128);
 assert.equal((await read(db,atLimit)).candidate,true);
 await assert.rejects(finalize(db,atLimit),/REPORT_EVIDENCE_CAPACITY/);
 assert.equal((await db.query('SELECT count(*) n FROM artifact_versions WHERE project_id=$1',[atLimit.project])).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) n FROM artifact_evidence WHERE project_id=$1',[atLimit.project])).rows[0].n,'128');
 assert.equal((await db.query('SELECT state FROM artifact_rounds WHERE id=$1',[atLimit.round])).rows[0].state,'draft');
 const fits=await seed(db,'complete',127);const fitsFinal=await finalize(db,fits);
 assert.equal((await db.query('SELECT jsonb_array_length(evidence_ids) n FROM artifact_versions WHERE id=$1',
  [fitsFinal.versionId])).rows[0].n,128);
 assert.equal(await rpc(db,'opc_source_allowed',fits.actor,fitsFinal.versionId),true);
 assert.equal((await rpc(db,'opc_topic_consent',fits.actor,fits.draft,fitsFinal.versionId)).bound,true);
 report.checks.push('127 source records finalize into 128 with usable topic handoff; 128 rejects and atomically rolls back every publication write');
 const closed=await seed(db);await save(db,closed);await finalize(db,closed,edited,1);
 await closeAccount(db,closed.base);
 await rpc(db,'account_erasure_scrub_content',closed.actor);
 assert.doesNotMatch(JSON.stringify((await db.query('SELECT payload,response FROM artifact_requests WHERE project_id=$1',[closed.project])).rows),
  /R5_MANUAL_PRIVATE_BODY/);
 assert.equal((await db.query('SELECT report FROM artifact_versions WHERE project_id=$1',[closed.project])).rows[0].report,null);
 await assert.rejects(read(db,closed),/ACTOR_DENIED|CONTENT_ERASED/);
 report.checks.push('account erasure scrubs all new text in existing content tables and denies future reads');
}
