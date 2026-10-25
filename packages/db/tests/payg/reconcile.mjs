/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ARCH-FIX E2 (0391): billing_reconcile_day counts the day in the database and checks every settled call and both
// credit-source ledgers. Runs last, so its window covers every call the suite settled: none may be flagged.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** A current Stripe period of 50 credits for the account (the shape grants.mjs uses). */
async function period(db,actor) {
  const grant=randomUUID(),subscription='sub_'+randomUUID(),invoice='in_'+randomUUID();
  const start=new Date(Date.now()-86400000).toISOString(),end=new Date(Date.now()+86400000).toISOString();
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','pro',true,true,500000000) ON CONFLICT(level) DO NOTHING`,[randomUUID()]);
  const plan=(await db.query("SELECT id FROM membership_plans WHERE level='pro'")).rows[0].id;
  await db.query(`INSERT INTO user_subscriptions(user_id,stripe_subscription_id,membership_plan_id,
    billing_cycle,current_period_start,current_period_end,status) VALUES($1,$2,$3,'monthly',$4,$5,'active')`,
  [actor,subscription,plan,start,end]);
  await db.query(`INSERT INTO subscription_credit_grants(id,user_id,stripe_subscription_id,membership_plan_id,
    billing_cycle,grant_type,grant_period_key,period_start,period_end,total_periods,stripe_invoice_id,credits_granted,idempotency_key)
    VALUES($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,50,$9)`,
  [grant,actor,subscription,plan,'invoice:'+invoice,start,end,invoice,'grant:'+invoice]);
  return grant;
}
const day = async db => (await db.query(`SELECT billing_reconcile_day(now()-interval '1 day',now()+interval '1 minute') v`)).rows[0].v;

export async function reconcileCases({db,report,createFixture,claim,receipt}) {
  // Real settled calls with grants and packs from the whole suite: no false alarm.
  const f = await createFixture(db);
  const grant = await period(db,f.actor);
  const c = await claim(db,f,1,true);
  await receipt(db,f,c,'0.003',{inputTokens:3000,outputTokens:0});
  await db.query('SELECT bill2_finalize($1,$2)',[f.actor,f.run]);
  const clean = await day(db);
  assert.ok(clean.calls.settledCalls>0,'the window has settled calls');
  assert.deepEqual([clean.calls.mismatched,clean.sources.mismatched],[0,0],JSON.stringify({calls:clean.calls,sources:clean.sources}));

  // A period ended between the hold and the settlement: the unreturned period credits are recorded on the settle row,
  // so the call's ledger nets more than its charge and is still balanced (no false alarm).
  for (const ending of ['terminated','reversed']) {
    const e = await createFixture(db,{credits:200});
    const g2 = await period(db,e.actor);
    const held = await claim(db,e,1,true);
    if (ending==='terminated') await db.query('UPDATE user_subscriptions SET credit_release_terminated_at=now() WHERE user_id=$1',[e.actor]);
    else await db.query("UPDATE subscription_credit_grants SET status='reversed' WHERE id=$1",[g2]);
    await receipt(db,e,held,'0.001',{inputTokens:1000,outputTokens:0});
    await db.query('SELECT bill2_finalize($1,$2)',[e.actor,e.run]);
    const intercepted = (await db.query(`SELECT coalesce(sum((metadata->>'refundInterceptedRestoration')::int),0)::int n FROM billing_history
      WHERE operation_type IN ('settle','refund') AND metadata->>'preDeductId'=(SELECT pre_deduct_id::text FROM bill2_calls WHERE id=$1)`,[held.id])).rows[0].n;
    assert.ok(intercepted>0,ending+': the period credits were intercepted');
    const d = await day(db);
    assert.deepEqual([d.calls.mismatched,d.sources.mismatched],[0,0],ending+' '+JSON.stringify({calls:d.calls,sources:d.sources}));
  }

  // More rows than one API read returns (1000): every row is counted.
  const before = await day(db);
  const actor = randomUUID();
  await db.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[actor]);
  // Fixture only (writer triggers are not under test): legacy rows of an erased conversation, the only shape not
  // tied to one run or conversation each.
  await db.query('SET session_replication_role=replica');
  try {
    await db.query(`INSERT INTO token_stats(user_id,model_used,total_cost_usd,total_credits,web_search_count,input_tokens,
      output_tokens,cached_tokens,cache_creation_tokens,content_erased_at,erased_conversation_id)
      SELECT $1,'reconcile-local',0,2,1,0,0,0,0,now(),gen_random_uuid() FROM generate_series(1,1200)`,[actor]);
  } finally { await db.query('SET session_replication_role=origin'); }
  await db.query(`INSERT INTO ai_usage_logs(model_id,status) SELECT 'reconcile-local','success' FROM generate_series(1,1200)`);
  const bulk = await day(db);
  assert.equal(bulk.tokenStatsCount-before.tokenStatsCount,1200);
  assert.equal(bulk.tokenStatsCredits-before.tokenStatsCredits,2400);
  assert.equal(bulk.webSearchCount-before.webSearchCount,1200);
  assert.equal(bulk.successfulAiRequests-before.successfulAiRequests,1200);

  // An injected difference is reported: an extra ledger row on the call, and a grant consumed outside both ledgers.
  assert.ok((await db.query('SELECT consumed_amount FROM subscription_credit_grants WHERE id=$1',[grant])).rows[0].consumed_amount>0,
    'the call consumed from the current period');
  await db.query('SET session_replication_role=replica');
  try {
    await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,
      bill2_run_id,bill2_call_id) VALUES($1,5,'adjustment','adjustment','bill2_compensation','ai_task',$2,$3,$4)`,
    [f.actor,'reconcile-local:'+c.id,f.run,c.id]);
    await db.query('UPDATE subscription_credit_grants SET consumed_amount=consumed_amount+1 WHERE id=$1',[grant]);
  } finally { await db.query('SET session_replication_role=origin'); }
  const drift = await day(db);
  assert.equal(drift.calls.mismatched,1);
  assert.deepEqual(drift.calls.sample,[c.id]);
  assert.equal(drift.sources.mismatched,1);
  assert.deepEqual(drift.sources.sample,[{kind:'subscription_grant',id:grant}]);
  // Put the fixtures back so later suites see consistent ledgers.
  await db.query('SET session_replication_role=replica');
  try {
    await db.query('DELETE FROM credit_transactions WHERE idempotency_key=$1',['reconcile-local:'+c.id]);
    await db.query('UPDATE subscription_credit_grants SET consumed_amount=consumed_amount-1 WHERE id=$1',[grant]);
  } finally { await db.query('SET session_replication_role=origin'); }
  assert.deepEqual([(await day(db)).calls.mismatched,(await day(db)).sources.mismatched],[0,0]);
  report.checks.push('E2 reconcile: every call settled by the suite and every active grant/pack balances; 1200 rows counted exactly; injected call and grant differences reported');
}
