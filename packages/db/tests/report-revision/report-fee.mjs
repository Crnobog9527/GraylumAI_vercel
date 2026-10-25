/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REPORT-FIXED-PRICE (0295, Owner 2026-10-17): one fixed price per report generation, held at admission, charged once
// for a complete report, refunded otherwise; the report's model call settles at zero user charge. No model call.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
import {createFixture} from '../payg/fixture.mjs';
import {seed} from './cases.mjs';
import {terminatedGrant} from '../payg/quarantine.mjs';

const PRICE = 500;
const spec = {version:1,sections:['One','Two'],maxCharacters:12000};
const completeBody = '## One\nA complete report.\n## Two\nAll sections.';
const wallet = async (db,actor) => (await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const ledger = async (db,actor) => Number((await db.query('SELECT coalesce(sum(amount),0) v FROM credit_transactions WHERE user_id=$1',[actor])).rows[0].v);
const fee = async (db,id) => (await db.query('SELECT * FROM report_fees WHERE execution_id=$1',[id])).rows[0];
async function service(db,name,...args) {
  await db.query('SET ROLE service_role');
  try { return await rpc(db,name,...args); } finally { await db.query('RESET ROLE'); }
}
async function setBalance(db,actor,credits) {
  const delta = credits-await wallet(db,actor);
  if (!delta) return;
  await db.query('UPDATE profiles SET credits=credits+$2 WHERE id=$1',[actor,delta]);
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
    SELECT id,$2::int,CASE WHEN $2::int>0 THEN 'addition' ELSE 'adjustment' END,CASE WHEN $2::int>0 THEN 'grant' ELSE 'adjustment' END,
      CASE WHEN $2::int>0 THEN 'opening_grant' ELSE 'admin_adjustment' END,CASE WHEN $2::int>0 THEN 'system' ELSE 'admin' END,
      'report-fee:'||gen_random_uuid(),credits-$2::int,credits FROM profiles WHERE id=$1`,[actor,delta]);
}
/** A report execution of the seeded session with a PAYG run, as runtime_admit creates it; the price hold is what the
 * 0295 admission hook runs (the hook itself is exercised end to end by report.integration.ts). */
async function execution(db,f,billing={limits:{costUsd:'0.1'},rules:{creditsPerUsd:'1000',multiplier:'1'}},link=true,round=randomUUID()) {
  const run = await createFixture(db,{actor:f.actor});
  const id = randomUUID();
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,billing_run_id)
    VALUES($1,$2,$3,$4,$5,0,'running',$6)`,[id,f.actor,f.session,randomUUID(),{reportGeneration:{...spec,projectId:f.project,roundId:round}},link?run.run:null]);
  await db.query('SELECT report_fee_hold(e,$2::jsonb) FROM runtime_executions e WHERE e.id=$1',[id,JSON.stringify(billing)]);
  return {id,run};
}
const finish = (db,id,state,result) => db.query('UPDATE runtime_executions SET state=$2,result=$3 WHERE id=$1',[id,state,result]);
const balanced = async (db,actor,label) => assert.equal(await ledger(db,actor),await wallet(db,actor),label+': ledger sum equals balance');

