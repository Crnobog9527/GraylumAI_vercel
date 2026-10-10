/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture,closeAccount} from '../erasure-b2a/cases.mjs';
import {runtimeFixture,erase,preview} from '../content-erasure/cases.mjs';
const count=async(db,a)=>(await db.query('SELECT count(*)::int n FROM opc_data_events WHERE actor_id=$1',[a])).rows[0].n;
const reaction=(db,f,rid=randomUUID(),action='rewrite',reason='R9_PRIVATE_REASON')=>
 rpc(db,'opc_content_reaction',f.actor,rid,f.execution,action,reason);
export async function runCases(db,report){
 const f=await runtimeFixture(db,{settled:true}),rid=randomUUID();
 const first=await reaction(db,f,rid);
 assert.equal(first.recorded,true);assert.ok(first.createdAt);
 assert.deepEqual(await reaction(db,f,rid),first);assert.equal(await count(db,f.actor),1);
 await assert.rejects(reaction(db,f,rid,'abandon'),/OPC_REQUEST_CONFLICT/);
 await assert.rejects(reaction(db,f,randomUUID(),'not_useful'),/OPC_DATA_EVENT_INVALID/);
 await assert.rejects(reaction(db,f,randomUUID(),'rewrite','x'.repeat(1001)),/OPC_DATA_EVENT_INVALID/);
 const other=await fixture(db);
 await assert.rejects(reaction(db,{...f,actor:other.actor}),/OPC_DATA_SOURCE_DENIED/);
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  await assert.rejects(reaction(db,f),/permission denied/);
  await assert.rejects(db.query('SELECT * FROM opc_data_events'),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 await assert.rejects(db.query('SELECT * FROM opc_data_events'),/permission denied/);
 await assert.rejects(rpc(db,'opc_data_execution',f.actor,f.execution),/permission denied/);
 assert.equal((await reaction(db,f,randomUUID(),'abandon')).recorded,true);
 await db.query('RESET ROLE');
 report.checks.push('explicit rewrite/abandon, exact replay, conflict, invalid input, foreign actor, raw-table/helper denial');
 const stale=await preview(db,f);
 await reaction(db,f);
 await assert.rejects(erase(db,f,'answer',f.execution,stale.previewHash),/PREVIEW_CHANGED/);
 await erase(db,f);assert.equal(await count(db,f.actor),0);
 await assert.rejects(reaction(db,f,rid),/OPC_DATA_SOURCE_DENIED/);
 assert.equal((await erase(db,f)).alreadyDeleted,true);
 report.checks.push('new event changes D7 preview; answer erasure removes signals; replay cannot revive erased data');
 const g=await runtimeFixture(db,{settled:true});
 await reaction(db,g);await closeAccount(db,g);
 await assert.rejects(reaction(db,g),/ACCOUNT|ERAS|ACTOR/);
 const scrub=await rpc(db,'account_erasure_scrub_content',g.actor);
 assert.notEqual(scrub.retry,true);assert.equal(await count(db,g.actor),0);
 report.checks.push('account closure rejects new events and existing content scrub physically removes all R9 rows');
 await testTopics(db,report);
 await testTopics(db,report,true);
 // Relevant record families now all have creation time columns; legacy unknowns are not fabricated.
 const missing=(await db.query(`SELECT table_name FROM information_schema.tables t WHERE table_schema='public'
  AND (table_name LIKE 'opc_%' OR table_name LIKE 'artifact_%' OR table_name LIKE 'runtime_%')
  AND table_type='BASE TABLE' AND NOT EXISTS(SELECT 1 FROM information_schema.columns c
   WHERE c.table_schema=t.table_schema AND c.table_name=t.table_name AND c.column_name='created_at')`)).rows;
 assert.deepEqual(missing,[]);
 report.checks.push('all audited OPC/artifact/runtime base tables have creation timestamps');
}
async function testTopics(db,report,legacy=false){
 const f=await runtimeFixture(db,{settled:true});
 const art=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const d=(await db.query('SELECT * FROM opc_drafts WHERE project_id=$1',[art.project])).rows[0];
 await db.query(`INSERT INTO opc_topic_workspaces(draft_id,actor_id,request_id,source_version_id,source_hash,
  module_id,skill_id,revision_id,package_hash,session_id,material_revision)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)`,
 [d.draft_id,f.actor,randomUUID(),art.version,'e'.repeat(64),art.module,art.skill,art.revision,'b'.repeat(64),f.session]);
 const account=(await db.query('SELECT * FROM opc_accounts WHERE actor_id=$1',[f.actor])).rows[0];
 const original=[{id:randomUUID(),platform:account.platform,account:account.account_key,
  title:'R9_AI_ORIGINAL',brief:'R9_AI_BRIEF',day:'2026-10-10',contentType:'article'}];
 await db.query('UPDATE runtime_executions SET result=$2 WHERE id=$1',
 [f.execution,{kind:'usable_result',body:'Proposal\n```json\n'+JSON.stringify(original)+'\n```'}]);
 const saved={...original[0],title:'R9_USER_EDIT'};
 const saveId=legacy?f.execution:randomUUID();
 const save=()=>legacy
  ?rpc(db,'opc_topic_draft_save',f.actor,d.draft_id,saveId,0,art.version,JSON.stringify([saved]))
  :rpc(db,'opc_topic_draft_from_execution',f.actor,d.draft_id,saveId,0,art.version,f.execution,JSON.stringify([saved]));
 assert.equal((await save()).version,1);assert.equal((await save()).version,1);
 const stored=(await db.query('SELECT * FROM opc_data_events WHERE actor_id=$1 AND request_id=$2',[f.actor,saveId])).rows[0];
 if(legacy)assert.equal(stored,undefined);
 else {
  assert.equal(stored.original[0].title,'R9_AI_ORIGINAL');assert.equal(stored.adopted[0].title,'R9_USER_EDIT');
  assert.ok(stored.created_at);
 }
 await assert.rejects(rpc(db,'opc_topic_draft_from_execution',f.actor,d.draft_id,randomUUID(),1,art.version,f.execution,
  JSON.stringify([{...saved,id:randomUUID()}])),/OPC_TOPIC_SOURCE_INVALID/);
 const adoptId=randomUUID(),accounts=[{platform:account.platform,account:account.account_key,expectedRevision:account.revision}];
 const adopt=()=>rpc(db,'opc_adopt_topics_with_source',f.actor,d.draft_id,adoptId,1,art.version,JSON.stringify([saved]),JSON.stringify(accounts),null);
 await assert.rejects(rpc(db,'opc_adopt_topics_with_source',f.actor,d.draft_id,randomUUID(),1,art.version,
  JSON.stringify([saved]),JSON.stringify(accounts),'[]'),/OPC_TOPIC_SOURCE_INVALID/);
 const adopted=await adopt();assert.ok(adopted.planId);assert.deepEqual(await adopt(),adopted);
 const event=(await db.query("SELECT * FROM opc_data_events WHERE actor_id=$1 AND action='topic_adoption'",[f.actor])).rows[0];
 assert.equal(event.execution_id,f.execution);assert.equal(event.original.title,'R9_AI_ORIGINAL');
 assert.equal(event.adopted.title,'R9_USER_EDIT');assert.ok(event.target_project_id);
 await erase(db,f);
 assert.equal(await count(db,f.actor),0);
 assert.equal((await db.query('SELECT body FROM opc_topic_draft_versions WHERE request_id=$1',[saveId])).rows[0].body,null);
 assert.equal((await db.query('SELECT brief FROM opc_items WHERE work_item_id=$1',[event.target_project_id])).rows[0].brief,'R9_AI_BRIEF');
 await assert.rejects(adopt(),/OPC_TOPIC_SOURCE|OPC_DATA_SOURCE/);
 report.checks.push((legacy?'legacy request/execution binding: ':'new snapshot binding: ')+'topic source server extraction, user edits distinct, foreign IDs denied, adoption and replay, D7 removes source copies but preserves saved work');
}
