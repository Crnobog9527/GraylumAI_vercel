/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW PR-4a (0236): the review record — start, claim inside the review lock, advance, stop/end,
// idle pause, in-flight risk, breaker, version block and erasure. No model call.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {seed} from './cases.mjs';

const review = {enabled:true,reviewerModelIds:[],summaryModelId:null,skillId:null,maxRounds:2,opinionOutputTokens:4096,
  summaryOutputTokens:16384,maxBudgetUsd:'1',dispatchMinutes:10,breaker:{platformUsd:'2',noDeliveryCalls:10}};
const settings = (db,patch={}) => db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify({version:1,review:{...review,...patch},compare:{enabled:false}})]);
const config = {estimateUsd:'0.5',maxRounds:2};
const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
// The service role is the production caller (membership facts are service-role only).
async function service(db,name,...args) {
  await db.query('SET ROLE service_role');
  try { return await rpc(db,name,...args); } finally { await db.query('RESET ROLE'); }
}
const start = (db,f,request=randomUUID(),cfg=config,version=f.versionId) => service(db,'fusion_review_start',f.actor,request,f.draft,version,cfg);

// One isolated group run bound to the review's conversation, ready to claim through the review.
async function step(db,f) {
  const run = await createFixture(db,{actor:f.actor,phase:'fusion_review'});
  const group = await rpc(db,'fusion_group_create',f.actor,randomUUID(),'review',f.session);
  await rpc(db,'fusion_group_attach',f.actor,group,run.run);
  return {run,group,items:JSON.stringify([{runId:run.run,sequence:1,payload:run.claimPayload}])};
}
const claim = (db,f,rv,s,round=1,phase='review',attempt=1) =>
  service(db,'fusion_review_claim',f.actor,rv.reviewId,round,phase,attempt,s.group,s.items);

