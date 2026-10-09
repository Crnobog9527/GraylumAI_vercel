/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixture,claim} from '../payg/fixture.mjs';
import {rpc,fixture,call,evidence,closeAccount,outcome} from '../erasure-b2a/cases.mjs';
export const detach=(db,f)=>rpc(db,'account_erasure_detach_runtime',f.actor,f.run);
export async function ready(db, {settle=true,scrub=true,version='v1',refund=false}={}) {
 const f=version==='v1'?await fixture(db):await createFixture(db);
 f.execution=(await db.query('SELECT b2a_test.bind($1) v',[f])).rows[0].v;
 f.session=(await db.query('SELECT session_id FROM runtime_executions WHERE id=$1',[f.execution])).rows[0].session_id;
 f.call=version==='v1'?await call(db,f):await claim(db,f);
 f.evidence=evidence(f.call,'0.0001',version==='v2'?{model:f.claimPayload.model,usage:{inputTokens:10,outputTokens:0}}:{});
 await closeAccount(db,f);
 if(settle) {
  await rpc(db,'bill2_record',f.actor,f.run,f.call.id,f.evidence);
  await rpc(db,'bill2_close',f.actor,f.run,refund?'confirmed_failure':'delivered',refund?{...outcome,kind:'confirmed_delivery_failure'}:outcome);
 }
 f.terminal=(await rpc(db,'runtime_financial_recovery',f.actor,f.execution,true)).state;
 if(scrub) {
  assert.notEqual((await rpc(db,'account_erasure_scrub_runtime',f.actor)).retry,true);
  await rpc(db,'account_erasure_scrub_run',f.actor,f.run);
  await rpc(db,'account_erasure_scrub_calls',f.actor,f.run);
  await rpc(db,'account_erasure_scrub_receipts',f.actor,f.run,100);
 }
 return f;
}
const money=async(db,f)=>JSON.stringify((await db.query(`SELECT
 (SELECT credits FROM profiles WHERE id=$1) credits,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_transactions t WHERE user_id=$1) ledger,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM billing_history t WHERE user_id=$1) history`,[f.actor])).rows);
export async function runCases(db,report) {
 const active=await fixture(db);
 for(const role of ['anon','authenticated']) {
  await db.query('SET ROLE '+role);await assert.rejects(detach(db,active),/permission denied/);await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');
 await assert.rejects(detach(db,active),/ACCOUNT_ERASURE_NOT_CLOSED/);
 await db.query('RESET ROLE');
 const unknown=await ready(db,{settle:false});
 assert.equal((await detach(db,unknown)).reason,'billing_pending');
 const pending=await ready(db,{scrub:false});
 assert.equal((await detach(db,pending)).reason,'content_pending');
 for(const version of ['v1','v2']) for(const refund of [false,true]) {
 const f=await ready(db,{version,refund}), before=await money(db,f);
 await assert.rejects(detach(db,{...f,actor:randomUUID()}),/RUN_DENIED/);
 await assert.rejects(db.query('UPDATE bill2_runs SET session_ref=NULL WHERE id=$1',[f.run]),/IMMUTABLE_BINDING/);
 await db.query('SET ROLE service_role');
 assert.deepEqual(await detach(db,f),{processed:1,remaining:0});
 assert.deepEqual(await detach(db,f),{processed:0,remaining:0});
 assert.equal(await rpc(db,'runtime_receipt_saved',f.actor,f.execution,f.run,f.call.id,f.evidence),true);
 await db.query('RESET ROLE');
 const r=(await db.query('SELECT session_ref,erased_session_id,erased_execution_id FROM bill2_runs WHERE id=$1',[f.run])).rows[0];
 assert.deepEqual(r,{session_ref:null,erased_session_id:f.session,erased_execution_id:f.execution});
 for(const query of ['erased_session_id=NULL','erased_execution_id=NULL','erased_execution_id=gen_random_uuid()',
  'session_ref=erased_session_id','actor_id=gen_random_uuid()']) {
  await assert.rejects(db.query('UPDATE bill2_runs SET '+query+' WHERE id=$1',[f.run]),/IMMUTABLE_BINDING/);
 }
 // Physical removal is only a local synthetic test, proving the FK no longer blocks PR-C.
 await db.query('DELETE FROM runtime_executions WHERE id=$1',[f.execution]);
 await db.query('DELETE FROM runtime_sessions WHERE id=$1',[f.session]);
 await db.query('SET ROLE service_role');
 assert.equal(await rpc(db,'runtime_receipt_saved',f.actor,f.execution,f.run,f.call.id,f.evidence),true);
 assert.equal(await rpc(db,'runtime_receipt_saved',f.actor,f.execution,f.run,f.call.id,{...f.evidence,cost:'0.5'}),false);
 await assert.rejects(rpc(db,'runtime_receipt_saved',f.actor,randomUUID(),f.run,f.call.id,f.evidence),/BINDING_DENIED/);
 await assert.rejects(rpc(db,'runtime_receipt_saved',randomUUID(),f.execution,f.run,f.call.id,f.evidence),/BINDING_DENIED/);
 assert.equal((await rpc(db,'runtime_financial_recovery',f.actor,f.execution,true)).state,f.terminal);
 await rpc(db,'bill2_record',f.actor,f.run,f.call.id,f.evidence);
 await db.query('RESET ROLE');
 assert.equal(await money(db,f),before);
 }
 report.checks.push('v1/v2 roles/cross-subject rejected; unknown/body pending; one-way detach; original receipt/recovery after physical removal; money unchanged');
}
