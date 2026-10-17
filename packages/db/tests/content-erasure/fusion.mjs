/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW PR-3a (0235): deleting a whole positioning draft (artifact) also deletes the Fusion
// outputs started from that draft's conversation and scrubs the group's runs.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc} from '../erasure-b2a/cases.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {erase} from './cases.mjs';
export async function runFusion(db,report){
 const base=await fixture(db);
 const f=(await db.query('SELECT d7_test.artifacts($1) v',[base.actor])).rows[0].v;
 const session=(await db.query('SELECT session_id FROM opc_drafts WHERE actor_id=$1 AND project_id=$2',[f.actor,f.project])).rows[0].session_id;
 assert.ok(session,'the draft has its conversation');
 const run=await createFixture(db,{actor:f.actor,phase:'fusion_review'});
 await db.query('UPDATE profiles SET credits=credits+9 WHERE id=$1',[f.actor]);
 await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  SELECT id,9,'addition','grant','opening_grant','system','fusion-grant:'||id,credits-9,credits FROM profiles WHERE id=$1`,[f.actor]);
 const group=await rpc(db,'fusion_group_create',f.actor,randomUUID(),'review',session);
 await rpc(db,'fusion_group_attach',f.actor,group,run.run);
 const claimed=await rpc(db,'fusion_group_claim',f.actor,group,'review:1',1,
  JSON.stringify([{runId:run.run,sequence:1,payload:run.claimPayload}]));
 assert.equal(claimed.state,'claimed');
 const c=claimed.calls[0];
 assert.equal((await rpc(db,'bill2_dispatch',f.actor,run.run,c.id,c.dispatchToken)).dispatch,true);
 await rpc(db,'fusion_call_output_save',f.actor,c.id,'draft review body');
 assert.equal((await erase(db,f,'artifact',f.project)).status,'deleted');
 assert.equal((await db.query('SELECT count(*)::int n FROM fusion_call_outputs WHERE group_id=$1',[group])).rows[0].n,0,
  'deleting the draft deletes its Fusion outputs');
 assert.equal(await rpc(db,'fusion_call_output_read',f.actor,c.id),null);
 const r=(await db.query('SELECT content_deleted_at,closed FROM bill2_runs WHERE id=$1',[run.run])).rows[0];
 assert.ok(r.content_deleted_at&&r.closed,'the group run is marked and closed');
 report.checks.push('deleting a whole positioning draft deletes the Fusion outputs started from its conversation and closes the group runs');
}

// FUSION-COMPARE PR-1 (0284): a compare record is removed with its source conversation's draft, and a compare
// that froze a workspace source is removed (record, outputs, scrubbed runs) when that source is deleted, even
// when the compare lives in another conversation.
export async function runFusionCompare(db,report){
 const base=await fixture(db);
 const f=(await db.query('SELECT d7_test.artifacts($1) v',[base.actor])).rows[0].v;
 const draftSession=(await db.query('SELECT session_id FROM opc_drafts WHERE actor_id=$1 AND project_id=$2',[f.actor,f.project])).rows[0].session_id;
 const free=await rpc(db,'bill2_create_draft',f.actor);
 const other=(await db.query(`INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
  VALUES($1,jsonb_build_object('kind','positioning_draft','draftId',$2::uuid),gen_random_uuid(),'{}') RETURNING id`,[f.actor,free])).rows[0].id;
 const record=async(session,deps)=>(await db.query(`INSERT INTO fusion_compares(actor_id,request_id,session_id,history_revision,question,
  question_hash,request_hash,snapshot_hash,config,workspace_dependencies,state) VALUES($1,gen_random_uuid(),$2,0,'private compare question',
  repeat('a',64),repeat('b',64),repeat('c',64),'{"models":[]}',$3,'running') RETURNING id`,[f.actor,session,JSON.stringify(deps)])).rows[0].id;
 const inDraft=await record(draftSession,[]);
 const viaSource=await record(other,[{sourceVersionId:f.version}]);
 const unrelated=await record(other,[{sourceVersionId:randomUUID()}]);
 // The compare that froze the source has a group run in the other conversation.
 const run=await createFixture(db,{actor:f.actor,phase:'fusion_compare'});
 const group=await rpc(db,'fusion_group_create',f.actor,randomUUID(),'compare',other);
 await rpc(db,'fusion_group_attach',f.actor,group,run.run);
 await db.query('UPDATE fusion_compares SET group_id=$2 WHERE id=$1',[viaSource,group]);
 assert.equal((await db.query('SELECT content_erasure_references($1::jsonb,ARRAY[$2::uuid]) v',
  [JSON.stringify([{sourceVersionId:f.version}]),f.version])).rows[0].v,true,'the stored dependency format is recognised');
 assert.equal((await erase(db,f,'artifact',f.project)).status,'deleted');
 const left=(await db.query('SELECT id FROM fusion_compares WHERE actor_id=$1',[f.actor])).rows.map(r=>r.id);
 assert.ok(!left.includes(inDraft),'deleting the draft deletes compares started from its conversation');
 assert.ok(!left.includes(viaSource),'deleting a source deletes compares that froze it');
 assert.ok(left.includes(unrelated),'other compares stay');
 const r=(await db.query('SELECT content_deleted_at,closed FROM bill2_runs WHERE id=$1',[run.run])).rows[0];
 assert.ok(r.content_deleted_at&&r.closed,'the compare group run that copied the source is marked and closed');
 // A compare admission replay after the source deletion removed its record returns nothing.
 const groupRequest=(await db.query('SELECT request_id FROM fusion_billing_groups WHERE id=$1',[group])).rows[0].request_id;
 await db.query('SET ROLE service_role');
 try { await assert.rejects(db.query('SELECT fusion_group_admit($1,$2,$3,$4,$5)',[f.actor,groupRequest,'compare',other,'[]']),/FUSION_GROUP_DENIED/); }
 finally { await db.query('RESET ROLE'); }
 // The deleted source is no longer allowed, so a new compare cannot freeze it (fusion_compare_begin checks this).
 assert.equal((await db.query('SELECT opc_source_allowed($1,$2) v',[f.actor,f.version])).rows[0].v,false);
 report.checks.push('deleting a draft deletes its compares; deleting a workspace source deletes the compares (and scrubs their runs) that froze it, in any conversation');
}
