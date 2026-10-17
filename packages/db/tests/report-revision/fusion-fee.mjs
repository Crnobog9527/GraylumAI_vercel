/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-FIXED-PRICE (0294, Owner 2026-10-17): one fixed fee per review, held at start, charged only when a usable
// revision is ready for the per-section choice, refunded on failure; each model call still holds and settles on its
// own run but always at zero user charge (its real cost and its would-be charge stay recorded). No model call.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {seed} from './cases.mjs';

const FEE = 1500;
const review = {enabled:true,reviewerModelIds:[],summaryModelId:null,skillId:null,maxRounds:2,opinionOutputTokens:4096,
  summaryOutputTokens:16384,maxBudgetUsd:'5',dispatchMinutes:10,breaker:{platformUsd:'2',noDeliveryCalls:10}};
const settings = (db,patch={}) => db.query(`INSERT INTO system_settings(key,value) VALUES('fusion_settings',$1::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify({version:1,review:{...review,...patch},compare:{enabled:false}})]);
const config = (hold=0,credits=FEE) => ({estimateUsd:'0.5',maxRounds:2,fixedPrice:{credits,holdCredits:hold}});
const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const ledger = async (db,actor) => Number((await db.query('SELECT coalesce(sum(amount),0) v FROM credit_transactions WHERE user_id=$1',[actor])).rows[0].v);
const fee = async (db,reviewId) => (await db.query('SELECT * FROM fusion_review_fees WHERE review_id=$1',[reviewId])).rows[0];
async function service(db,name,...args) {
  await db.query('SET ROLE service_role');
  try { return await rpc(db,name,...args); } finally { await db.query('RESET ROLE'); }
}
const start = (db,f,cfg=config(),request=randomUUID()) => service(db,'fusion_review_start',f.actor,request,f.draft,f.versionId,cfg);
async function grant(db,actor,n) {
  await db.query('UPDATE profiles SET credits=credits+$2 WHERE id=$1',[actor,n]);
  // A positive fixture grant, or an administrator deduction to reach the wanted balance.
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    SELECT id,$2::int,CASE WHEN $2::int>0 THEN 'addition' ELSE 'adjustment' END,CASE WHEN $2::int>0 THEN 'grant' ELSE 'adjustment' END,
      CASE WHEN $2::int>0 THEN 'opening_grant' ELSE 'admin_adjustment' END,CASE WHEN $2::int>0 THEN 'system' ELSE 'admin' END,
      'fee-grant:'||gen_random_uuid(),credits-$2::int,credits FROM profiles WHERE id=$1`,[actor,n]);
}
async function member(db,credits) {
  const f = await seed(db);
  await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
  const have = await wallet(db,f.actor);
  if (credits!==have) await grant(db,f.actor,credits-have);
  baseline.set(f.actor,await holdCount(db,f.actor));
  return f;
}
async function step(db,f,options={}) {
  const run = await createFixture(db,{actor:f.actor,phase:'fusion_review',...options});
  const group = await rpc(db,'fusion_group_create',f.actor,randomUUID(),'review',f.session);
  await rpc(db,'fusion_group_attach',f.actor,group,run.run);
  return {run,group,items:JSON.stringify([{runId:run.run,sequence:1,payload:run.claimPayload}])};
}
const claim = (db,f,rv,s,round=1,phase='review',attempt=1) =>
  service(db,'fusion_review_claim',f.actor,rv.reviewId,round,phase,attempt,s.group,s.items);
const record = (db,f,s,c,inputTokens=400) => rpc(db,'bill2_record',f.actor,s.run.run,c.id,{provider:s.run.claimPayload.provider,account:'sandbox',
  model:s.run.claimPayload.model,protocol:s.run.claimPayload.protocol,providerId:'generation-'+c.id,source:'response',
  sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',
  usage:{inputTokens,outputTokens:0}});
