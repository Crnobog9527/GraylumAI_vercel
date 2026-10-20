/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {seedActor,seedMethod,start,rpc} from './fixtures.mjs';
import {createFixture,receipt} from '../payg/fixture.mjs';
const wallet=async(db,actor)=>Number((await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits);
export async function reviewArchiveCases({admin:db,connect,report,read}) {
 const method=await seedMethod(db);
 const seed=async()=>{
  const actor=await seedActor(db);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[actor]);
  await db.query("UPDATE membership_plans SET allow_fusion_review=true WHERE level='gold'");
  const source=await start(db,actor,method),review=randomUUID(),request=randomUUID(),version=randomUUID();
  const config={maxRounds:1,fixedPrice:{credits:50,holdCredits:20}};
  await db.query(`INSERT INTO fusion_reviews(id,actor_id,request_id,draft_id,project_id,source_session_id,
   source_version_id,version_hash,materials,materials_hash,config,state,round,phase,attempt)
   VALUES($1,$2,$3,$4,$5,$6,$7,repeat('a',64),'{}',repeat('b',64),$8,'running',1,'review',1)`,
  [review,actor,request,source.draftId,source.projectId,source.sessionId,version,config]);
  await db.query('SELECT fusion_review_fee_hold(fr,$2,$3) FROM fusion_reviews fr WHERE id=$1',
   [review,{review:{fixedPriceCredits:50}},config]);
  return {actor,source,review,request,version};
 };
 const prepare=async(f,race=false)=>{
  const members=[await createFixture(db,{actor:f.actor,phase:'fusion_review'})];
  members.push(await createFixture(db,{actor:f.actor,phase:'fusion_review'}));
  const group=await rpc(db,'fusion_group_create',f.actor,randomUUID(),'review',f.source.sessionId);
  for(const member of members)await rpc(db,'fusion_group_attach',f.actor,group,member.run);
  const payload=JSON.stringify(members.map(member=>({runId:member.run,sequence:1,payload:member.claimPayload})));
  let claim;
  if(race) {
   const [payer,archiver]=await Promise.all([connect(),connect()]);
   const [accepted,refused]=await Promise.all([
    rpc(payer,'fusion_review_claim',f.actor,f.review,1,'review',1,group,payload),
    rpc(archiver,'opc_business_archive',f.actor,f.source.businessId).then(()=>null,error=>error),
   ]);
   assert.match(String(refused),/^error: OPC_BUSINESS_BUSY$/);claim=accepted;
  } else claim=await rpc(db,'fusion_review_claim',f.actor,f.review,1,'review',1,group,payload);
  return {...f,members,group,calls:claim.calls};
 };
 const archive=f=>rpc(db,'opc_business_archive',f.actor,f.source.businessId);
 const deliver=async(f,members,calls,body)=>{
  for(const member of members) {
   const call=calls.find(c=>c.runId===member.run);
   assert.equal((await rpc(db,'bill2_dispatch',f.actor,member.run,call.id,call.dispatchToken)).dispatch,true);
   await receipt(db,member,call,'0.0004',{inputTokens:400,outputTokens:0});
   await rpc(db,'fusion_call_output_save',f.actor,call.id,body);
   await rpc(db,'fusion_call_verdict',f.actor,call.id,'usable');
   await rpc(db,'bill2_cancel',f.actor,member.run);await rpc(db,'bill2_finalize',f.actor,member.run);
  }
 };
 const legacy=async f=>{
  // Only this isolated test database may seed the persisted pre-0326 state.
  // Disable exactly the new transition trigger, atomically with fixture setup.
  await db.query('BEGIN');
  try {
   await db.query('ALTER TABLE opc_businesses DISABLE TRIGGER opc_review_archive_guard');
   await db.query('UPDATE opc_businesses SET archived_at=clock_timestamp(),revision=revision+1 WHERE id=$1',[f.source.businessId]);
   await db.query('ALTER TABLE opc_businesses ENABLE TRIGGER opc_review_archive_guard');
   await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;}
 };
 const state=async f=>(await db.query(`SELECT jsonb_build_object('review',(SELECT to_jsonb(rv) FROM fusion_reviews rv WHERE id=$1),
  'fee',(SELECT to_jsonb(fe) FROM fusion_review_fees fe WHERE review_id=$1),
  'runs',(SELECT jsonb_agg(to_jsonb(br) ORDER BY br.id) FROM bill2_runs br WHERE actor_id=$2),
  'wallet',(SELECT credits FROM profiles WHERE id=$2),'ledger',(SELECT count(*) FROM credit_transactions WHERE user_id=$2)) v`,
 [f.review,f.actor])).rows[0].v;
 const assertReleased=async f=>{
  const stored=await state(f);
  assert.equal(stored.review.state,'incomplete','the entry point, not the assertion read, already ended the legacy review');
  assert.equal(stored.fee.state,'refunded');assert.equal(stored.fee.charged_credits,0);
  assert.equal(await wallet(db,f.actor),1000);
  const view=await rpc(db,'fusion_review_read',f.actor,f.review);
  assert.equal(view.state,'incomplete');assert.equal(view.fee.state,'refunded');assert.equal(view.fee.chargedCredits,0);
  assert.equal(await wallet(db,f.actor),1000,'fixed fee and every undispatched temporary hold return immediately');
  assert.equal(Number((await db.query('SELECT count(*) n FROM bill2_runs WHERE actor_id=$1 AND NOT closed',[f.actor])).rows[0].n),0);
  const before=await state(f);await rpc(db,'fusion_review_read',f.actor,f.review);
  assert.deepEqual(await state(f),before,'read/repair retry does not refund twice or change the outcome');
 };

 const active=await seed(),reserved=await wallet(db,active.actor);
 await assert.rejects(archive(active),/^error: OPC_BUSINESS_BUSY$/,'a started review cannot be stopped via archive');
 assert.equal(await wallet(db,active.actor),reserved);assert.equal(reserved,950);
 const currentArchive=(await db.query("SELECT pg_get_functiondef('opc_business_archive(uuid,uuid)'::regprocedure) body")).rows[0].body;
 const oldArchive=read('packages/db/migrations/0324_paywall_profile_archive.sql')
  .match(/CREATE OR REPLACE FUNCTION public\.opc_business_archive\([\s\S]*?END \$\$;/)[0];
 try {
  await db.query(oldArchive);
  await assert.rejects(archive(active),/^error: OPC_BUSINESS_BUSY$/,'old 0324 archive RPC also respects active Review during rollout');
 } finally {await db.query(currentArchive);}

 const ongoing=await prepare(active,true),before=await state(active);
 await assert.rejects(archive(ongoing),/^error: OPC_BUSINESS_BUSY$/,'claimed but undispatched review still finishes normally');
 assert.deepEqual(await state(active),before);
 await deliver(active,ongoing.members,ongoing.calls,'Existing opinion');
 await rpc(db,'fusion_review_advance',active.actor,active.review,{round:1,phase:'review',attempt:1},
  {state:'completed',outcome:{kind:'no_change'}});
 assert.equal(await wallet(db,active.actor),1000);
 assert.equal((await archive(active)).isArchived,true,'review ends and settles, then archive succeeds');
 report.checks.push('Review cannot be stopped via archive before claim or dispatch; normal completion/fee settlement permits archive');

 const oldRead=await prepare(await seed());await legacy(oldRead);
 await rpc(db,'fusion_review_read',oldRead.actor,oldRead.review);
 await assertReleased(oldRead);
 const oldDispatch=await prepare(await seed());await legacy(oldDispatch);
 const call=oldDispatch.calls[0];
 assert.deepEqual(await rpc(db,'bill2_dispatch',oldDispatch.actor,call.runId,call.id,call.dispatchToken),
  {dispatch:false,archived:true});
 await assertReleased(oldDispatch);
 const oldBegin=await seed();await legacy(oldBegin);
 assert.equal((await rpc(db,'fusion_review_start',oldBegin.actor,oldBegin.request,oldBegin.source.draftId,oldBegin.version,{})).state,
  'incomplete','an archived replay ends/settles the original review before returning its view');
 await assertReleased(oldBegin);
 report.checks.push('legacy archived Review read, begin replay and direct dispatch repair all temporary/fixed holds once, no scheduler or manual stop');

 const racing=await prepare(await seed());await legacy(racing);
 const [viewer,sender]=await Promise.all([connect(),connect()]),pending=racing.calls[0];
 const [,refusal]=await Promise.all([
  rpc(viewer,'fusion_review_read',racing.actor,racing.review),
  rpc(sender,'bill2_dispatch',racing.actor,pending.runId,pending.id,pending.dispatchToken),
 ]);
 assert.deepEqual(refusal,{dispatch:false,archived:true});await assertReleased(racing);
 report.checks.push('concurrent legacy Review read/dispatch releases all fixed and temporary holds exactly once');

 const delivered=await prepare(await seed());await deliver(delivered,delivered.members,delivered.calls,'Saved opinions');
 await rpc(db,'fusion_review_advance',delivered.actor,delivered.review,{round:1,phase:'review',attempt:1},
  {state:'running',round:1,phase:'summary',attempt:1});
 const summary=await createFixture(db,{actor:delivered.actor,phase:'fusion_summary'});
 const summaryGroup=await rpc(db,'fusion_group_create',delivered.actor,randomUUID(),'review',delivered.source.sessionId);
 await rpc(db,'fusion_group_attach',delivered.actor,summaryGroup,summary.run);
 const summarized=await rpc(db,'fusion_review_claim',delivered.actor,delivered.review,1,'summary',1,summaryGroup,
  JSON.stringify([{runId:summary.run,sequence:1,payload:summary.claimPayload}]));
 await deliver(delivered,[summary],summarized.calls,'Saved revised report');await legacy(delivered);
 const finished=await rpc(db,'fusion_review_read',delivered.actor,delivered.review);
 assert.equal(finished.fee.state,'charged');assert.equal(finished.fee.chargedCredits,50);
 assert.equal(await wallet(db,delivered.actor),950,'already delivered revision retains its agreed fixed price');
 assert.equal((await rpc(db,'fusion_call_output_read',delivered.actor,summarized.calls[0].id)).body,'Saved revised report');
 const settled=await state(delivered);await rpc(db,'fusion_review_read',delivered.actor,delivered.review);
 assert.deepEqual(await state(delivered),settled);
 report.checks.push('legacy repair preserves delivered Review output, charges its fixed fee once and never double-refunds');

 for(const verdict of [null,'revision_invalid']) {
 const saved=await seed();
 await rpc(db,'fusion_review_advance',saved.actor,saved.review,{round:1,phase:'review',attempt:1},
  {state:'running',round:1,phase:'summary',attempt:1});
 const savedRun=await createFixture(db,{actor:saved.actor,phase:'fusion_summary'});
 const savedGroup=await rpc(db,'fusion_group_create',saved.actor,randomUUID(),'review',saved.source.sessionId);
 await rpc(db,'fusion_group_attach',saved.actor,savedGroup,savedRun.run);
 const savedBatch=await rpc(db,'fusion_review_claim',saved.actor,saved.review,1,'summary',1,savedGroup,
  JSON.stringify([{runId:savedRun.run,sequence:1,payload:savedRun.claimPayload}]));
 const savedCall=savedBatch.calls[0];
 await rpc(db,'bill2_dispatch',saved.actor,savedRun.run,savedCall.id,savedCall.dispatchToken);
 await receipt(db,savedRun,savedCall,'0.0004',{inputTokens:400,outputTokens:0});
 await rpc(db,'fusion_call_output_save',saved.actor,savedCall.id,'Saved revision before host verdict');
 if(verdict)await rpc(db,'fusion_call_verdict',saved.actor,savedCall.id,verdict);
 await legacy(saved);
 const savedView=await rpc(db,'fusion_review_read',saved.actor,saved.review);
 assert.equal(savedView.calls.find(call=>call.callId===savedCall.id).verdict,verdict??'unjudged_saved',
  'a saved body interrupted before verdict uses the existing saved-output recovery policy');
 assert.equal(savedView.fee.state,verdict?'refunded':'charged');assert.equal(savedView.fee.chargedCredits,verdict?0:50);
 assert.equal(await wallet(db,saved.actor),verdict?1000:950);
 assert.equal((await rpc(db,'fusion_call_output_read',saved.actor,savedCall.id)).body,'Saved revision before host verdict');
 assert.equal(Number((await db.query('SELECT count(*) n FROM bill2_calls c JOIN bill2_runs br ON br.id=c.run_id WHERE br.actor_id=$1 AND c.settled_at IS NULL',[saved.actor])).rows[0].n),0);
 const savedState=await state(saved);await rpc(db,'fusion_review_read',saved.actor,saved.review);
 assert.deepEqual(await state(saved),savedState,'saved summary cleanup never repeats its fixed charge');
 }
 report.checks.push('legacy saved/unjudged summary retains recovery verdict/output/fixed fee; judged invalid still refunds, no stranded holds or duplicate charges');

 const migrating=await prepare(await seed());await legacy(migrating);
 const frozen=await state(migrating),migration=read('packages/db/migrations/0326_paywall_fusion_archive_fence.sql');
 await assert.rejects(db.query(migration.replace(/COMMIT;\s*$/,
  ()=>"DO $$ BEGIN RAISE EXCEPTION 'REVIEW_ARCHIVE_REPAIR_ROLLBACK'; END $$; COMMIT;")),/REVIEW_ARCHIVE_REPAIR_ROLLBACK/);
 await db.query('ROLLBACK');assert.deepEqual(await state(migrating),frozen,'interrupted repair restores holds, records and ledger');
 await db.query(migration);await assertReleased(migrating);
 const fixed=await state(migrating);await db.query(migration);assert.deepEqual(await state(migrating),fixed);
 assert.equal((await db.query("SELECT has_function_privilege('service_role','fusion_review_archive_reconcile(uuid,jsonb)','execute') yes")).rows[0].yes,false);
 report.checks.push('migration repairs pre-0326 archived Review holds transactionally and repeatably; private financial helper is not callable by service clients');
}