export async function runReportFee({db,Client,connectionString,report}) {
  // The admission hook is in runtime_admit, after the execution insert, for report executions only.
  const admitDef = (await db.query(`SELECT pg_get_functiondef('public.runtime_admit(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure) d`)).rows[0].d;
  assert.match(admitDef,/-- 0295 report price\n IF p_payload \? 'reportGeneration' THEN PERFORM report_fee_hold\(e,p_billing\)/);
  assert.equal(await service(db,'report_fixed_price'),PRICE,'default price 500, read from settings');

  // Complete report: 500 held at admission, the call settles at zero (cost recorded), 500 charged once.
  const f = await seed(db);
  await setBalance(db,f.actor,5000);
  // The call is claimed before the run is bound to the execution (the fixture run is not a real report run, so the
  // report claim checks would refuse it); the binding is what finalize reads.
  const ok = await execution(db,f,undefined,false);
  assert.equal(await wallet(db,f.actor),5000-PRICE,'the price is held at admission');
  const c = await rpc(db,'bill2_claim',f.actor,ok.run.run,1,ok.run.claimPayload);
  await rpc(db,'bill2_dispatch',f.actor,ok.run.run,c.id,c.dispatchToken);
  // Fixture only: bind past the immutable-binding guards (a real admission binds both at insert).
  await db.query(`SET session_replication_role=replica`);
  try {
    await db.query('UPDATE bill2_runs SET session_ref=$2 WHERE id=$1',[ok.run.run,f.session]);
    await db.query('UPDATE runtime_executions SET billing_run_id=$2 WHERE id=$1',[ok.id,ok.run.run]);
  }
  finally { await db.query(`SET session_replication_role=origin`); }
  await rpc(db,'bill2_record',f.actor,ok.run.run,c.id,{provider:ok.run.claimPayload.provider,account:'sandbox',model:ok.run.claimPayload.model,
    protocol:ok.run.claimPayload.protocol,providerId:'generation-'+c.id,source:'response',sourceHash:'c'.repeat(64),
    observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',usage:{inputTokens:400,outputTokens:0}});
  await rpc(db,'bill2_finalize',f.actor,ok.run.run);
  const settledCall = (await db.query('SELECT charged_delta,nominal_source,theoretical_delta,selected_cost_usd FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
  assert.deepEqual([Number(settledCall.charged_delta),settledCall.nominal_source],[0,'fixed_fee'],'the report call charges nothing');
  assert.ok(Number(settledCall.theoretical_delta)>=1);assert.equal(String(settledCall.selected_cost_usd),'0.0004');
  assert.equal(await wallet(db,f.actor),5000-PRICE,'the call hold is fully released');
  // The real provider cost still reaches the cost projections, at zero credits (#1098 review, same rule).
  const statRows = (await db.query('SELECT total_cost_usd,total_credits FROM token_stats WHERE bill2_call_id=$1',[c.id])).rows;
  assert.deepEqual(statRows.map(r=>[String(r.total_cost_usd),Number(r.total_credits)]),[['0.0004',0]]);
  assert.equal(Number((await db.query('SELECT count(*) v FROM ai_usage_logs WHERE bill2_call_id=$1',[c.id])).rows[0].v),1);
  assert.equal((await service(db,'report_fee_settle',f.actor,ok.id)).state,'held','a running report keeps its price held');
  await finish(db,ok.id,'completed',{body:completeBody,completeness:'complete'});
  const charged = await service(db,'report_fee_settle',f.actor,ok.id);
  assert.deepEqual({state:charged.state,charged:charged.chargedCredits},{state:'charged',charged:PRICE});
  assert.deepEqual(await service(db,'report_fee_settle',f.actor,ok.id),charged,'settling again changes nothing');
  assert.equal(await wallet(db,f.actor),5000-PRICE,'exactly the price is charged');
  await balanced(db,f.actor,'complete');
  report.checks.push('report price: 500 held at admission, the call settles at zero with its real cost, 500 charged once for a complete report');

  // Not complete: cut off, structure incomplete, stopped, cancelled or empty refunds in full.
  for (const [state,result] of [['completed',{body:'## One\nCut off',completeness:'length_limit'}],
    ['completed',{body:'## One\nOnly one.',completeness:'complete'}],['completed',{body:'## One\nx\n## Two\ny',completeness:'stopped'}],
    ['cancelled',null]]) {
    const before = await wallet(db,f.actor);
    const x = await execution(db,f);
    await finish(db,x.id,state,result);
    const v = await service(db,'report_fee_settle',f.actor,x.id);
    assert.deepEqual({state:v.state,charged:v.chargedCredits},{state:'refunded',charged:0},JSON.stringify(result));
    assert.equal(await wallet(db,f.actor),before,'refunded in full');
  }
  await balanced(db,f.actor,'refunds');
  report.checks.push('report price: cut-off, structurally incomplete, stopped and cancelled reports refund the whole price');

  // Interrupted recovery must release an incomplete report's fixed fee without a page read.
  const lost = await execution(db,f);
  const heldBalance = await wallet(db,f.actor);
  // This synthetic run starts bound to a different fixture scope; link it only inside this disposable test.
  await db.query('SET session_replication_role=replica');
  try {
    await db.query(`UPDATE bill2_runs SET session_ref=$2,runtime_epoch=1,
      runtime_dispatch_deadline=now()-interval '10 minutes' WHERE id=$1`,[lost.run.run,f.session]);
  } finally { await db.query('SET session_replication_role=origin'); }
  await db.query(`UPDATE runtime_executions SET state='interrupted',created_at=now()-interval '20 minutes'
    WHERE id=$1`,[lost.id]);
  await db.query('UPDATE runtime_sessions SET active_execution=$2 WHERE id=$1',[f.session,lost.id]);
  assert.equal((await service(db,'runtime_interrupted_recovery',f.actor,lost.id,1,20)).state,'cancelled');
  assert.equal((await fee(db,lost.id)).state,'refunded','cron refunds the fixed fee immediately');
  assert.equal(await wallet(db,f.actor),heldBalance+PRICE);
  assert.equal((await db.query('SELECT active_execution FROM runtime_sessions WHERE id=$1',[f.session])).rows[0].active_execution,null);
  const refundedBalance = await wallet(db,f.actor);
  assert.equal((await service(db,'runtime_interrupted_recovery',f.actor,lost.id,1,20)).state,'cancelled');
  assert.equal(await wallet(db,f.actor),refundedBalance,'repeat recovery does not refund twice');
  await balanced(db,f.actor,'interrupted recovery report refund');
  report.checks.push('interrupted recovery: incomplete report refunds 500 once and frees its Session without a model call');

  // Admission refused below the price plus the call's own hold: nothing held.
  const poor = await seed(db);
  await setBalance(db,poor.actor,PRICE+99);
  await assert.rejects(execution(db,poor),/REPORT_CREDITS/);
  assert.equal(await wallet(db,poor.actor),PRICE+99,'nothing held when refused');
  await db.query(`UPDATE system_settings SET value='300'::jsonb WHERE key='report_fixed_price_credits'`);
  const cheaper = await execution(db,poor);
  assert.equal((await fee(db,cheaper.id)).credits,300,'the administrator price is used');
  await db.query(`UPDATE system_settings SET value='500'::jsonb WHERE key='report_fixed_price_credits'`);
  // Holding twice for the same execution holds once.
  await db.query('SELECT report_fee_hold(e,$2::jsonb) FROM runtime_executions e WHERE e.id=$1',
    [cheaper.id,JSON.stringify({limits:{costUsd:'0.1'},rules:{creditsPerUsd:'1000',multiplier:'1'}})]);
  assert.equal(await wallet(db,poor.actor),PRICE+99-300,'a repeated hold holds once');
  report.checks.push('report price: refused (nothing held) below price + the call hold; administrator price used; repeated hold holds once');

  // ARCH-FIX E1 (0383): a terminated Waffo grant (no stripe_subscription_id) is not spendable for the price check.
  const quarantined = await seed(db);
  await setBalance(db,quarantined.actor,PRICE+100);
  await terminatedGrant(db,quarantined.actor,{kind:'waffo',credits:200});
  await assert.rejects(execution(db,quarantined),/REPORT_CREDITS/);
  assert.equal(await wallet(db,quarantined.actor),PRICE+100,'nothing held when the remainder is quarantined');
  report.checks.push('report price: a terminated Waffo grant remainder is excluded from the price check (E1)');

  // A second admission for a round whose report is charged, or still going, is refused under the admission lock
  // (two tabs with different request ids), and nothing is held; one whose report ended without a complete report is not.
  const dup = await seed(db);
  await setBalance(db,dup.actor,5000);
  const sameRound = randomUUID();
  const firstReport = await execution(db,dup,undefined,false,sameRound);
  await assert.rejects(execution(db,dup,undefined,false,sameRound),/REPORT_ALREADY_EXISTS/,'a report still going');
  assert.equal(await wallet(db,dup.actor),5000-PRICE,'nothing more held');
  // Terminal and complete, price not settled yet: still blocks (the window between finishing and the status read).
  const sameRound2 = randomUUID();
  const unsettled = await execution(db,dup,undefined,false,sameRound2);
  await finish(db,unsettled.id,'completed',{body:completeBody,completeness:'complete'});
  await assert.rejects(execution(db,dup,undefined,false,sameRound2),/REPORT_ALREADY_EXISTS/,'a complete report not yet settled');
  await finish(db,firstReport.id,'completed',{body:'## One\nCut off',completeness:'length_limit'});
  await service(db,'report_fee_settle',dup.actor,firstReport.id);
  const retry = await execution(db,dup,undefined,false,sameRound);
  await finish(db,retry.id,'completed',{body:completeBody,completeness:'complete'});
  await service(db,'report_fee_settle',dup.actor,retry.id);
  await assert.rejects(execution(db,dup,undefined,false,sameRound),/REPORT_ALREADY_EXISTS/,'a charged complete report');
  // The unsettled complete report of the other round still holds its price; the retry of the first round paid once.
  await service(db,'report_fee_settle',dup.actor,unsettled.id);
  assert.equal(await wallet(db,dup.actor),5000-2*PRICE,'each round paid once, nothing more');
  report.checks.push('report price: a second admission for a round with a going or charged report is refused with nothing held; a retry after a refunded one pays once');

  // Concurrent settlements of one finished report: one charge.
  const race = await execution(db,f);
  await finish(db,race.id,'completed',{body:completeBody,completeness:'complete'});
  const before = await wallet(db,f.actor);
  const clients = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(x=>x.connect()));
  try {
    const results = await Promise.all(clients.map(x=>service(x,'report_fee_settle',f.actor,race.id)));
    assert.ok(results.every(r=>r.state==='charged'));
  } finally { await Promise.all(clients.map(x=>x.end())); }
  assert.equal(await wallet(db,f.actor),before,'charged once (the hold was already taken)');
  assert.equal(Number((await db.query(`SELECT count(*) v FROM credit_transactions WHERE source_id=$1 AND reason_code='bill2_spend'`,[race.id])).rows[0].v),1);
  report.checks.push('report price: concurrent settlements charge once');

  // Content deletion: a complete report is charged, a running one refunded; account erasure refunds and is pending.
  const del = await seed(db);
  await setBalance(db,del.actor,5000);
  const done = await execution(db,del,undefined,false);
  await finish(db,done.id,'completed',{body:completeBody,completeness:'complete'});
  const running = await execution(db,del,undefined,false);
  assert.equal((await erase(db,del,'artifact',del.project)).status,'deleted');
  assert.equal((await fee(db,done.id)).state,'charged','a complete report deleted later is still charged');
  assert.equal((await fee(db,running.id)).state,'refunded','a running report deleted is refunded');
  assert.equal(await wallet(db,del.actor),5000-PRICE);
  await balanced(db,del.actor,'content erasure');
  const acc = await seed(db);
  await setBalance(db,acc.actor,5000);
  await execution(db,acc,undefined,false);
  assert.ok((await db.query('SELECT account_erasure_financial_proof($1) v',[acc.actor])).rows[0].v.financialPending>=1,'a held price is pending');
  await closeAccount(db,acc);
  await db.query('SELECT account_erasure_scrub_content($1)',[acc.actor]);
  assert.equal(await wallet(db,acc.actor),5000,'account erasure refunds a held price');
  // Deletion racing the daily settlement: one lock order (profile, then fee), no deadlock, settled once.
  const rc = await seed(db);
  await setBalance(db,rc.actor,5000);
  const ended = await execution(db,rc,undefined,false);
  await finish(db,ended.id,'cancelled',null);
  const racers = [new Client({connectionString}),new Client({connectionString})];
  await Promise.all(racers.map(x=>x.connect()));
  try {
    const raced = await Promise.all([erase(racers[0],rc,'artifact',rc.project).then(r=>r.status,e=>e.message),
      service(racers[1],'report_fee_settle_due',100).then(()=>'settled',e=>e.message)]);
    // The daily settlement never fails on the race; a deletion that lost it answers the retryable busy refusal.
    assert.equal(raced[1],'settled',JSON.stringify(raced));
    assert.ok(['deleted','review_required'].includes(raced[0])||/CONTENT_ERASURE_BUSY/.test(raced[0]),JSON.stringify(raced));
    if (/CONTENT_ERASURE_BUSY/.test(raced[0])) await erase(racers[0],rc,'artifact',rc.project);
  } finally { await Promise.all(racers.map(x=>x.end())); }
  assert.equal((await fee(db,ended.id)).state,'refunded');assert.equal(await wallet(db,rc.actor),5000,'refunded once');
  report.checks.push('report price: draft deletion charges a complete report and refunds a running one; account erasure refunds; held price pending; deletion racing the daily settlement does not deadlock');

  // Daily job: ended executions settle; one stuck for 3 days with its run closed and settled is refunded.
  const job = await seed(db);
  await setBalance(db,job.actor,5000);
  const jobEnded = await execution(db,job);
  await finish(db,jobEnded.id,'cancelled',null);
  const stuck = await execution(db,job);
  await db.query(`UPDATE report_fees SET created_at=now()-interval '4 days' WHERE execution_id=$1`,[stuck.id]);
  await rpc(db,'bill2_cancel',job.actor,stuck.run.run);
  // Reports still going (older than the ended ones) must not crowd the ended ones out of a small batch.
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
    SELECT gen_random_uuid(),$1,$2,gen_random_uuid(),'{}',0,'running' FROM generate_series(1,3)`,[job.actor,job.session]);
  const stillGoing = (await db.query(`SELECT id FROM runtime_executions WHERE actor_id=$1 AND state='running' AND billing_run_id IS NULL`,[job.actor])).rows;
  for (const r of stillGoing) await db.query(`INSERT INTO report_fees(execution_id,actor_id,credits,pre_deduct_id,state,created_at)
    SELECT $1,$2,500,gen_random_uuid(),'held',now()-interval '2 days'`,[r.id,job.actor]);
  assert.equal(await service(db,'report_fee_settle_due',1),1,'a batch of one still reaches an ended fee behind running ones');
  assert.ok(await service(db,'report_fee_settle_due',100)>=1);
  assert.equal((await fee(db,jobEnded.id)).state,'refunded');assert.equal((await fee(db,stuck.id)).state,'refunded');
  assert.equal(await wallet(db,job.actor),5000);
  report.checks.push('report price: the daily job settles ended executions and refunds a price stuck for 3 days');

  // A report without a price (admitted before 0295) keeps per-call billing.
  const old = await createFixture(db,{actor:f.actor});
  const oc = await rpc(db,'bill2_claim',f.actor,old.run,1,old.claimPayload);
  await rpc(db,'bill2_dispatch',f.actor,old.run,oc.id,oc.dispatchToken);
  await rpc(db,'bill2_record',f.actor,old.run,oc.id,{provider:old.claimPayload.provider,account:'sandbox',model:old.claimPayload.model,
    protocol:old.claimPayload.protocol,providerId:'generation-'+oc.id,source:'response',sourceHash:'c'.repeat(64),
    observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',usage:{inputTokens:400,outputTokens:0}});
  await rpc(db,'bill2_finalize',f.actor,old.run);
  const oldCall = (await db.query('SELECT charged_delta,nominal_source FROM bill2_calls WHERE id=$1',[oc.id])).rows[0];
  assert.ok(Number(oldCall.charged_delta)>=1);assert.equal(oldCall.nominal_source,'nominal');
  for (const role of ['anon','authenticated']) {
    await db.query('SET ROLE '+role);
    try {
      for (const sql of ['SELECT report_fee_settle($1,$1)','SELECT report_fee_settle_due(1)','SELECT report_fixed_price()'])
        await assert.rejects(db.query(sql,sql.includes('$1')?[randomUUID()]:[]),/permission denied/,role+' '+sql);
    } finally { await db.query('RESET ROLE'); }
  }
  report.checks.push('report price: runs without a price keep per-call billing; the entry points are service role only');
}
