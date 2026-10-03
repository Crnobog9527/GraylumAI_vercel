/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {conserved,financial} from './core.mjs';

async function period(db,actor,credits=4) {
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
    VALUES($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,$9,$10)`,
  [grant,actor,subscription,plan,'invoice:'+invoice,start,end,invoice,credits,'grant:'+invoice]);
  return {grant,subscription};
}
export async function grantCases(db,report,createFixture,claim,receipt) {
  for (const status of ['normal','expired','reversed','terminated']) {
    const f=await createFixture(db);
    const g=await period(db,f.actor);
    const c=await claim(db,f,1,true);
    await receipt(db,f,c,'0.003',{inputTokens:3000,outputTokens:0});
    assert.equal((await db.query('SELECT consumed_amount FROM subscription_credit_grants WHERE id=$1',[g.grant])).rows[0].consumed_amount,3);
    if(status==='expired') await db.query("UPDATE subscription_credit_grants SET period_end=now()-interval '1 hour' WHERE id=$1",[g.grant]);
    if(status==='reversed') await db.query("UPDATE subscription_credit_grants SET status='reversed' WHERE id=$1",[g.grant]);
    if(status==='terminated') await db.query('UPDATE user_subscriptions SET credit_release_terminated_at=now() WHERE stripe_subscription_id=$1',[g.subscription]);
    await rpc(db,'bill2_close',f.actor,f.run,'confirmed_failure',{
      kind:'confirmed_delivery_failure',evidenceRef:'local-proof',evidenceHash:'d'.repeat(64),body:'local proof',
    });
    await rpc(db,'bill2_finalize',f.actor,f.run);
    assert.equal((await financial(db,f)).credits,status==='normal'?100:97,status);
    const compensation=(await db.query('SELECT compensation_credits FROM bill2_calls WHERE id=$1',[c.id])).rows[0].compensation_credits;
    assert.equal(compensation,status==='normal'?3:0);
    await conserved(db,f);
  }
  const quarantine=await createFixture(db);
  const g=await period(db,quarantine.actor);
  await db.query("UPDATE subscription_credit_grants SET accounting_state='review_required',accounting_review_reason='local fixture' WHERE id=$1",[g.grant]);
  await assert.rejects(claim(db,quarantine,1,false),/GRANT_ACCOUNTING_REVIEW_REQUIRED/);
  assert.equal((await financial(db,quarantine)).credits,100);
  assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[quarantine.run])).rows[0].n,0);
  report.checks.push('normal grant compensation restores original source; expired/reversed/terminated sources never resurrect; quarantine rejects new hold');
}
