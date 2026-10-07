/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture,call,evidence,closeAccount,outcome} from '../erasure-b2a/cases.mjs';
import {createFixture,claim,receipt} from '../payg/fixture.mjs';
export const scrub=(db,f)=>rpc(db,'account_erasure_scrub_calls',f.actor,f.run);
export const row=async(db,f)=>(await db.query('SELECT * FROM bill2_calls WHERE run_id=$1 ORDER BY sequence',[f.run])).rows;
const financial=rows=>rows.map(({payload,content_erased_at,...rest})=>rest);
const money=async(db,f)=>JSON.stringify((await db.query(`SELECT
 (SELECT to_jsonb(r) FROM bill2_runs r WHERE id=$1) run,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_transactions t WHERE user_id=$2) ledger,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM billing_history t WHERE user_id=$2) history,
 (SELECT credits FROM profiles WHERE id=$2) credits`,[f.run,f.actor])).rows);

export async function runCases(db,report){
 for(const version of ['v1','v2']){
  const f=version==='v1'?await fixture(db):await createFixture(db,{lookupSupported:true});
  const c=version==='v1'?await call(db,f):await claim(db,f);
  for(const role of ['anon','authenticated']){
   await db.query('SET ROLE '+role);await assert.rejects(scrub(db,f),/permission denied/);
   await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(scrub(db,f),/ACCOUNT_ERASURE_NOT_CLOSED/);
  await assert.rejects(rpc(db,'bill2_erasure_call_payload',{}),/permission denied/);
  await assert.rejects(db.query('UPDATE bill2_calls SET payload=payload WHERE id=$1',[c.id]),/permission denied/);
  await db.query('RESET ROLE');
  await db.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1",[f.actor]);
  await assert.rejects(scrub(db,f),/ACCOUNT_ERASURE_NOT_CLOSED/);
  await db.query("UPDATE profiles SET status='active',is_deleted='false' WHERE id=$1",[f.actor]);
  const original=(await row(db,f))[0].payload;
  await db.query(`UPDATE bill2_calls SET payload=payload ||
   '{"input":{"text":"PRIVATE_CALL"},"sourceHash":"PRIVATE_CALL","extra":"PRIVATE_CALL"}'::jsonb
   WHERE id=$1`,[c.id]);
  if(version==='v2')await db.query(`UPDATE bill2_calls SET payload=jsonb_set(payload,'{payg,nominalPricing}',
   payload#>'{payg,nominalPricing}' || '{"body":"PRIVATE_CALL"}') WHERE id=$1`,[c.id]);
  await closeAccount(db,f);
  await assert.rejects(scrub(db,{...f,actor:randomUUID()}),/RUN_DENIED/);
  assert.deepEqual(await scrub(db,f),{processed:0,remaining:1,reason:'call_set_open'});
  await rpc(db,'bill2_close',f.actor,f.run,'unknown',null);
  const before=await row(db,f),beforeMoney=await money(db,f);
  await db.query('SET ROLE service_role');
  assert.deepEqual(await scrub(db,f),{processed:1,remaining:0});
  assert.deepEqual(await scrub(db,f),{processed:0,remaining:0});
  await db.query('RESET ROLE');
  const after=await row(db,f);
  assert.deepEqual(after[0].payload,original,'all frozen call fields preserve original representation');
  assert.deepEqual(financial(after),financial(before));
  assert.equal(await money(db,f),beforeMoney,'scrub does not settle, refund or mutate run/ledger');
  assert.doesNotMatch(JSON.stringify(after),/PRIVATE_CALL/);
  await assert.rejects(db.query('UPDATE bill2_calls SET payload=$2 WHERE id=$1',[c.id,before[0].payload]),/ERASURE_IMMUTABLE/);
  await assert.rejects(db.query('UPDATE bill2_calls SET content_erased_at=NULL WHERE id=$1',[c.id]),/ERASURE_IMMUTABLE/);
  await assert.rejects(rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken),/DENIED|CLOSED/);
  const pending=await rpc(db,'bill2_finalize',f.actor,f.run);
  if(version==='v1')assert.equal(pending.chargedCredits,null);
  assert.equal((await row(db,f))[0].selected_cost_usd,null);
  if(version==='v1')await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c));
  else await receipt(db,f,c);
  await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);
  assert.equal((await rpc(db,'bill2_finalize',f.actor,f.run)).state,'settled');
  const settled=await money(db,f);
  await rpc(db,'bill2_finalize',f.actor,f.run);
  assert.equal(await money(db,f),settled);
  assert.doesNotMatch(JSON.stringify(await row(db,f)),/PRIVATE_CALL/);
  report.checks.push(version+': permissions, real closure, recursive projection, unchanged financial facts, no refill, late settlement');
 }
 const f=await fixture(db),c=await call(db,f);
 await closeAccount(db,f);await rpc(db,'bill2_close',f.actor,f.run,'confirmed_failure',
  {...outcome,kind:'confirmed_delivery_failure'});
 await scrub(db,f);assert.equal((await rpc(db,'bill2_finalize',f.actor,f.run)).state,'refunded');
 await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c,'0.002'));
 assert.equal((await rpc(db,'bill2_finalize',f.actor,f.run)).chargedCredits,0);
 assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits,100);
 report.checks.push('confirmed failure refund once; late cost never re-debits');
 const runtime=await createFixture(db,{lookupSupported:true});
 const execution=(await db.query('SELECT b2a_test.bind($1) v',[runtime])).rows[0].v;
 const rc=await claim(db,runtime);
 await closeAccount(db,runtime);await rpc(db,'bill2_close',runtime.actor,runtime.run,'unknown',null);
 const originalRuntime=(await row(db,runtime))[0].payload;
 await scrub(db,runtime);
 assert.deepEqual((await row(db,runtime))[0].payload,originalRuntime);
 await receipt(db,runtime,rc);
 await rpc(db,'bill2_close',runtime.actor,runtime.run,'delivered',outcome);
 await rpc(db,'bill2_finalize',runtime.actor,runtime.run);
 await rpc(db,'runtime_financial_recovery',runtime.actor,execution,true);
 assert.equal((await db.query('SELECT state FROM runtime_executions WHERE id=$1',[execution])).rows[0].state,'cancelled');
 report.checks.push('bound v2 runtime epoch/request identity and original financial recovery survive projection');
 const admin=randomUUID(),reviewed=await createFixture(db),ac=await claim(db,reviewed);
 await db.query("INSERT INTO profiles(id,role,status,credits) VALUES($1,'admin','active',0)",[admin]);
 await receipt(db,reviewed,ac,'0.001',{});await rpc(db,'bill2_finalize',reviewed.actor,reviewed.run);
 await db.query(`UPDATE bill2_calls SET payload=payload || '{"extra":"PRIVATE_CALL"}' WHERE id=$1`,[ac.id]);
 const snap=await rpc(db,'bill2_payg_metering_review_snapshot',admin,ac.id);
 const review={expectedEvidenceHash:snap.evidenceHash,profileVersion:snap.profileVersion,
  evidenceVersion:snap.evidenceVersion,reviewReference:'Synthetic revalidation',humanReviewed:true};
 const reviewId=randomUUID();
 await rpc(db,'bill2_payg_review_metering',admin,ac.id,reviewId,review);
 await closeAccount(db,reviewed);await rpc(db,'bill2_close',reviewed.actor,reviewed.run,'unknown',null);
 const audit=(await db.query('SELECT * FROM user_activity_logs WHERE id=$1',[reviewId])).rows[0];
 const facts=financial(await row(db,reviewed)).map(({metering_review_audit_id,...v})=>v);
 const reviewedMoney=await money(db,reviewed);
 await scrub(db,reviewed);
 assert.equal((await row(db,reviewed))[0].metering_review_audit_id,null);
 assert.deepEqual(financial(await row(db,reviewed)).map(({metering_review_audit_id,...v})=>v),facts);
 assert.equal(await money(db,reviewed),reviewedMoney);
 assert.deepEqual((await db.query('SELECT * FROM user_activity_logs WHERE id=$1',[reviewId])).rows[0],audit);
 const fresh=await rpc(db,'bill2_payg_metering_review_snapshot',admin,ac.id);
 assert.notEqual(fresh.evidenceHash,snap.evidenceHash);
 await assert.rejects(rpc(db,'bill2_payg_review_metering',admin,ac.id,randomUUID(),review),/REVIEW_CONFLICT/);
 report.checks.push('existing metering review invalidates changed evidence; money/history unchanged and stale approval denied');
 const malformed=await fixture(db),mc=await call(db,malformed);
 await closeAccount(db,malformed);await rpc(db,'bill2_close',malformed.actor,malformed.run,'unknown',null);
 await db.query(`UPDATE bill2_calls SET payload=jsonb_set(payload,'{upperUsd}','{"body":"PRIVATE_CALL"}') WHERE id=$1`,[mc.id]);
 const unchanged=await row(db,malformed);
 await assert.rejects(scrub(db,malformed),/INVALID_FINANCIAL_FIELD/);
 assert.deepEqual(await row(db,malformed),unchanged);
 report.checks.push('malformed financial field fails atomically without false success');
}
