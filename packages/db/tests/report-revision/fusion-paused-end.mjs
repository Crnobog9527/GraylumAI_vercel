/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW paused-review expiry (0410, Owner 2026-10-27: "评审团暂停超过 24 小时，也自动结束并退还没用的押金"):
// a review paused for 24 hours is ended by the scheduled recovery through the same close path as the user's
// "end review" (state interrupted), so the held fixed fee settles by the existing rule. No model call.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {seed} from './cases.mjs';

const FEE = 1500;
const review = {enabled:true,reviewerModelIds:[],summaryModelId:null,skillId:null,maxRounds:2,opinionOutputTokens:4096,
  summaryOutputTokens:16384,maxBudgetUsd:'5',dispatchMinutes:10,breaker:{platformUsd:'2',noDeliveryCalls:10}};
const config = {estimateUsd:'0.5',maxRounds:2,fixedPrice:{credits:FEE,holdCredits:0}};
const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const ledger = async (db,actor) => Number((await db.query('SELECT coalesce(sum(amount),0) v FROM credit_transactions WHERE user_id=$1',[actor])).rows[0].v);
const fee = async (db,reviewId) => (await db.query('SELECT * FROM fusion_review_fees WHERE review_id=$1',[reviewId])).rows[0];
const state = async (db,reviewId) => (await db.query('SELECT state FROM fusion_reviews WHERE id=$1',[reviewId])).rows[0].state;
const releases = async (db,reviewId) => Number((await db.query(
  "SELECT count(*) v FROM credit_transactions WHERE idempotency_key=$1",['fusion-review:'+reviewId+':release'])).rows[0].v);
