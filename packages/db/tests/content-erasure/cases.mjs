/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture,call,evidence,outcome,closeAccount} from '../erasure-b2a/cases.mjs';
export async function runtimeFixture(db,{dispatched=false,settled=false}={}) {
 const f=await fixture(db);
 f.execution=(await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
 f.session=(await db.query('SELECT session_id FROM runtime_executions WHERE id=$1',[f.execution])).rows[0].session_id;
 await db.query("UPDATE runtime_executions SET payload='{"+'"input":"KEEP_USER_QUESTION"'+"}' WHERE id=$1",[f.execution]);
 if(dispatched||settled)f.call=await call(db,f);
 if(settled){
  await rpc(db,'bill2_record',f.actor,f.run,f.call.id,evidence(f.call));
  await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);
  await rpc(db,'bill2_finalize',f.actor,f.run);
  await db.query("UPDATE runtime_executions SET result=$2,state='completed' WHERE id=$1",[f.execution,outcome]);
  await db.query('UPDATE runtime_sessions SET active_execution=NULL WHERE id=$1',[f.session]);
 }
 return f;
}
export const preview=(db,f,kind='answer',id=f.execution)=>rpc(db,'content_erasure_preview',f.actor,kind,id);
export const erase=async(db,f,kind='answer',id=f.execution,hash)=>rpc(db,'content_erasure_confirm',f.actor,kind,id,
 hash??(await preview(db,f,kind,id)).previewHash);
const money=async(db,f)=>(await db.query(`SELECT
 (SELECT credits FROM profiles WHERE id=$1) credits,
 (SELECT jsonb_agg((to_jsonb(x)-ARRAY['reason','metadata','content_erased_at'])||jsonb_build_object('metadata',erasure_ledger_metadata(x.metadata)) ORDER BY id) FROM billing_history x WHERE user_id=$1) history,
 (SELECT jsonb_agg((to_jsonb(x)-ARRAY['description','metadata','content_erased_at'])||jsonb_build_object('metadata',erasure_ledger_metadata(x.metadata)) ORDER BY id) FROM credit_transactions x WHERE user_id=$1) ledger`,[f.actor])).rows[0];
export async function runCases(db,report) {
 const f=await runtimeFixture(db,{settled:true});
 const before=await money(db,f);
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  await assert.rejects(preview(db,f),/permission denied/);
  await assert.rejects(erase(db,f,'answer',f.execution,'a'.repeat(64)),/permission denied/);
  await db.query('RESET ROLE');
 }
 const other=await fixture(db);
 await assert.rejects(preview(db,{...f,actor:other.actor}),/CONTENT_NOT_FOUND/);
 await assert.rejects(erase(db,{...f,actor:other.actor},'answer',f.execution,'a'.repeat(64)),/CONTENT_NOT_FOUND/);
 await assert.rejects(erase(db,f,'answer',f.execution,'a'.repeat(64)),/PREVIEW_CHANGED/);
 await db.query('SET ROLE service_role');
 assert.equal((await erase(db,f)).status,'deleted');
 assert.equal((await erase(db,f)).alreadyDeleted,true);
 await assert.rejects(rpc(db,'runtime_execution',f.actor,f.execution,'read',null),/CONTENT_ERASED/);
 await assert.rejects(rpc(db,'content_erasure_visible',f.actor,f.execution),/CONTENT_ERASED/);
 await db.query('RESET ROLE');
 assert.deepEqual(await money(db,f),before,'settled money is unchanged');
 const e=(await db.query('SELECT * FROM runtime_executions WHERE id=$1',[f.execution])).rows[0];
 assert.equal(e.payload.input,'KEEP_USER_QUESTION');assert.equal(e.result,null);assert.ok(e.content_deleted_at);
 assert.equal(await rpc(db,'bill2_erasure_closed',f.actor,f.pre),false,'open account is not relabelled closed');
 await assert.rejects(rpc(db,'runtime_admission_replay',f.actor,e.request_id,{}),/CONTENT_ERASED/);
 const receipt=(await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[f.call.id])).rows[0].payload;
 assert.doesNotMatch(JSON.stringify(receipt),/B2A_PRIVATE_CANARY|sdkResponse|rawBody/);
 report.checks.push('settled answer deletion, repeat, original prompt retained, read/replay refused, projection and exact money preservation');
 const pending=await runtimeFixture(db,{dispatched:true});
 const pendingBefore=await money(db,pending);
 assert.equal((await erase(db,pending)).status,'deleted');
 assert.equal((await db.query('SELECT state FROM runtime_executions WHERE id=$1',[pending.execution])).rows[0].state,'cost_pending');
 assert.deepEqual(await money(db,pending),pendingBefore,'unknown cost does not refund or charge');
 await rpc(db,'bill2_record',pending.actor,pending.run,pending.call.id,evidence(pending.call));
 await rpc(db,'runtime_financial_recovery',pending.actor,pending.execution,true);
 const late=(await db.query('SELECT payload FROM bill2_receipts WHERE call_id=$1',[pending.call.id])).rows[0].payload;
 assert.doesNotMatch(JSON.stringify(late),/B2A_PRIVATE_CANARY|sdkResponse|rawBody/);
 report.checks.push('dispatched unknown retains original reservation; late receipt records only financial projection');
 const session=await runtimeFixture(db,{settled:true});
 assert.equal((await erase(db,session,'session',session.session)).status,'deleted');
 await assert.rejects(rpc(db,'runtime_view',session.actor,session.session),/CONTENT_ERASED/);
 assert.equal((await db.query('SELECT payload FROM runtime_executions WHERE id=$1',[session.execution])).rows[0].payload,null);
 await closeAccount(db,session);
 const cleaned=await rpc(db,'account_erasure_scrub_runtime',session.actor);
 assert.notEqual(cleaned.retry,true);
 report.checks.push('whole session clears question and refuses view; account erasure can follow object deletion');
}
