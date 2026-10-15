/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP step 4a (0251): Pro -> Gold upgrade of a renewing card subscription. */
export async function stripeMpUpgradeCases({admin,service}) {
  const gold=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const pro=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Pro','pro',2900,27900,3480,41760,false,false,0)
    ON CONFLICT(level) DO UPDATE SET monthly_price=2900,yearly_price=27900,monthly_credits=3480,yearly_credits=41760 RETURNING id`)).rows[0].id;
  if(!(await admin.query(`SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace='fixture' AND mode='test'
    AND object_type='price' AND membership_plan_id=$1 AND billing_cycle='monthly' AND offer_kind='standard' AND price_usage='subscription'
    AND is_current`,[pro])).rowCount) await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,
    external_id,membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture','test','price',
    'price_upgrade_pro_card',$1,'monthly',true,'standard','subscription')`,[pro]);
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const terms=digest=>JSON.stringify([{kind:'email',key_version:'test-v1',digest}]);
  const bind=async(user,o,method)=>{
    const expiry=new Date(Date.now()+1800000),id=`cs_${o.id}`;
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',id,expiry]);
    return id;
  };
  const pay=async(user,o,method,start,end)=>(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
    [o.id,'fixture',await bind(user,o,method),`in_${o.id}`,o.amount_total,'usd',new Date(),`sub_${o.id}`,start,end])).rows[0].v;
  // A renewing card Pro, paid a day ago for a calendar month: far from the 48-hour renewal cutoff.
  const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
  const proOrder=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card','standard',
    'fixture','test',$3,'terms-v1',$4) o`,[user,pro,version,terms('b1'.repeat(32))])).rows[0];
  const start=new Date(Math.floor(Date.now()/1000)*1000-86400000),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[proOrder.id,new Date(start.getTime()-60000)]);
  const proPaid=await pay(user,proOrder,'card',start,end);
  assert.equal(proPaid.state,'fulfilled',JSON.stringify(proPaid));
  const proSub=proPaid.subscriptionId;
  const upgrade=()=>service.query(`SELECT o.* FROM pay_waffo_create_transition($1,$2,'monthly','card','standard','fixture',$3,'terms-v1',
    $4,'upgrade',$5) o`,[user,gold,version,terms('b1'.repeat(32)),proSub]);
  const observe=(sub=proSub,db=service)=>db.query(`SELECT pay_stripe_mp_observe_subscription($1,'fixture') v`,[sub]);

  // Without a fresh provider observation a renewing Pro cannot upgrade (0222 admission).
  await assert.rejects(upgrade,/UPGRADE_WAIT/);
  assert.ok((await observe()).rows[0].v,'Stripe seen renewing: the observation is recorded');
  const goldOrder=(await upgrade()).rows[0];
  assert.deepEqual([goldOrder.method_transition,goldOrder.method_prior_subscription,goldOrder.source_order_id],['upgrade',proSub,proOrder.id]);
  // Delivering the Gold marks the Pro for stopping; the server then stops it at Stripe (cardUpgrade.ts).
  const goldStart=new Date(Math.floor(Date.now()/1000)*1000-60000),goldEnd=new Date(goldStart);goldEnd.setUTCMonth(goldEnd.getUTCMonth()+1);
  const goldPaid=await pay(user,goldOrder,'card',goldStart,goldEnd);
  assert.equal(goldPaid.state,'fulfilled',JSON.stringify(goldPaid));
  assert.ok((await admin.query('SELECT method_cancel_requested_at FROM user_subscriptions WHERE id=$1',[proSub])).rows[0].method_cancel_requested_at);
  // A Pro our record shows stopping is not observed as renewing, whatever Stripe said a moment ago.
  assert.equal((await observe()).rows[0].v,null);
  await service.query(`SELECT pay_stripe_mp_sync_subscription($1,'fixture',true,false,false)`,[proSub]);
  assert.equal((await observe()).rows[0].v,null);

  // Scope: only Stripe card subscriptions of this merchant, service role only.
  await assert.rejects(()=>service.query(`SELECT pay_stripe_mp_observe_subscription($1,'other_merchant')`,[proSub]),/RENEW_SCOPE/);
  await assert.rejects(()=>observe(randomUUID()),/RENEW_SCOPE/);
  for(const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>observe(),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['stripe-mp-upgrade-needs-observation','stripe-mp-upgrade-observed-admitted','stripe-mp-upgrade-links-prior',
    'stripe-mp-upgrade-marks-pro-stop','stripe-mp-upgrade-stopping-not-observed','stripe-mp-upgrade-observe-scope'];
}
