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
