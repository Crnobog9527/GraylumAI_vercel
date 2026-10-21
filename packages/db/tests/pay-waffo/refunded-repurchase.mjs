/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** 0328: only a canceled subscription whose credit release ended stops blocking repurchase. */
export async function refundedRepurchaseCases({admin,service,connect,refunded,plan,version}) {
  const buy=(db,user)=>db.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',
    'card','standard','fixture','test',$3,'terms-v1',$4) o`,[user,plan,version,
    JSON.stringify([{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}])]);
  const future=new Date(Date.now()+29*86400000);
  const fixture=async(status,terminated,reason=null)=>{
    const user=randomUUID();
    await admin.query("INSERT INTO profiles(id,credits,membership_level) VALUES($1,0,'free')",[user]);
    await admin.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,billing_cycle,status,
      current_period_start,current_period_end,cancel_at_period_end,credit_release_terminated_at,
      credit_release_terminated_reason,stripe_subscription_id)
      VALUES($1,$2,$3,'monthly',$4,now(),$5,true,$6,$7,'sub_refund_guard_'||$1::uuid::text)`,
    [randomUUID(),user,plan,status,future,terminated?new Date():null,reason]);
    return user;
  };
  // Canceled alone retains paid rights through period end. A reason without its final timestamp is not proof.
  for(const reason of [null,'approved_monthly_refund']) {
    const user=await fixture('canceled',false,reason);
    await assert.rejects(()=>buy(service,user),/PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED/);
    assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[user])).rows[0].n,0);
  }
  // Even a contradictory termination marker must never waive a still-chargeable provider status.
  for(const status of ['active','trialing','past_due','incomplete','unpaid']) {
    for(const terminated of [false,true]) {
      const user=await fixture(status,terminated,terminated?'approved_monthly_refund':null);
      await assert.rejects(()=>buy(service,user),/PAY_WAFFO_MEMBERSHIP_TRANSITION_REQUIRED/);
      assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[user])).rows[0].n,0);
    }
  }
  // The real approval/result/cancel/finish flow above left a future period end and recovered all membership.
  const sub=(await admin.query(`SELECT status,credit_release_terminated_at,credit_release_terminated_reason,
    current_period_end>now() AS future FROM user_subscriptions WHERE id=$1`,[refunded.sub])).rows[0];
  assert.equal(sub.status,'canceled');
  assert.ok(sub.credit_release_terminated_at);
  assert.equal(sub.credit_release_terminated_reason,'approved_monthly_refund');
  assert.equal(sub.future,true);
  const before=(await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[refunded.user])).rows[0];
  assert.deepEqual(before,{credits:0,membership_level:'free'});
  // First regression assertion: the pre-0328 gate refuses this legitimate purchase.
  const one=await connect(),two=await connect();
  await one.query('SET ROLE service_role');
  await two.query('SET ROLE service_role');
  const both=await Promise.all([buy(one,refunded.user),buy(two,refunded.user)]);
  const first=both[0].rows[0];
  assert.equal(both[1].rows[0].id,first.id);
  assert.equal((await buy(service,refunded.user)).rows[0].id,first.id);
  assert.equal((await admin.query(`SELECT count(*)::int n FROM payment_orders
    WHERE user_id=$1 AND id<>$2`,[refunded.user,refunded.order])).rows[0].n,1);
  assert.deepEqual((await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[refunded.user])).rows[0],before);
  assert.equal((await admin.query('SELECT status FROM payment_orders WHERE id=$1',[refunded.order])).rows[0].status,
    'partially_refunded','the retained fee and refund history are preserved');
  // Timestamp is the authoritative termination flag, not a reason string.
  const ended=await fixture('canceled',true);
  assert.ok((await buy(service,ended)).rows[0].id);
  return ['refunded-monthly-repurchase','canceled-unrefunded-still-blocks','refund-reason-alone-still-blocks',
    'chargeable-statuses-still-block','refunded-repurchase-repeat-concurrent-one-order',
    'termination-timestamp-authority'];
}
