/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function upgradeCases({admin,service}) {
 const user=randomUUID(),other=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0),($2,0)',[user,other]);
 const pro=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
  allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Pro','pro',2900,27900,3480,41760,false,false,0)
  ON CONFLICT(level) DO UPDATE SET monthly_price=2900,yearly_price=27900,monthly_credits=3480,yearly_credits=41760 RETURNING id`)).rows[0].id;
 const gold=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
 for(const [plan,cycle] of [[pro,'yearly'],[gold,'monthly']]) await admin.query(`INSERT INTO payment_provider_refs(channel,
  merchant_namespace,mode,object_type,external_id,membership_plan_id,billing_cycle,is_current,offer_kind)
  VALUES('waffo','fixture','test','price',$1,$2,$3,true,'standard')`,[`PROD_${randomUUID().replaceAll('-','')}`,plan,cycle]);
 const digests=JSON.stringify([{kind:'email',key_version:'test-v1',digest:'d'.repeat(64)}]);
 const order=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'yearly','card',
  'standard','fixture','test',1,'terms-v1',$3) o`,[user,pro,digests])).rows[0];
 const pay=async(o,cycle)=>{
  const checkout=`checkout_${o.id}`,start=new Date(Math.floor(Date.now()/1000)*1000),end=new Date(start);
  if(cycle==='yearly') end.setUTCFullYear(end.getUTCFullYear()+1);else end.setUTCMonth(end.getUTCMonth()+1);
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('waffo','fixture','test','checkout',$1,$2)`,[checkout,o.id]);
  return (await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,$4,'usd',$5,$6,$5,$7) v`,
   [o.id,checkout,`payment_${o.id}`,o.amount_total,start,`ORD_${o.id}`,end])).rows[0].v;
 };
 const initial=await pay(order,'yearly');
 const upgrade=async(actor=user,db=service)=>(await db.query(`SELECT o.* FROM pay_waffo_create_transition($1,$2,'monthly','card',
  'standard','fixture',1,'terms-v1',$3,'upgrade',$4) o`,[actor,gold,digests,initial.subscriptionId])).rows[0];
 await assert.rejects(()=>upgrade(other),/TRANSITION_DENIED/);
 await assert.rejects(()=>upgrade(),/UPGRADE_WAIT/);
 await admin.query('UPDATE user_subscriptions SET method_observed_at=now() WHERE id=$1',[initial.subscriptionId]);
 await admin.query('BEGIN');
 try {
  await admin.query("UPDATE user_subscriptions SET current_period_end=now()+interval '48 hours 30 minutes' WHERE id=$1",[initial.subscriptionId]);
  await admin.query('SET LOCAL ROLE service_role');
  await assert.rejects(()=>upgrade(user,admin),/UPGRADE_WAIT/);
 } finally {await admin.query('ROLLBACK');}
 const fresh=await upgrade();
 const request={orderId:fresh.id,userId:user,method:'card',merchant:'fixture',mode:'test',providerRequest:{fixture:true}};
 await assert.rejects(()=>service.query("SELECT pay_waffo_claim_checkout($1,$2,'fixture',$3,now()+interval '32 minutes')",
  [user,fresh.id,request]),/UPGRADE_WAIT/);
 await service.query("SELECT pay_waffo_claim_checkout($1,$2,'fixture',$3,now()+interval '31 minutes')",[user,fresh.id,request]);
 assert.ok(fresh.method_upgrade_charge_at,'next charge is frozen independently of moving subscription periods');

 // Historical admitted fixture: time passed before an asynchronous payment settled.
 await admin.query('BEGIN');
 try {
  const id=randomUUID(),paid=new Date(Math.floor(Date.now()/1000)*1000),end=new Date(paid);end.setUTCMonth(end.getUTCMonth()+1);
  await admin.query('INSERT INTO payment_orders SELECT (jsonb_populate_record(NULL::payment_orders,$1)).*',
   [{...fresh,id,purchase_request_id:randomUUID(),created_at:new Date(paid.getTime()-3*3600000),
    method_upgrade_charge_at:new Date(paid.getTime()+47*3600000)}]);
  const checkout=`checkout_${id}`;
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('waffo','fixture','test','checkout',$1,$2)`,[checkout,id]);
  await admin.query('SET LOCAL ROLE service_role');
  const result=(await admin.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,6900,'usd',$4,$5,$4,$6) v`,
   [id,checkout,`payment_${id}`,paid,`ORD_${id}`,end])).rows[0].v;
  assert.equal(result.reason,'upgrade_payment_after_cutoff');
  const row=(await admin.query('SELECT payment_status,fulfilled_at FROM payment_orders WHERE id=$1',[id])).rows[0];
  assert.equal(row.payment_status,'paid');assert.equal(row.fulfilled_at,null);
  assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[user])).rows[0].credits,3480);
 } finally {await admin.query('ROLLBACK');}
 assert.equal((await admin.query('SELECT method_cancel_requested_at FROM user_subscriptions WHERE id=$1',[initial.subscriptionId])).rows[0].method_cancel_requested_at,null,
  'unpaid upgrade leaves Pro unchanged');
 await pay(fresh,'monthly');
 const prior=(await admin.query('SELECT method_cancel_requested_at,method_cancel_dispatched_at,credit_release_terminated_at FROM user_subscriptions WHERE id=$1',
  [initial.subscriptionId])).rows[0];
 assert.ok(prior.method_cancel_requested_at);assert.equal(prior.method_cancel_dispatched_at,null);assert.equal(prior.credit_release_terminated_at,null);
 assert.equal((await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[user])).rows[0].credits,12450);
 const cancel=(await service.query('SELECT pay_waffo_cancel_intent($1,$2) v',[user,initial.subscriptionId])).rows[0].v;
 assert.equal(cancel.dispatch,true,'confirmed upgrade queues first cancellation instead of swallowing its dispatch');
 return ['upgrade-cross-user-denied','upgrade-full-ttl-before-48h','upgrade-session-max31','upgrade-late-cash-review-no-grant','upgrade-unknown-state-denied','unpaid-upgrade-preserves-pro','paid-upgrade-full-gold-credits',
  'upgrade-preserves-pro-annual-source','upgrade-durable-first-cancel'];
}