/** One usable reviewer call through the review: claimed, dispatched, recorded, saved, judged usable, settled. */
async function usableCall(db,f,rv,options={}) {
  const s = await step(db,f,options);
  const c = (await claim(db,f,rv,s)).calls[0];
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,s.run.run,c.id,c.dispatchToken)).dispatch,true);
  await record(db,f,s,c,options.inputTokens);
  await rpc(db,'fusion_call_output_save',f.actor,c.id,'{"issues":[]}');
  await rpc(db,'fusion_call_verdict',f.actor,c.id,'usable');
  await rpc(db,'bill2_finalize',f.actor,s.run.run);
  return {s,c,call:(await db.query('SELECT * FROM bill2_calls WHERE id=$1',[c.id])).rows[0]};
}
const end = (db,f,rv,to) => service(db,'fusion_review_advance',f.actor,rv.reviewId,{round:1,phase:'review',attempt:1},to);
const balanced = async (db,actor,label) => assert.equal(await ledger(db,actor),await wallet(db,actor),label+': ledger sum equals balance');
// Holds the seed fixture itself leaves open (its report run) are not counted.
const baseline = new Map();
const openHolds = async (db,actor) => (await holdCount(db,actor))-(baseline.get(actor)??0);
const holdCount = async (db,actor) => Number((await db.query(`SELECT count(*) v FROM billing_history h WHERE h.user_id=$1 AND h.operation_type='pre_deduct'
  AND NOT EXISTS(SELECT 1 FROM billing_history d WHERE d.user_id=h.user_id AND d.operation_type IN ('settle','refund','abort_settle')
  AND d.metadata->>'preDeductId'=h.id::text)`,[actor])).rows[0].v);

