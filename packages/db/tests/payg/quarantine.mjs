/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// ARCH-FIX E1 (0390): one quarantine rule for credits of a terminated subscription, matched by subscription_id.
// Grants without a stripe_subscription_id (Waffo, wallet, some Stripe MP) were not quarantined by the claim,
// the review price check or the report price hold; Stripe grants keep their result.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

/** kind: 'waffo' (subscription_id, no stripe id), 'stripe' (both ids), 'legacy' (stripe id only on the grant). */
async function plan(db) {
  await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','pro',true,true,500000000) ON CONFLICT(level) DO NOTHING`,[randomUUID()]);
  return (await db.query("SELECT id FROM membership_plans WHERE level='pro'")).rows[0].id;
}
/** kind: 'waffo' (subscription_id, no stripe id), 'stripe' (both ids), 'legacy' (stripe id only on the grant). */
export async function terminatedGrant(db,actor,{kind='waffo',credits=100,terminated=true}={}) {
  const sub=randomUUID(),external=kind==='waffo'?null:'sub_'+randomUUID(),key=randomUUID(),planId=await plan(db);
  const start=new Date(Date.now()-86400000).toISOString(),end=new Date(Date.now()+86400000).toISOString();
  const snapshot=kind==='waffo'?{version:1,item_type:'membership_plan',item_id:planId,item_updated_at:'2026-10-01T00:00:00Z',
    billing_cycle:'monthly',currency:'usd',unit:'major',price:'10',discount:'0',tax_behavior:'unspecified',credits:credits,bonus_credits:0}:null;
  await db.query(`INSERT INTO user_subscriptions(id,user_id,stripe_subscription_id,membership_plan_id,billing_cycle,
    current_period_start,current_period_end,status,payment_channel,merchant_namespace,payment_mode,contract_snapshot,
    credit_release_terminated_at) VALUES($1,$2,$3,$4,'monthly',$5,$6,'canceled',$7,$8,$9,$10,$11)`,
  [sub,actor,external,planId,start,end,kind==='waffo'?'waffo':null,kind==='waffo'?'local':null,kind==='waffo'?'test':null,
    snapshot,terminated?new Date().toISOString():null]);
  // Fixture only: a Waffo grant needs its paid, sold order (0204 source guard); that issuance path is not under test.
  await db.query('SET session_replication_role=replica');
  const order=randomUUID();
  try {
    if (kind==='waffo') await db.query(`INSERT INTO payment_orders(id,user_id,subscription_id,item_type,item_id,billing_cycle,
      mode,status) VALUES($1,$2,$3,'membership_plan',$4,'monthly','subscription','completed')`,[order,actor,sub,planId]);
    await db.query(`INSERT INTO subscription_credit_grants(user_id,subscription_id,stripe_subscription_id,membership_plan_id,
      billing_cycle,grant_type,grant_period_key,period_start,period_end,total_periods,credits_granted,idempotency_key,
      source_order_id,grant_snapshot) VALUES($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,$9,$10,$11)`,
    [actor,kind==='legacy'?null:sub,external,planId,'local:'+key,start,end,credits,'grant:'+key,
      kind==='waffo'?order:null,snapshot]);
  } finally { await db.query('SET session_replication_role=origin'); }
  return {sub,order};
}
const balance=async(db,actor)=>(await db.query('SELECT credits FROM profiles WHERE id=$1',[actor])).rows[0].credits;
const calls=async(db,run)=>(await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[run])).rows[0].n;

export async function quarantineCases({db,Client,connectionString,report,createFixture,claim}) {
  // Claim: the whole balance is a terminated grant remainder, so the call waits for credits on every kind.
  for (const kind of ['waffo','stripe','legacy']) {
    const f=await createFixture(db);
    await terminatedGrant(db,f.actor,{kind});
    const c=await claim(db,f,1,false);
    assert.equal(c.state,'waiting_credits',kind+': claim does not spend a terminated grant');
    // Repeat: the same claim again is refused the same way, without a call row or a balance change.
    assert.equal((await claim(db,f,1,false)).state,'waiting_credits',kind+': repeated claim');
    assert.equal(await calls(db,f.run),0);
    assert.equal(await balance(db,f.actor),100);
    // Review price check and the pre-deduction primitive subtract the same remainder.
    assert.equal(await rpc(db,'fusion_review_available',f.actor,100),0,kind+': review available');
    await assert.rejects(db.query("SELECT atomic_pre_deduct($1,1,'local',$2)",[f.actor,randomUUID()]),/PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED/,kind+': pre-deduct');
    const rows=(await db.query("SELECT usable,held FROM credit_source_rows($1) WHERE kind='subscription_grant'",[f.actor])).rows;
    assert.deepEqual(rows,[{usable:false,held:true}],kind+': source rows');
  }
  // Not terminated: nothing is quarantined (spending a live grant end to end: grants.mjs).
  const live=await createFixture(db);
  await terminatedGrant(db,live.actor,{kind:'waffo',terminated:false});
  assert.equal(await rpc(db,'fusion_review_available',live.actor,100),100);
  assert.deepEqual((await db.query("SELECT usable,held FROM credit_source_rows($1) WHERE kind='subscription_grant'",[live.actor])).rows,
    [{usable:true,held:false}]);
  // A monthly first-purchase refund hold on the subscription quarantines its grant too (same rule as source rows).
  const held=await createFixture(db);
  const {order}=await terminatedGrant(db,held.actor,{kind:'waffo',terminated:false});
  await db.query('UPDATE payment_orders SET refund_approval=$2 WHERE id=$1',[order,{kind:'monthly_first_purchase',hold:'held'}]);
  assert.equal(await rpc(db,'fusion_review_available',held.actor,100),0,'first-purchase hold');
  // Concurrency: two runs of one account claim at once against a terminated Waffo grant; both wait, nothing is held.
  const a=await createFixture(db);
  const b=await createFixture(db,{actor:a.actor});
  await terminatedGrant(db,a.actor,{kind:'waffo'});
  const clients=[new Client({connectionString}),new Client({connectionString})];
  await Promise.all(clients.map(x=>x.connect()));
  try {
    const states=await Promise.all([[clients[0],a],[clients[1],b]].map(([x,f])=>claim(x,f,1,false).then(c=>c.state)));
    assert.deepEqual(states,['waiting_credits','waiting_credits']);
  } finally { await Promise.all(clients.map(x=>x.end())); }
  assert.equal(await calls(db,a.run)+await calls(db,b.run),0);
  assert.equal(await balance(db,a.actor),100);
  report.checks.push('E1 quarantine: terminated Waffo/Stripe/legacy grants are excluded from claim, review, pre-deduct and source rows; repeat and concurrent claims wait; live grant unaffected');
}
