/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** 0243: a final Stripe card cancellation settles the cached level from pay_common_membership_facts. */
export async function membershipExpiryStripeCases({admin,service}) {
  const gold=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const pro=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Pro','pro',2900,27900,3480,41760,false,false,0)
    ON CONFLICT(level) DO UPDATE SET monthly_price=2900,yearly_price=27900,monthly_credits=3480,yearly_credits=41760 RETURNING id`)).rows[0].id;
  if(!(await admin.query(`SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace='fixture' AND mode='test'
    AND object_type='price' AND membership_plan_id=$1 AND billing_cycle='monthly' AND offer_kind='standard' AND price_usage='one_time'
    AND is_current`,[pro])).rowCount) await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,
    external_id,membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture','test','price',
    'price_expiry_pro_wallet',$1,'monthly',true,'standard','one_time')`,[pro]);
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},alipay:{enabled:true,annualVerified:true},version}]);
  const month=(date,n=1)=>{const d=new Date(date);d.setUTCMonth(d.getUTCMonth()+n);return d;};
  const level=async user=>(await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[user])).rows[0].membership_level;
  const pay=async(user,plan,method,start,end)=>{
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',$3,'standard','fixture',
      'test',$4,'terms-v1',$5) o`,[user,plan,method,version,JSON.stringify([{kind:'email',key_version:'test-v1',
      digest:user.replaceAll('-','').repeat(2)}])])).rows[0];
    const expiry=new Date(Date.now()+1800000),checkout=`cs_${o.id}`;
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',checkout,expiry]);
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,new Date(start.getTime()-60000)]);
    const card=method==='card';
    const paid=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[o.id,'fixture',checkout,
      `in_expiry_${o.id.slice(0,8)}`,o.amount_total,'usd',card?new Date(start.getTime()+6000):start,card?`sub_${o.id}`:null,
      start,end])).rows[0].v;
    assert.equal(paid.state,'fulfilled',JSON.stringify(paid));
    return {user,sub:paid.subscriptionId,order:o.id};
  };
  // Gold card whose first month ended two hours ago (still renewing, inside the 24-hour grace).
  const goldCard=async()=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const end=new Date(Math.floor(Date.now()/1000)*1000-2*3600000),start=month(end,-1);
    const f=await pay(user,gold,'card',start,end);
    await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[user]);
    return {...f,end};
  };
  const sync=(f,stop,canceled)=>service.query(`SELECT pay_stripe_mp_sync_subscription($1,'fixture',$2,$3) v`,[f.sub,stop,canceled]);
  const renew=async f=>(await service.query(`SELECT pay_stripe_mp_renew_subscription($1,'fixture',$2,6900,'usd',$3,$4,$5) v`,
    [f.sub,`in_expiry_renew_${f.order.slice(0,8)}`,new Date(f.end.getTime()+60000),f.end,month(f.end)])).rows[0].v;

  // Gold card stopped and ended, a Pro wallet term current: the final cancellation drops a stale gold to pro.
  const upgraded=await goldCard();
  await sync(upgraded,true,false);
  const start=new Date(Math.floor(Date.now()/1000)*1000-60000);
  await pay(upgraded.user,pro,'alipay',start,month(start));
  assert.equal(await level(upgraded.user),'pro','admission settled the ended gold before the Pro purchase');
  await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[upgraded.user]);
  await sync(upgraded,false,true);
  assert.equal(await level(upgraded.user),'pro');
  // A running renewed term under refund or refund review is not access in facts, so the level returns to free.
  for(const status of ['pending','review_required']) {
    const refunding=await goldCard();
    assert.equal((await renew(refunding)).state,'fulfilled');
    await admin.query(`UPDATE payment_orders SET refund_approval=jsonb_build_object('status',$2::text)
      WHERE subscription_id=$1 AND source_order_id IS NOT NULL`,[refunding.sub,status]);
    await sync(refunding,false,true);
    assert.equal(await level(refunding.user),'free',status);
    assert.equal((await service.query('SELECT pay_common_membership_facts($1) v',[refunding.user])).rows[0].v
      .internal_membership.mapping_state,'internal_inactive');
  }
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,version:version+1}]);
  return ['0243-stripe-cancel-drops-to-current-pro','0243-stripe-cancel-refund-pending-free','0243-stripe-cancel-refund-review-free'];
}