export async function runFusionFee({db,Client,connectionString,report}) {
  await settings(db);
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO UPDATE SET allow_fusion_review=true`,[randomUUID()]);

  // Normal completion: hold 1500 at start, each call settles at zero (would-be charge recorded), 1500 charged once.
  const f = await member(db,5000);
  const rv = await start(db,f,config(200));
  assert.equal(await wallet(db,f.actor),5000-FEE,'the fixed price is held at start');
  assert.deepEqual({state:rv.fee.state,credits:rv.fee.credits},{state:'held',credits:FEE},'the view shows the held fee');
  const u = await usableCall(db,f,rv);
  assert.equal(Number(u.call.charged_delta),0,'a model call of a fixed-price review charges nothing');
  assert.equal(u.call.nominal_source,'fixed_fee');
  assert.ok(Number(u.call.theoretical_delta)>=1,'the per-call would-be charge stays recorded');
  assert.equal(Number(u.call.platform_absorbed_bound_credits),Number(u.call.theoretical_delta),'the platform absorbs the call');
  assert.equal(String((await db.query('SELECT selected_cost_usd v FROM bill2_calls WHERE id=$1',[u.c.id])).rows[0].v),'0.0004','real cost recorded');
  assert.equal(await wallet(db,f.actor),5000-FEE,'the call hold is fully released');
  assert.equal((await db.query('SELECT fee_review_id FROM fusion_billing_groups WHERE id=$1',[u.s.group])).rows[0].fee_review_id,rv.reviewId);
  const done = await end(db,f,rv,{state:'completed',outcome:{kind:'revised',awaitingChoice:true}});
  assert.deepEqual({state:done.fee.state,charged:done.fee.chargedCredits},{state:'charged',charged:FEE});
  assert.equal(await wallet(db,f.actor),5000-FEE,'exactly the fixed price is charged');
  await end(db,f,rv,{state:'completed',outcome:{kind:'revised',awaitingChoice:true}});
  assert.equal(await service(db,'fusion_review_fee_settle',f.actor,rv.reviewId).then(v=>v.state),'charged');
  assert.equal(await wallet(db,f.actor),5000-FEE,'replays never charge twice');
  const rows = (await db.query(`SELECT amount,ledger_type,reason_code FROM credit_transactions WHERE user_id=$1 AND source_id=$2 ORDER BY reason_code`,
    [f.actor,rv.reviewId])).rows;
  assert.deepEqual(rows.map(r=>[r.amount,r.ledger_type,r.reason_code]),
    [[FEE,'adjustment','bill2_release'],[-FEE,'adjustment','bill2_reserve'],[-FEE,'spend','bill2_spend']]);
  await balanced(db,f.actor,'completion');assert.equal(await openHolds(db,f.actor),0,'no open hold after completion');
  report.checks.push('fixed price: 1500 held at start, calls settle at zero with real cost and would-be charge recorded, 1500 charged once on a usable revision');

  // Failure ends refund in full: incomplete, revision_failed and "no change" (no revision).
  for (const outcome of [{state:'incomplete',outcome:{kind:'no_opinions'}},{state:'revision_failed',outcome:{kind:'revision_failed'}},
    {state:'completed',outcome:{kind:'no_change'}}]) {
    const before = await wallet(db,f.actor);
    const r = await start(db,f);
    await usableCall(db,f,r);
    const ended = await end(db,f,r,outcome);
    assert.deepEqual({state:ended.fee.state,charged:ended.fee.chargedCredits},{state:'refunded',charged:0},outcome.state);
    assert.equal(await wallet(db,f.actor),before,outcome.state+' refunds the whole fixed price');
  }
  await balanced(db,f.actor,'failures');assert.equal(await openHolds(db,f.actor),0);
  report.checks.push('fixed price: incomplete, revision_failed and no-change ends refund the whole fee; the platform keeps the call cost');

  // Admission: balance must cover the fee plus the largest per-step temporary hold; price and config are checked.
  const poor = await member(db,FEE+99);
  await assert.rejects(start(db,poor,config(100)),/FUSION_REVIEW_CREDITS/);
  assert.equal(await wallet(db,poor.actor),FEE+99,'nothing held when refused');
  assert.equal(Number((await db.query('SELECT count(*) v FROM fusion_reviews WHERE actor_id=$1',[poor.actor])).rows[0].v),0,'no review created');
  await assert.rejects(start(db,poor,config(0,1200)),/FUSION_REVIEW_PRICE_CHANGED/);
  await assert.rejects(start(db,poor,{estimateUsd:'0.5',maxRounds:2}),/FUSION_REVIEW_INVALID/,'a start without the fixed price is refused');
  await settings(db,{fixedPriceCredits:1200});
  const cheaper = await start(db,poor,config(0,1200));
  assert.equal(cheaper.fee.credits,1200,'the administrator price is used');
  await service(db,'fusion_review_close',poor.actor,cheaper.reviewId,'stopped');
  await settings(db);
  assert.equal(await wallet(db,poor.actor),FEE+99,'a stop before any call refunds in full');
  report.checks.push('fixed price: refused (nothing held, no review) below fee + temporary hold; administrator price enforced; missing price refused');

  // Gold only (Owner 2026-10-17): Free and Pro are refused by the database, nothing held.
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local pro','pro',true,false,500000000) ON CONFLICT(level) DO UPDATE SET allow_fusion_review=true`,[randomUUID()]);
  assert.equal((await db.query(`UPDATE membership_plans SET allow_fusion_review=false WHERE level='pro' AND allow_fusion_review RETURNING level`)).rowCount,1,
    'the 0294 statement turns Pro off');
  for (const level of ['free','pro']) {
    const other = await member(db,5000);
    await db.query('UPDATE profiles SET membership_level=$2 WHERE id=$1',[other.actor,level]);
    await assert.rejects(start(db,other),/FUSION_MEMBERSHIP_REQUIRED|REPORT_MEMBERSHIP_REQUIRED/,level);
    assert.equal(await wallet(db,other.actor),5000,level+': nothing held');
  }
  // Even with the Pro plan switch turned back on by an administrator, Pro stays refused (#1098 review).
  await db.query(`UPDATE membership_plans SET allow_fusion_review=true WHERE level='pro'`);
  const pro = await member(db,5000);
  await db.query(`UPDATE profiles SET membership_level='pro' WHERE id=$1`,[pro.actor]);
  await assert.rejects(start(db,pro),/FUSION_MEMBERSHIP_REQUIRED/,'Pro with the plan switch on');
  assert.equal(await wallet(db,pro.actor),5000);
  await db.query(`UPDATE membership_plans SET allow_fusion_review=false WHERE level='pro'`);
  report.checks.push('fixed price: only Gold starts a review; Free and Pro are refused with nothing held, also with the Pro plan switch on');

  // Duplicate and concurrent starts: one review, one hold.
  const dup = await member(db,5000);
  const request = randomUUID();
  const first = await start(db,dup,config(),request);
  assert.equal((await start(db,dup,config(),request)).reviewId,first.reviewId);
  assert.equal(await wallet(db,dup.actor),5000-FEE,'a repeated start holds once');
  await service(db,'fusion_review_close',dup.actor,first.reviewId,'stopped');
  const clients = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(c=>c.connect()));
  try {
    const results = await Promise.all(clients.map(c=>start(c,dup).then(r=>r.reviewId,e=>e.message)));
    assert.equal(results.filter(r=>/FUSION_REVIEW_ACTIVE/.test(r)).length,1,JSON.stringify(results));
    assert.equal(await wallet(db,dup.actor),5000-FEE,'two concurrent starts hold one fee');
    const winner = {reviewId:results.find(r=>!/FUSION_REVIEW_ACTIVE/.test(r))};
    // Completion racing a stop: exactly one end state and one settlement.
    const raced = await Promise.all([
      service(clients[0],'fusion_review_advance',dup.actor,winner.reviewId,{round:1,phase:'review',attempt:1},
        {state:'completed',outcome:{kind:'revised'}}).then(v=>v.state,e=>e.message),
      service(clients[1],'fusion_review_close',dup.actor,winner.reviewId,'stopped').then(v=>v.state,e=>e.message)]);
    const settled = await fee(db,winner.reviewId);
    assert.notEqual(settled.state,'held',JSON.stringify(raced));
    assert.equal(await wallet(db,dup.actor),5000-(settled.state==='charged'?FEE:0),'one settlement whichever wins');
  } finally { await Promise.all(clients.map(c=>c.end())); }
  await balanced(db,dup.actor,'concurrency');assert.equal(await openHolds(db,dup.actor),0);
  report.checks.push('fixed price: repeated and concurrent starts hold once; completion racing a stop settles exactly once');

  // Stop after dispatch: the existing stop rule (known usage), capped at the fixed price; undispatched calls are free.
  const st = await member(db,5000);
  const sr = await start(db,st);
  const s1 = await step(db,st);
  const c1 = (await claim(db,st,sr,s1)).calls[0];
  assert.equal((await rpc(db,'bill2_dispatch',st.actor,s1.run.run,c1.id,c1.dispatchToken)).dispatch,true);
  const stopped = await service(db,'fusion_review_close',st.actor,sr.reviewId,'stopped');
  assert.equal(stopped.fee.state,'held','an in-flight call keeps the fee held until it settles');
  await record(db,st,s1,c1);
  await rpc(db,'bill2_finalize',st.actor,s1.run.run);
  const stopCall = (await db.query('SELECT fusion_verdict,theoretical_delta,charged_delta FROM bill2_calls WHERE id=$1',[c1.id])).rows[0];
  assert.equal(stopCall.fusion_verdict,'user_stopped');assert.equal(Number(stopCall.charged_delta),0);
  const afterStop = await service(db,'fusion_review_fee_settle',st.actor,sr.reviewId);
  assert.deepEqual({state:afterStop.state,charged:afterStop.chargedCredits},{state:'charged',charged:Number(stopCall.theoretical_delta)});
  assert.equal(await wallet(db,st.actor),5000-Number(stopCall.theoretical_delta),'a stop pays the known usage only');
  // The cap: known usage above the fixed price charges the fixed price; the platform bears the rest.
  const big = await start(db,st);
  const b1 = await step(db,st,{q:'10000000'});
  await grant(db,st.actor,200000);
  const bc = (await claim(db,st,big,b1)).calls[0];
  assert.equal((await rpc(db,'bill2_dispatch',st.actor,b1.run.run,bc.id,bc.dispatchToken)).dispatch,true);
  await record(db,st,b1,bc);
  const beforeBig = await wallet(db,st.actor);
  await service(db,'fusion_review_close',st.actor,big.reviewId,'stopped');
  const capped = await fee(db,big.reviewId);
  assert.equal(capped.state,'charged');assert.equal(capped.charged_credits,FEE,'never more than the fixed price');
  assert.ok(Number((await db.query('SELECT theoretical_delta v FROM bill2_calls WHERE id=$1',[bc.id])).rows[0].v)>FEE);
  assert.equal(await wallet(db,st.actor),beforeBig+(await db.query('SELECT reserved_credits v FROM bill2_calls WHERE id=$1',[bc.id])).rows[0].v,
    'the call hold returns; the held fee becomes the charge');
  await balanced(db,st.actor,'stop');assert.equal(await openHolds(db,st.actor),0);
  report.checks.push('fixed price: a user stop pays the known usage of dispatched calls (existing stop rule), capped at the fixed price; held until in-flight calls settle');

  // Erasure: deleting the draft or closing the account refunds a held fee; a held fee counts as financial pending.
  const er = await member(db,5000);
  const erv = await start(db,er);
  await usableCall(db,er,erv);
  assert.ok((await db.query('SELECT account_erasure_financial_proof($1) v',[er.actor])).rows[0].v.financialPending>=1,'a held fee is pending');
  assert.equal((await erase(db,er,'artifact',er.project)).status,'deleted');
  assert.equal((await fee(db,erv.reviewId)).state,'refunded','deleting the draft refunds the held fee');
  assert.equal(await wallet(db,er.actor),5000);
  await balanced(db,er.actor,'content erasure');
  const ac = await member(db,5000);
  const arv = await start(db,ac);
  await closeAccount(db,ac);
  await db.query('SELECT account_erasure_scrub_content($1)',[ac.actor]);
  assert.equal((await fee(db,arv.reviewId)).state,'refunded','account erasure refunds the held fee');
  assert.equal(await wallet(db,ac.actor),5000);assert.equal(await openHolds(db,ac.actor),0);
  report.checks.push('fixed price: draft deletion and account erasure refund a held fee; a held fee keeps account erasure pending');

  // A usable summary is a delivered revision: a review ended any other way afterwards still pays the full price (#1098 review).
  const late = await member(db,5000);
  const lr = await start(db,late);
  const ls = await step(db,late);
  const lsItems = JSON.parse(ls.items);
  lsItems[0].payload = {...lsItems[0].payload,phase:'fusion_summary'};
  await db.query(`UPDATE bill2_runs SET payload=jsonb_set(payload,'{callPolicy,0,payg,purposes}','["fusion_summary"]') WHERE id=$1`,[ls.run.run]);
  const lc = (await service(db,'fusion_review_claim',late.actor,lr.reviewId,1,'review',1,ls.group,JSON.stringify(lsItems))).calls[0];
  await rpc(db,'bill2_dispatch',late.actor,ls.run.run,lc.id,lc.dispatchToken);
  await record(db,late,ls,lc);
  await rpc(db,'fusion_call_output_save',late.actor,lc.id,'{"body":"revised"}');
  await rpc(db,'fusion_call_verdict',late.actor,lc.id,'usable');
  await rpc(db,'bill2_finalize',late.actor,ls.run.run);
  await service(db,'fusion_review_close',late.actor,lr.reviewId,'stopped');
  const lateFee = await fee(db,lr.reviewId);
  assert.deepEqual({state:lateFee.state,charged:lateFee.charged_credits},{state:'charged',charged:FEE},'a delivered revision pays the full price');
  report.checks.push('fixed price: once a summary is judged usable, the full price is charged however the review ends');

  // The daily job settles fees whose review ended while a call was still in flight.
  const dj = await member(db,5000);
  const djr = await start(db,dj);
  const d1 = await step(db,dj);
  const dc = (await claim(db,dj,djr,d1)).calls[0];
  await rpc(db,'bill2_dispatch',dj.actor,d1.run.run,dc.id,dc.dispatchToken);
  await service(db,'fusion_review_close',dj.actor,djr.reviewId,'stopped');
  await record(db,dj,d1,dc);
  await rpc(db,'bill2_finalize',dj.actor,d1.run.run);
  assert.ok(await service(db,'fusion_review_fee_settle_due',100)>=1);
  assert.equal((await fee(db,djr.reviewId)).state,'charged');
  report.checks.push('fixed price: the daily job settles held fees of ended reviews once their calls have settled');

  // Breaker: call costs of refunded reviews are platform-borne and count toward the 7-day breaker.
  const usage = await rpc(db,'fusion_review_breaker_usage',f.actor);
  assert.ok(Number(usage.platformUsd)>=0.0012,'refunded reviews count their call cost: '+JSON.stringify(usage));
  report.checks.push('fixed price: the breaker counts the call cost of refunded reviews as platform-borne');

  // Markers: a fee review marks its groups before any call; a marked group is never moved or used by another review.
  const mk = await member(db,9000);
  const mr = await start(db,mk);
  const m1 = await step(db,mk);
  await claim(db,mk,mr,m1);
  await assert.rejects(db.query('UPDATE fusion_billing_groups SET fee_review_id=$2 WHERE id=$1',[m1.group,randomUUID()]),/FUSION_GROUP_IMMUTABLE/);
  const unmarked = await step(db,mk);
  await rpc(db,'fusion_group_claim',mk.actor,unmarked.group,'review:1',1,unmarked.items);
  await assert.rejects(db.query('UPDATE fusion_billing_groups SET fee_review_id=$2 WHERE id=$1',[unmarked.group,mr.reviewId]),/FUSION_GROUP_IMMUTABLE/,
    'cannot mark a group that already has calls');
  // A review started before 0294 (no fee) keeps per-call billing.
  await service(db,'fusion_review_close',mk.actor,mr.reviewId,'stopped');
  const legacy = (await db.query(`INSERT INTO fusion_reviews(actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
    materials,materials_hash,config,state,round,phase,attempt) SELECT actor_id,gen_random_uuid(),draft_id,project_id,source_session_id,source_version_id,
    version_hash,materials,materials_hash,'{"estimateUsd":"0.5","maxRounds":2}',state,1,'review',1 FROM fusion_reviews WHERE id=$1 RETURNING id`,
    [mr.reviewId])).rows[0].id;
  await db.query("UPDATE fusion_reviews SET state='running',ended_at=NULL WHERE id=$1",[legacy]);
  const lu = await usableCall(db,mk,{reviewId:legacy});
  assert.ok(Number(lu.call.charged_delta)>=1,'a review without a fee keeps per-call billing');
  assert.equal(lu.call.nominal_source,'nominal');
  report.checks.push('fixed price: group marker set once before any call; reviews without a fee keep per-call billing');
}
