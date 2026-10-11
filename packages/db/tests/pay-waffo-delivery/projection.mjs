/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function projectionCases({admin,service}) {
 await admin.query("INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Free','free',false,false,100) ON CONFLICT(level) DO NOTHING");
 await admin.query("UPDATE membership_plans SET library_storage_bytes=CASE level WHEN 'gold' THEN 300 WHEN 'pro' THEN 200 ELSE 100 END");
 const facts=async(user)=>(await service.query('SELECT pay_common_membership_facts($1) v',[user])).rows[0].v;
 const check=async(user,level,closed=false)=>{
  const f=await facts(user);
  assert.equal(f.internal_membership?.membership_level,level);
  if(closed) await assert.rejects(()=>service.query('SELECT library_list($1)',[user]),/ACCOUNT_CLOSED/);
  else assert.equal((await service.query('SELECT library_list($1) v',[user])).rows[0].v.capacityBytes,
   level==='gold'?300:level==='pro'?200:100);
  if(level==='free') await assert.rejects(()=>service.query('SELECT report_membership_check($1)',[user]),/MEMBERSHIP_REQUIRED|ACTOR_DENIED/);
  else await service.query('SELECT report_membership_check($1)',[user]);
 };
 const active=(await admin.query(`SELECT o.* FROM payment_orders o WHERE o.item_type='membership_plan'
  AND o.payment_method='alipay' AND o.offer_kind='standard' AND o.billing_cycle='monthly' AND o.status='completed'
  AND o.entitlement_end>now() ORDER BY o.created_at LIMIT 1`)).rows[0];
 assert.ok(active);
 await check(active.user_id,'gold');
 // Cached profile and mutable provider period cannot grant or revoke the paid order's time.
 await admin.query("UPDATE profiles SET membership_level='free' WHERE id=$1",[active.user_id]);
 await admin.query("UPDATE user_subscriptions SET current_period_end=now()-interval '1 day',status='canceled' WHERE id=$1",[active.subscription_id]);
 await check(active.user_id,'gold');
 await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[active.user_id]);
 for(const [field,value] of [['payment_status','refunded'],['status','partially_refunded'],['qualification_state','review']]) {
  const old=active[field];await admin.query(`UPDATE payment_orders SET ${field}=$2 WHERE id=$1`,[active.id,value]);
  await check(active.user_id,'free');await admin.query(`UPDATE payment_orders SET ${field}=$2 WHERE id=$1`,[active.id,old]);
 }
 for(const mutation of ["metadata=jsonb_build_object('refund',jsonb_build_object('reviewRequired',true))",
  "refund_approval=jsonb_build_object('status','review_required')","method_review_reason='cash_conflict'"]) {
  await admin.query(`UPDATE payment_orders SET ${mutation} WHERE id=$1`,[active.id]);await check(active.user_id,'free');
  await admin.query("UPDATE payment_orders SET metadata=$2,refund_approval=NULL,method_review_reason=NULL WHERE id=$1",[active.id,active.metadata]);
 }
 await admin.query("UPDATE user_subscriptions SET credit_release_terminated_at=now() WHERE id=$1",[active.subscription_id]);
 await check(active.user_id,'free');
 await admin.query("UPDATE user_subscriptions SET credit_release_terminated_at=NULL WHERE id=$1",[active.subscription_id]);
 await admin.query("UPDATE profiles SET is_deleted='true' WHERE id=$1",[active.user_id]);await check(active.user_id,'free',true);
 await admin.query("UPDATE profiles SET is_deleted='false' WHERE id=$1",[active.user_id]);
 // Expired founder in a grace window has no unpaid access. Early successor is not yet active.
 const expired=(await admin.query(`SELECT o.user_id FROM payment_orders o WHERE o.offer_kind='founder'
  AND o.entitlement_end BETWEEN now()-interval '9 days' AND now() AND NOT EXISTS
  (SELECT 1 FROM payment_orders x WHERE x.user_id=o.user_id AND x.entitlement_end>now()) LIMIT 1`)).rows[0];
 assert.ok(expired);await check(expired.user_id,'free');
 const early=(await admin.query(`SELECT user_id FROM payment_orders WHERE method_transition='founder_renewal'
  AND entitlement_start>now() AND fulfilled_at IS NOT NULL LIMIT 1`)).rows[0];
 assert.ok(early);await check(early.user_id,'gold');
 const upgraded=(await admin.query(`SELECT * FROM payment_orders WHERE method_transition='upgrade' AND fulfilled_at IS NOT NULL
  AND entitlement_end>now() LIMIT 1`)).rows[0];
 assert.ok(upgraded);await check(upgraded.user_id,'gold');
 await admin.query("UPDATE payment_orders SET payment_status='refunded' WHERE id=$1",[upgraded.id]);
 await check(upgraded.user_id,'pro');
 await admin.query("UPDATE payment_orders SET payment_status='paid' WHERE id=$1",[upgraded.id]);
 // The existing manual authority remains available after a deliberate newer admin grant.
 await admin.query(`UPDATE user_subscriptions SET status='admin_override',metadata='{"adminOverride":{"newLevel":"gold"}}',
  updated_at=clock_timestamp() WHERE id=$1`,[active.subscription_id]);
 assert.equal((await facts(active.user_id)).internal_membership,null);
 await service.query('SELECT report_membership_check($1)',[active.user_id]);
 assert.equal((await service.query('SELECT library_list($1) v',[active.user_id])).rows[0].v.capacityBytes,300);
 // An ordinary expired wallet must lose access even when profile cleanup is delayed.
 const elapsed=randomUUID();await admin.query('INSERT INTO profiles(id) VALUES($1)',[elapsed]);
 const order=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','alipay',
  'standard','fixture','test',1,'terms-v1',$3) o`,[elapsed,active.item_id,
  JSON.stringify([{kind:'email',key_version:'test-v1',digest:elapsed.replaceAll('-','').repeat(2)}])])).rows[0];
 const dates=(await admin.query("SELECT now()-interval '2 months' AS start,now()-interval '1 month' AS finish")).rows[0];
 // Derive the exact calendar end from the original anchor, including month-end clamping.
 dates.finish=(await admin.query("SELECT (($1::timestamptz AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' AS v",[dates.start])).rows[0].v;
 await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[order.id,dates.start]);
 const checkout=`expired_${order.id}`;
 await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
  VALUES('stripe','fixture','test','checkout',$1,$2)`,[checkout,order.id]);
 await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,6900,'usd',$4,NULL,$4,$5)`,
  [order.id,checkout,`paid_${order.id}`,dates.start,dates.finish]);
 await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[elapsed]);await check(elapsed,'free');
 // Owner-only facts and legacy/manual users retain the prior branch.
 const legacy=randomUUID();await admin.query("INSERT INTO profiles(id,membership_level) VALUES($1,'pro')",[legacy]);
 assert.equal((await facts(legacy)).internal_membership,null);
 await service.query('SELECT report_membership_check($1)',[legacy]);
 await admin.query('SET ROLE authenticated');
 try {await assert.rejects(()=>admin.query('SELECT pay_common_membership_facts($1)',[active.user_id]),/ACCESS_DENIED/);}
 finally {await admin.query('RESET ROLE');}
 return ['ordinary-wallet-expiry','internal-paid-wallet-permissions','paid-order-not-profile-or-provider-period','refunded-and-review-denied',
  'terminated-and-deleted-denied','expired-grace-no-access','early-founder-keeps-current-period',
  'upgrade-gold-priority-and-refund-pro-fallback','manual-authority-preserved','cross-user-facts-denied'];
}