async function service(db,name,...args) {
  await db.query('SET ROLE service_role');
  try { return await rpc(db,name,...args); } finally { await db.query('RESET ROLE'); }
}
const start = (db,f) => service(db,'fusion_review_start',f.actor,randomUUID(),f.draft,f.versionId,config);
async function step(db,f) {
  const run = await createFixture(db,{actor:f.actor,phase:'fusion_review'});
  const group = await rpc(db,'fusion_group_create',f.actor,randomUUID(),'review',f.session);
  await rpc(db,'fusion_group_attach',f.actor,group,run.run);
  return {run,group,items:JSON.stringify([{runId:run.run,sequence:1,payload:run.claimPayload}])};
}
const claim = (db,f,rv,s) => service(db,'fusion_review_claim',f.actor,rv.reviewId,1,'review',1,s.group,s.items);
const endPaused = (db,idle='24 hours') => service(db,'fusion_review_end_paused',idle,100);
/** A gold member holding the fixed fee of a review that has been paused for `hours`. */
async function paused(db,hours) {
  const f = await seed(db);
  await db.query("UPDATE profiles SET membership_level='gold',credits=credits+5000 WHERE id=$1",[f.actor]);
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    SELECT id,5000,'addition','grant','opening_grant','system','paused-end:'||id,credits-5000,credits FROM profiles WHERE id=$1`,[f.actor]);
  const before = await wallet(db,f.actor);
  const rv = await start(db,f);
  assert.equal(await wallet(db,f.actor),before-FEE,'the fixed fee is held at start');
  await db.query("UPDATE fusion_reviews SET updated_at=now()-interval '2 hours' WHERE id=$1",[rv.reviewId]);
  assert.ok(await rpc(db,'fusion_review_pause_idle','1 hour')>=1);
  await db.query("UPDATE fusion_reviews SET updated_at=now()-($2::int||' minutes')::interval WHERE id=$1",[rv.reviewId,Math.round(hours*60)]);
  return {f,rv,before};
}

export async function runFusionPausedEnd({db,Client,connectionString,report}) {
  await db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify({version:1,review:review,compare:{enabled:false}})]);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO UPDATE SET allow_fusion_review=true`,[randomUUID()]);

  // 23 hours paused: nothing happens. 25 hours: ended as "interrupted", the unused fee comes back, ledger equals balance.
  const young = await paused(db,23);
  assert.equal((await endPaused(db)).ended,0,'23 hours paused is left alone');
  assert.equal(await state(db,young.rv.reviewId),'paused');assert.equal((await fee(db,young.rv.reviewId)).state,'held');
  await db.query("UPDATE fusion_reviews SET updated_at=now()-interval '25 hours' WHERE id=$1",[young.rv.reviewId]);
  const first = await endPaused(db);
  assert.equal(first.ended,1);assert.equal(first.failed,0);
  assert.equal(await state(db,young.rv.reviewId),'interrupted','ended through the user\'s "end review" state');
  const settled = await fee(db,young.rv.reviewId);
  assert.deepEqual({state:settled.state,charged:settled.charged_credits,reason:settled.settle_reason},{state:'refunded',charged:0,reason:'interrupted'});
  assert.equal(await wallet(db,young.f.actor),young.before,'the unused fee is refunded in full');
  assert.equal(await ledger(db,young.f.actor),await wallet(db,young.f.actor),'ledger sum equals balance');
  // Repeatable: a second run ends nothing and settles nothing twice.
  assert.equal((await endPaused(db)).ended,0);
  assert.equal(await releases(db,young.rv.reviewId),1,'one release row only');
  assert.equal(await wallet(db,young.f.actor),young.before);
  // The user can start again afterwards (the slot is free).
  assert.equal((await start(db,young.f)).state,'running');
  report.checks.push('paused review: 23 hours untouched; 25 hours ended as interrupted with the full fee refunded; second run changes nothing');

  // A review resumed by a claim is running again and is never ended; its age restarts.
  const resumed = await paused(db,25);
  const s1 = await step(db,resumed.f);
  await claim(db,resumed.f,resumed.rv,s1);
  assert.equal(await state(db,resumed.rv.reviewId),'running');
  assert.equal((await endPaused(db)).ended,0,'a resumed review is not ended');
  assert.equal((await fee(db,resumed.rv.reviewId)).state,'held');
  report.checks.push('paused review resumed by a claim is not ended');

  // The boundary: the user continues at the moment the expiry runs. Whichever takes the review lock first wins, once.
  const clients = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(c=>c.connect()));
  try {
    await clients[0].query('SET ROLE service_role');await clients[1].query('SET ROLE service_role');
    // (a) The claim holds the lock: the expiry skips the review instead of waiting, and the review keeps running.
    const a = await paused(db,25);
    const sa = await step(db,a.f);
    await clients[0].query('BEGIN');
    await rpc(clients[0],'fusion_review_claim',a.f.actor,a.rv.reviewId,1,'review',1,sa.group,sa.items);
    assert.equal((await rpc(clients[1],'fusion_review_end_paused','24 hours',100)).ended,0,'a locked review is skipped, not waited for');
    await clients[0].query('COMMIT');
    assert.equal(await state(db,a.rv.reviewId),'running');assert.equal((await fee(db,a.rv.reviewId)).state,'held');
    // (b) The expiry holds the lock: the claim then finds the review ended and is refused; nothing is settled twice.
    const b = await paused(db,25);
    const sb = await step(db,b.f);
    await clients[0].query('BEGIN');
    assert.equal((await rpc(clients[0],'fusion_review_end_paused','24 hours',100)).ended,1);
    const late = rpc(clients[1],'fusion_review_claim',b.f.actor,b.rv.reviewId,1,'review',1,sb.group,sb.items).then(()=>'claimed',e=>e.message);
    await new Promise(resolve=>setTimeout(resolve,300));
    await clients[0].query('COMMIT');
    assert.match(await late,/FUSION_REVIEW_ENDED/);
    assert.equal(await state(db,b.rv.reviewId),'interrupted');assert.equal(await releases(db,b.rv.reviewId),1);
    assert.equal(await wallet(db,b.f.actor),b.before);assert.equal(await ledger(db,b.f.actor),await wallet(db,b.f.actor));
    // (c) Two expiry runs at once: one ends it, the other finds nothing to do.
    const c = await paused(db,25);
    const both = await Promise.all(clients.map(x=>rpc(x,'fusion_review_end_paused','24 hours',100).then(r=>r.ended,e=>e.message)));
    assert.deepEqual(both.filter(v=>typeof v==='string'),[],'no error');
    assert.equal(both.reduce((n,v)=>n+v,0),1,'ended exactly once');
    assert.equal(await releases(db,c.rv.reviewId),1);assert.equal(await wallet(db,c.f.actor),c.before);
  } finally { await Promise.all(clients.map(c=>c.end())); }
  report.checks.push('paused review: a claim and the expiry race to one winner; concurrent expiry runs settle once; ledger equals balance');

  // Only the service role can run it.
  await db.query('SET ROLE authenticated');
  await assert.rejects(rpc(db,'fusion_review_end_paused','24 hours',100),/permission denied/);
  await db.query('RESET ROLE');
  report.checks.push('fusion_review_end_paused is service-role only');
}
