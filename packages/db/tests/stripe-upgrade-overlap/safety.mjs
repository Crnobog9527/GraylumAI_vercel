/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {historyFixture} from './history.mjs';

export async function safetyCases({admin,user,proSub,goldSub,proCycle,pre}) {
  const transaction=async fn=>{
    await admin.query('BEGIN');
    try {await fn();} finally {await admin.query('ROLLBACK');}
  };
  await transaction(async()=>{
    await admin.query(`UPDATE subscription_credit_grants SET accounting_state='review_required',
      accounting_review_reason='Local safety fixture' WHERE subscription_id=$1`,[proSub]);
    await assert.rejects(pre(admin,20),/PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED/);
  });
  await transaction(async()=>{
    // A third, unrelated legacy grant still fails closed instead of being hidden by an upgrade.
    const sub='sub_'+randomUUID(),invoice='in_'+randomUUID();
    const plan=(await admin.query('SELECT membership_plan_id FROM user_subscriptions WHERE id=$1',[proSub])).rows[0].membership_plan_id;
    const start=new Date(Date.now()-86400000),end=new Date(Date.now()+86400000);
    await admin.query(`INSERT INTO user_subscriptions(user_id,stripe_subscription_id,membership_plan_id,
      billing_cycle,current_period_start,current_period_end,status) VALUES($1,$2,$3,'monthly',$4,$5,'active')`,
    [user,sub,plan,start,end]);
    await admin.query(`INSERT INTO subscription_credit_grants(user_id,stripe_subscription_id,membership_plan_id,
      billing_cycle,grant_type,grant_period_key,period_start,period_end,total_periods,stripe_invoice_id,credits_granted,idempotency_key)
      VALUES($1,$2,$3,'monthly','monthly_invoice',$4,$5,$6,1,$7,100,$8)`,
    [user,sub,plan,'invoice:'+invoice,start,end,invoice,'grant:'+invoice]);
    await assert.rejects(pre(admin,20),/PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS: 3/);
  });
  await transaction(async()=>{
    await admin.query("UPDATE subscription_credit_grants SET period_end=period_end+interval '1 hour' WHERE subscription_id=$1",[proSub]);
    await assert.rejects(pre(admin,20),/PRE_DEDUCT_AMBIGUOUS_CANONICAL_GRANT_WINDOWS|PRE_DEDUCT_NONCANONICAL_GRANT_WINDOW/);
  });
  const hold=actor=>admin.query("SELECT * FROM atomic_pre_deduct($1,9000,'Historical overlap',$2)",[actor,randomUUID()]);
  await transaction(async()=>{
    const f=await historyFixture(admin,{user,proSub,goldSub,proMonths:proCycle==='yearly'?13:2});
    await admin.query("UPDATE user_subscriptions SET status='canceled' WHERE id=$1",[f.pro]);
    const facts=(await admin.query('SELECT pay_common_membership_facts($1) v',[f.actor])).rows[0].v.internal_membership;
    assert.equal(facts.id,f.gold);
    assert.equal(facts.membership_level,'gold');
    await hold(f.actor);
    assert.equal((await admin.query(`SELECT consumed_amount FROM subscription_credit_grants WHERE subscription_id=$1`,
      [f.pro])).rows[0].consumed_amount,30,'old, paid credits remain usable after the original term ends');
  });
  if(proCycle==='yearly') await transaction(async()=>{
    const f=await historyFixture(admin,{user,proSub,goldSub,proMonths:1});
    assert.equal((await admin.query('SELECT pay_waffo_grant_period($1,2) n',[f.proOrder])).rows[0].n,3480);
    assert.equal((await admin.query('SELECT pay_waffo_grant_period($1,2) n',[f.proOrder])).rows[0].n,0);
    const facts=(await admin.query('SELECT pay_common_membership_facts($1) v',[f.actor])).rows[0].v.internal_membership;
    assert.equal(facts.id,f.gold,'Pro annual release cannot replace Gold access');
    await hold(f.actor);
    const remaining=(await admin.query(`SELECT sum(credits_granted-consumed_amount)::int n FROM subscription_credit_grants
      WHERE user_id=$1`,[f.actor])).rows[0].n;
    assert.equal(remaining,3480+3480+8970-9000);
  });
  if(proCycle==='yearly') await transaction(async()=>{
    const f=await historyFixture(admin,{user,proSub,goldSub,proMonths:2,goldMonths:2});
    assert.equal((await admin.query('SELECT pay_waffo_grant_period($1,3) n',[f.proOrder])).rows[0].n,3480);
    const facts=(await admin.query('SELECT pay_common_membership_facts($1) v',[f.actor])).rows[0].v.internal_membership;
    assert.equal(facts.id,f.pro,'expired Gold falls back to the still-paid Pro annual term');
    assert.equal(facts.membership_level,'pro');
    await hold(f.actor);
    await admin.query(`INSERT INTO opc_businesses(actor_id,name)
      SELECT $1,'Natural downgrade fixture' FROM generate_series(1,3)`,[f.actor]);
    // A stale caller and cached Gold tier must not retain Gold's six-profile cap after expiry.
    await assert.rejects(admin.query(`SELECT opc_start_b1($1,$2,'missing-overlap-fixture','manual',NULL,'test','gold')`,
      [f.actor,randomUUID()]),/OPC_PROFILE_LIMIT/);
  });
  return ['overlap-untrusted-refused','overlap-unrelated-third-refused','overlap-noncanonical-refused',
    'overlap-expired-pro-credits-retained',...(proCycle==='yearly'?['overlap-annual-pro-release-once-keeps-gold',
      'overlap-gold-expiry-downgrades-to-paid-pro-and-cap']:[])];
}
