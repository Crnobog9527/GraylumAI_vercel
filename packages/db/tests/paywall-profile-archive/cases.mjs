/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedActor,seedMethod,start,rpc} from './fixtures.mjs';
import {seed as seedReport} from '../report-finalization/cases.mjs';
import {call,evidence,outcome} from '../erasure-b2a/cases.mjs';
const archived=/^error: OPC_BUSINESS_ARCHIVED$/;
export async function runCases({admin:db,connect,report,read}) {
 const method=await seedMethod(db),actor=await seedActor(db),foreign=await seedActor(db);
 const request=randomUUID(),first=await start(db,actor,method,null,request);
 await rpc(db,'opc_information',actor,first.draftId,'s',randomUUID(),0,
  {goal:{value:'Confirmed local business goal',status:'confirmed',nature:'decision'}});
 const original=await rpc(db,'opc_query',actor,first.draftId);
 assert.equal(original.information.s.values.goal.status,'confirmed');
 await assert.rejects(start(db,actor,method),/^error: OPC_PROFILE_LIMIT$/);
 await assert.rejects(rpc(db,'opc_business_archive',foreign,first.businessId),/^error: OPC_BUSINESS_DENIED$/);
 await assert.rejects(rpc(db,'opc_business_archive',actor,randomUUID()),/^error: OPC_BUSINESS_DENIED$/);
 const review=randomUUID(),decidedReview=randomUUID();
 for(const reviewId of [review,decidedReview]) await db.query(`INSERT INTO fusion_reviews(id,actor_id,request_id,
  draft_id,project_id,source_session_id,source_version_id,version_hash,materials,materials_hash,config,
  state,round,phase,attempt,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,repeat('a',64),'{}',repeat('b',64),'{}',
  'completed',1,'summary',1,'{"kind":"revised"}')`,
 [reviewId,actor,randomUUID(),first.draftId,first.projectId,first.sessionId,randomUUID()]);
 const keepOriginal={requestId:randomUUID(),choices:[{section:'Facts',use:'original'}],state:'recorded',decision:'kept'};
 assert.ok((await rpc(db,'fusion_review_adoption_record',actor,decidedReview,keepOriginal)).adoption,
  'active business can keep original sections and record its decision');
 const reviewBefore=await rpc(db,'fusion_review_read',actor,review);
 const saved=await rpc(db,'opc_business_archive',actor,first.businessId);
 assert.equal(saved.isArchived,true);
 assert.ok(saved.archivedAt);
 assert.deepEqual(await rpc(db,'opc_business_archive',actor,first.businessId),saved,'archive retry is idempotent');
 await assert.rejects(rpc(db,'fusion_review_adoption_record',actor,review,keepOriginal),archived);
 assert.equal((await db.query('SELECT adoption FROM fusion_reviews WHERE id=$1',[review])).rows[0].adoption,null);
 assert.deepEqual(await rpc(db,'fusion_review_read',actor,review),reviewBefore,'saved review remains readable and unchanged');
 report.checks.push('completed Fusion keep-original adoption allowed before archive and refused after archive without writes');
 const second=await start(db,actor,method);
 assert.notEqual(first.businessId,second.businessId,'archive immediately releases one slot');
 await assert.rejects(start(db,actor,method),/^error: OPC_PROFILE_LIMIT$/);
 await assert.rejects(start(db,actor,method,first.businessId),archived);
 await assert.rejects(start(db,actor,method,null,request),archived);
 // Six-argument old application calls still receive the same protected RPC/default.
 await assert.rejects(rpc(db,'opc_start_b1',actor,randomUUID(),method.registration,'manual',first.businessId,null),archived);
 assert.deepEqual(await rpc(db,'opc_query',actor,first.draftId),original,'old application read retains confirmed material');
 const list=await rpc(db,'opc_businesses_list',actor);
 assert.equal(list.length,2);
 assert.deepEqual(list.map(b=>b.isArchived).sort(),[false,true]);
 assert.equal(list.find(b=>b.businessId===first.businessId).drafts[0].draftId,first.draftId);
 assert.deepEqual(await rpc(db,'opc_businesses_list',foreign),[]);
 report.checks.push('own archive/retry, foreign and missing target denied','free cap excludes archive; immediate new start succeeds',
  'archived business cannot be selected/replayed; old 6-argument API compatible','list ownership and archived flag; confirmed data remains readable');

 const beforeCredits=(await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
 for(const [name,args] of [
  ['opc_step_material',[actor,first.draftId,randomUUID(),'s','mentor','test']],
  ['opc_information',[actor,first.draftId,'s',randomUUID(),1,{}]],
  ['runtime_admit',[actor,first.sessionId,randomUUID(),{},{}]],
  ['bill2_prepare',[actor,randomUUID(),{scope:{kind:'positioning_draft',draftId:first.draftId}}]],
  ['fusion_review_start',[actor,randomUUID(),first.draftId,randomUUID(),{}]],
  ['report_revision',[actor,first.draftId,'propose',randomUUID(),null,null,'body',{},null]],
  ['artifact_transition',[actor,method.module,method.skill,'save',first.projectId,first.roundId,randomUUID(),{}]],
  ['opc_library_edit',[actor,randomUUID(),'business',first.businessId,2,{name:'Cannot rename archived'}]],
 ]) await assert.rejects(rpc(db,name,...args),archived,name);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits,beforeCredits);
 report.checks.push('archived AI admission/report revision/Fusion/manual writes denied before any credits change');

 for(const role of ['anon','authenticated']) {
  await db.query('SET ROLE '+role);
  await assert.rejects(rpc(db,'opc_business_archive',actor,first.businessId),/permission denied/);
  await assert.rejects(rpc(db,'opc_businesses_list',actor),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 assert.equal((await rpc(db,'opc_businesses_list',actor)).length,2);
 await assert.rejects(rpc(db,'opc_target_business',actor,{businessId:first.businessId}),/permission denied/);
 await db.query('RESET ROLE');
 report.checks.push('anon/authenticated cannot invoke privileged archive/list; service has no private helper access');

 // Deterministic overlap: hold archive's transaction open while two starts queue on
 // the same actor row, then release. Exactly one start can occupy the released slot.
 const racing=await seedActor(db),old=await start(db,racing,method);
 const archiver=await connect(),one=await connect(),two=await connect(),payer=await connect();
 await archiver.query('BEGIN');
 await rpc(archiver,'opc_business_archive',racing,old.businessId);
 const starts=[start(one,racing,method),start(two,racing,method)];
 const paid=assert.rejects(rpc(payer,'bill2_prepare',racing,randomUUID(),
  {scope:{kind:'positioning_draft',draftId:old.draftId}}),archived);
 const pids=(await db.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
  AND query LIKE 'SELECT opc_start_b1(%' AND wait_event_type='Lock'`)).rows;
 // Queries may still be arriving; observe PostgreSQL blocking rather than assume a timer means overlap.
 let blocked=pids.length;
 for(let n=0;n<100&&blocked<2;n++) {
  await new Promise(r=>setTimeout(r,10));
  blocked=Number((await db.query(`SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database()
   AND query LIKE 'SELECT opc_start_b1(%' AND wait_event_type='Lock'`)).rows[0].n);
 }
 assert.equal(blocked,2,'both new starts wait for archive user lock');
 await archiver.query('COMMIT');
 const results=await Promise.allSettled(starts);
 await paid;
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.message==='OPC_PROFILE_LIMIT').length,1);
 assert.equal((await db.query(`SELECT count(*)::int n FROM opc_businesses
  WHERE actor_id=$1 AND erased_at IS NULL AND archived_at IS NULL`,[racing])).rows[0].n,1);
 // A business mutation already has its KEY SHARE lock: archive fails fast, not a deadlock.
 const active=results.find(r=>r.status==='fulfilled').value;
 await one.query('BEGIN');
 await rpc(one,'opc_assert_business_writable',racing,{draftId:active.draftId});
 await assert.rejects(rpc(two,'opc_business_archive',racing,active.businessId),/^error: OPC_BUSINESS_BUSY$/);
 await one.query('COMMIT');
 assert.equal((await rpc(two,'opc_business_archive',racing,active.businessId)).isArchived,true);
 report.checks.push('two concurrent starts wait for archive then exactly one succeeds; active count remains 1',
  'concurrent paid admission waits for archive then refuses; mutation makes archive retry without deadlock');

 // Real BILL2 run and dispatch: unsettled dispatch cannot be archived; receipts,
 // settlement and result persistence continue. A prepared pre-archive call cannot dispatch later.
 await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await db.query(read('packages/db/tests/content-erasure/fixture.sql'));
 const rf=await seedReport(db);
 const business=(await db.query('SELECT id FROM opc_businesses WHERE actor_id=$1 AND current_source_version_id=$2',
  [rf.actor,rf.version])).rows[0].id;
 await db.query('INSERT INTO opc_draft_businesses(draft_id,business_id) VALUES($1,$2)',[rf.draft,business]);
 const payload=(await db.query(`SELECT r.payload FROM bill2_runs r JOIN runtime_executions e ON e.billing_run_id=r.id
  WHERE e.id=$1`,[rf.execution])).rows[0].payload;
 const document=await rpc(db,'report_document',rf.actor,rf.execution,'read',null,null,null,null);
 assert.ok(document.body);
 const info=(await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[rf.round])).rows[0].steps;
 const run=await rpc(db,'bill2_prepare',rf.actor,randomUUID(),payload);
 const f={...rf.base,run:run.id,payload};
 const billing={actor:rf.actor};
 const dispatched=await call(db,f);
 await assert.rejects(rpc(db,'opc_business_archive',billing.actor,business),/^error: OPC_BUSINESS_BUSY$/);
 await rpc(db,'bill2_record',billing.actor,f.run,dispatched.id,evidence(dispatched));
 await rpc(db,'bill2_close',billing.actor,f.run,'delivered',outcome);
 await rpc(db,'bill2_finalize',billing.actor,f.run);
 const queued=await rpc(db,'bill2_prepare',billing.actor,randomUUID(),payload);
 const prepared=await call(db,{...f,run:queued.id},1,false);
 await rpc(db,'opc_business_archive',billing.actor,business);
 await assert.rejects(rpc(db,'bill2_dispatch',billing.actor,queued.id,prepared.id,prepared.dispatchToken),archived);
 await assert.rejects(rpc(db,'bill2_claim',billing.actor,queued.id,2,{}),archived);
 // Cancellation/reconciliation remain available for money reserved before archive.
 await rpc(db,'bill2_close',billing.actor,queued.id,'confirmed_failure',{
  kind:'confirmed_delivery_failure',evidenceRef:'archive-test',evidenceHash:'d'.repeat(64),body:'Not dispatched',
 });
 await rpc(db,'bill2_finalize',billing.actor,queued.id);
 report.checks.push('already dispatched call delays archive until settled','prepared call cannot dispatch/claim after archive; money cleanup allowed');

 // Generated report and linked accounts/work items remain readable with all their
 // authoritative data; archived draft edits, report saves and paid descendants refuse.
 const sourceBusiness=business;
 const account=(await db.query('SELECT project_id FROM opc_accounts WHERE business_id=$1',[sourceBusiness])).rows[0].project_id;
 assert.deepEqual(await rpc(db,'report_document',rf.actor,rf.execution,'read',null,null,null,null),document);
 assert.deepEqual((await db.query('SELECT steps FROM artifact_rounds WHERE id=$1',[rf.round])).rows[0].steps,info);
 await assert.rejects(rpc(db,'report_document',rf.actor,rf.execution,'save',randomUUID(),0,'cannot edit',null),archived);
 await assert.rejects(rpc(db,'opc_account_strategy_begin',rf.actor,account,randomUUID()),archived);
 await assert.rejects(rpc(db,'opc_content_manual_save',rf.actor,rf.workItem,randomUUID(),0,null,'script','draft','test','test'),archived);
 await assert.rejects(rpc(db,'bill2_prepare',rf.actor,randomUUID(),{
  scope:{kind:'work_item',projectId:account,workItemId:rf.workItem}}),archived);
 report.checks.push('generated report read/export source and confirmed state survive archive unchanged',
  'archived report edits, linked account strategy and work-item generation rejected');
 const startSource=(await db.query("SELECT pg_get_functiondef('opc_start_b1(uuid,uuid,text,text,uuid,text,text)'::regprocedure) v")).rows[0].v;
 assert.match(startSource,/PAY-STRIPE-MP authoritative cap/,'0322 paid fallback cap fix retained');
 assert.match(startSource,/business.archived_at IS NULL/);
}