export async function runFusionReview({db,Client,connectionString,report}) {
  const f = await seed(db);
  await db.query("UPDATE profiles SET membership_level='gold',credits=credits+50 WHERE id=$1",[f.actor]);
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    SELECT id,50,'addition','grant','opening_grant','system','fusion-review:'||id,credits-50,credits FROM profiles WHERE id=$1`,[f.actor]);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO UPDATE SET allow_fusion_review=true`,[randomUUID()]);

  // Start: switch, freshness, frozen materials copied from the version's round, idempotent by request.
  await settings(db,{enabled:false});
  await assert.rejects(start(db,f),/FUSION_REVIEW_DISABLED/);
  await settings(db);
  await assert.rejects(start(db,f,randomUUID(),config,randomUUID()),/FUSION_REVIEW_STALE/);
  await assert.rejects(start(db,f,randomUUID(),{...config,estimateUsd:'2'}),/FUSION_BUDGET_EXCEEDED/);
  const request = randomUUID();
  const rv = await start(db,f,request);
  assert.equal(rv.state,'running');assert.deepEqual([rv.round,rv.phase,rv.attempt],[1,'review',1]);
  assert.deepEqual(rv.materials.a.who,{value:'Busy parents',status:'confirmed'});
  assert.deepEqual(rv.materials.a.pain,{value:'No time',status:'deferred'});
  assert.match(rv.materialsHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(await start(db,f,request),rv,'same request returns the same review');
  await assert.rejects(start(db,f),/FUSION_REVIEW_ACTIVE/,'one review in progress per user');
  // The copy lives on the record (a published round is immutable; later edits open a new round).
  const reread = await service(db,'fusion_review_read',f.actor,rv.reviewId);
  assert.deepEqual(reread.materials,rv.materials);assert.equal(reread.materialsHash,rv.materialsHash);
  report.checks.push('review start: switch, stale version and budget refused; materials frozen from the version round; idempotent; one per user');

  // Claim inside the review lock; position compare-and-set; advance to summary then complete.
  const s1 = await step(db,f);
  await assert.rejects(claim(db,f,rv,s1,1,'summary'),/FUSION_REVIEW_STEP_CONFLICT/);
  const c1 = await claim(db,f,rv,s1);
  assert.equal(c1.state,'claimed');
  assert.equal((await claim(db,f,rv,s1)).calls[0].id,c1.calls[0].id,'replayed claim returns the same call');
  const view = await service(db,'fusion_review_read',f.actor,rv.reviewId);
  assert.equal(view.steps.length,1);assert.equal(view.calls.length,1);assert.equal(view.calls[0].dispatched,false);
  const from = {round:1,phase:'review',attempt:1};
  await assert.rejects(service(db,'fusion_review_advance',f.actor,rv.reviewId,{...from,round:2},{state:'running',round:1,phase:'summary',attempt:1}),
    /FUSION_REVIEW_STEP_CONFLICT/);
  await assert.rejects(service(db,'fusion_review_advance',f.actor,rv.reviewId,from,{state:'running',round:3,phase:'review',attempt:1}),
    /FUSION_REVIEW_INVALID/,'cannot pass the frozen round limit');
  const moved = await service(db,'fusion_review_advance',f.actor,rv.reviewId,from,{state:'running',round:1,phase:'summary',attempt:1});
  assert.deepEqual([moved.round,moved.phase],[1,'summary']);
  report.checks.push('claims run inside the review lock at the current position only; replay returns the same call; advance is compare-and-set');

  // Stop: end state, undispatched hold released, no later claim or advance; repeat returns the same state.
  const held = await wallet(db,f.actor);
  const stopped = await service(db,'fusion_review_close',f.actor,rv.reviewId,'stopped');
  assert.equal(stopped.state,'stopped');
  assert.ok(await wallet(db,f.actor)>held,'undispatched hold released');
  assert.equal((await service(db,'fusion_review_close',f.actor,rv.reviewId,'stopped')).state,'stopped');
  await assert.rejects(service(db,'fusion_review_close',f.actor,rv.reviewId,'interrupted'),/FUSION_REVIEW_ENDED/);
  await assert.rejects(claim(db,f,rv,await step(db,f),1,'summary'),/FUSION_REVIEW_ENDED/);
  await assert.rejects(service(db,'fusion_review_advance',f.actor,rv.reviewId,{round:1,phase:'summary',attempt:1},
    {state:'completed',outcome:{kind:'no_change'}}),/FUSION_REVIEW_ENDED/);
  report.checks.push('stop ends the review in one transaction, releases undispatched holds, and refuses any later claim or advance');

  // In-flight risk: a dispatched, unsettled Fusion call keeps the slot after a stop.
  const rv2 = await start(db,f);
  const s2 = await step(db,f);
  const c2 = await claim(db,f,rv2,s2);
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,s2.run.run,c2.calls[0].id,c2.calls[0].dispatchToken)).dispatch,true);
  await service(db,'fusion_review_close',f.actor,rv2.reviewId,'stopped');
  await assert.rejects(start(db,f),/FUSION_REVIEW_ACTIVE/,'stopped review with a dispatched call still blocks');
  // Once its automatic cost lookups are spent it waits for manual review and frees the slot (§3.3).
  await db.query('UPDATE bill2_calls SET recovery_attempts=3 WHERE id=$1',[c2.calls[0].id]);
  const manual = await start(db,f);
  await service(db,'fusion_review_close',f.actor,manual.reviewId,'stopped');
  await db.query('UPDATE bill2_calls SET recovery_attempts=0 WHERE id=$1',[c2.calls[0].id]);
  await rpc(db,'bill2_record',f.actor,s2.run.run,c2.calls[0].id,{provider:s2.run.claimPayload.provider,account:'sandbox',
    model:s2.run.claimPayload.model,protocol:s2.run.claimPayload.protocol,providerId:'generation-'+c2.calls[0].id,source:'response',
    sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',
    usage:{inputTokens:400,outputTokens:0}});
  await rpc(db,'bill2_finalize',f.actor,s2.run.run);
  report.checks.push('a stopped review with a dispatched, unsettled call occupies the user slot until it settles or enters manual review');

  // Idle pause and resume; "end review" only from paused.
  const rv3 = await start(db,f);
  await assert.rejects(service(db,'fusion_review_close',f.actor,rv3.reviewId,'interrupted'),/FUSION_REVIEW_STEP_CONFLICT/);
  await db.query("UPDATE fusion_reviews SET updated_at=now()-interval '2 hours' WHERE id=$1",[rv3.reviewId]);
  assert.ok(await rpc(db,'fusion_review_pause_idle','1 hour')>=1);
  assert.equal((await service(db,'fusion_review_read',f.actor,rv3.reviewId)).state,'paused');
  await assert.rejects(start(db,f),/FUSION_REVIEW_ACTIVE/,'paused still occupies the slot');
  const s3 = await step(db,f);
  await claim(db,f,rv3,s3);
  assert.equal((await service(db,'fusion_review_read',f.actor,rv3.reviewId)).state,'running','a claim resumes a paused review');
  await db.query("UPDATE fusion_reviews SET updated_at=now()-interval '2 hours' WHERE id=$1",[rv3.reviewId]);
  assert.equal(await rpc(db,'fusion_review_pause_idle','1 hour'),0,'an unsettled call keeps it running');
  await service(db,'fusion_review_close',f.actor,rv3.reviewId,'stopped');
  await db.query("UPDATE fusion_reviews SET updated_at=now()-interval '2 hours' WHERE id=$1",[rv3.reviewId]);
  await rpc(db,'fusion_review_pause_idle','1 hour');
  assert.equal((await service(db,'fusion_review_read',f.actor,rv3.reviewId)).state,'stopped','ended reviews are never paused');
  const rv4 = await start(db,f);
  await db.query("UPDATE fusion_reviews SET updated_at=now()-interval '2 hours' WHERE id=$1",[rv4.reviewId]);
  await rpc(db,'fusion_review_pause_idle','1 hour');
  assert.equal((await service(db,'fusion_review_close',f.actor,rv4.reviewId,'interrupted')).state,'interrupted');
  report.checks.push('idle running reviews pause (not an end state), resume on claim; ended reviews stay ended; "end review" only from paused');

  // Two concurrent starts for the same user: one review.
  const clients = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(c=>c.connect()));
  try {
    const results = await Promise.all(clients.map(c=>start(c,f).then(r=>r.reviewId,e=>e.message)));
    assert.equal(results.filter(r=>/FUSION_REVIEW_ACTIVE/.test(r)).length,1);
    const winner = results.find(r=>!/FUSION_REVIEW_ACTIVE/.test(r));
    // Completed with an outcome; the same end state answers again, another one is refused.
    const to = {state:'completed',outcome:{kind:'no_change'}};
    assert.equal((await service(db,'fusion_review_advance',f.actor,winner,{round:1,phase:'review',attempt:1},to)).state,'completed');
    assert.equal((await service(db,'fusion_review_advance',f.actor,winner,{round:1,phase:'review',attempt:1},to)).state,'completed');
    await assert.rejects(service(db,'fusion_review_advance',f.actor,winner,{round:1,phase:'review',attempt:1},
      {state:'incomplete',outcome:{kind:'no_opinions'}}),/FUSION_REVIEW_ENDED/);
    await assert.rejects(service(db,'fusion_review_advance',f.actor,winner,{round:1,phase:'review',attempt:1},
      {...to,revisionId:randomUUID()}),/FUSION_REVIEW_ENDED/,'a replay naming another revision is refused');
  } finally { await Promise.all(clients.map(c=>c.end())); }
  report.checks.push('two concurrent starts for one user create one review; an end state is idempotent and final');

  // A stop between the saved body and the host verdict does not charge it as user_stopped: the call waits
  // for the verdict, and a malformed body is still free. A replayed claim also resumes a paused review.
  const rv5 = await start(db,f);
  const s5 = await step(db,f);
  const c5 = (await claim(db,f,rv5,s5)).calls[0];
  await db.query("UPDATE fusion_reviews SET state='paused' WHERE id=$1",[rv5.reviewId]);
  await claim(db,f,rv5,s5);
  assert.equal((await service(db,'fusion_review_read',f.actor,rv5.reviewId)).state,'running','a replayed claim resumes a paused review');
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,s5.run.run,c5.id,c5.dispatchToken)).dispatch,true);
  await rpc(db,'bill2_record',f.actor,s5.run.run,c5.id,{provider:s5.run.claimPayload.provider,account:'sandbox',
    model:s5.run.claimPayload.model,protocol:s5.run.claimPayload.protocol,providerId:'generation-'+c5.id,source:'response',
    sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',
    usage:{inputTokens:400,outputTokens:0}});
  await rpc(db,'fusion_call_output_save',f.actor,c5.id,'not valid review json');
  await service(db,'fusion_review_close',f.actor,rv5.reviewId,'stopped');
  const waiting = (await db.query('SELECT fusion_verdict,settled_at FROM bill2_calls WHERE id=$1',[c5.id])).rows[0];
  assert.deepEqual(waiting,{fusion_verdict:null,settled_at:null},'a saved, unjudged body waits for the host verdict');
  await rpc(db,'fusion_call_verdict',f.actor,c5.id,'format_invalid');
  await rpc(db,'bill2_finalize',f.actor,s5.run.run);
  const judged = (await db.query('SELECT fusion_verdict,settled_at,charged_delta FROM bill2_calls WHERE id=$1',[c5.id])).rows[0];
  assert.equal(judged.fusion_verdict,'format_invalid');assert.ok(judged.settled_at);assert.equal(Number(judged.charged_delta??0),0);
  report.checks.push('a stop between the saved body and the verdict leaves the call to the host verdict (malformed stays free); replayed claims resume');

  // Version block after 3 failed ends in a row; breaker on platform-borne outcomes.
  for (let i=0;i<3;i++) {
    const failed = await start(db,f);
    await service(db,'fusion_review_advance',f.actor,failed.reviewId,{round:1,phase:'review',attempt:1},
      {state:i%2?'incomplete':'revision_failed',outcome:{kind:'failed'}});
  }
  await assert.rejects(start(db,f),/FUSION_REVIEW_VERSION_BLOCKED/);
  await db.query("UPDATE fusion_reviews SET state='completed' WHERE id=(SELECT id FROM fusion_reviews WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 1)",[f.actor]);
  const usage = await rpc(db,'fusion_review_breaker_usage',f.actor);
  assert.ok(usage.noDeliveryCalls>=1,'calls cancelled before dispatch count as no delivery');
  await settings(db,{breaker:{platformUsd:'2',noDeliveryCalls:usage.noDeliveryCalls}});
  await assert.rejects(start(db,f),/FUSION_REVIEW_BREAKER/);
  await settings(db);
  report.checks.push('a version is blocked after 3 failed ends in a row; the 7-day breaker refuses new reviews');

  // Deletion overlapping a held review row fails fast (retryable) instead of deadlocking.
  const busyReview = (await db.query('SELECT id FROM fusion_reviews WHERE actor_id=$1 LIMIT 1',[f.actor])).rows[0].id;
  const [holder,deleter] = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all([holder.connect(),deleter.connect()]);
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM fusion_reviews WHERE id=$1 FOR UPDATE',[busyReview]);
    await deleter.query("SET lock_timeout='5s'");
    await assert.rejects(erase(deleter,f,'artifact',f.project),/CONTENT_ERASURE_BUSY/);
    await holder.query('ROLLBACK');
  } finally { await holder.end(); await deleter.end(); }
  report.checks.push('draft deletion overlapping a held review row fails fast with the retryable busy refusal');

  // Erasure: deleting the draft deletes its reviews; account erasure removes and counts them.
  const before = Number((await db.query('SELECT count(*) v FROM fusion_reviews WHERE actor_id=$1',[f.actor])).rows[0].v);
  assert.ok(before>=1);
  assert.ok(Number((await db.query('SELECT account_erasure_body_remaining($1) v',[f.actor])).rows[0].v)>=before);
  assert.equal((await erase(db,f,'artifact',f.project)).status,'deleted');
  assert.equal(Number((await db.query('SELECT count(*) v FROM fusion_reviews WHERE actor_id=$1',[f.actor])).rows[0].v),0);
  const g = await seed(db);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[g.actor]);
  await start(db,g);
  await closeAccount(db,g);
  const counts = (await db.query('SELECT account_erasure_scrub_content($1) v',[g.actor])).rows[0].v;
  assert.equal(counts.fusion_reviews,1);
  assert.equal(Number((await db.query('SELECT count(*) v FROM fusion_reviews WHERE actor_id=$1',[g.actor])).rows[0].v),0);
  report.checks.push('deleting the draft deletes its reviews; account erasure removes and counts review rows');
}
