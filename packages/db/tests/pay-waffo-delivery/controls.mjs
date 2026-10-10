/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function controlCases({admin,service,connect}) {
 const actor=randomUUID(),other=randomUUID();
 await admin.query("INSERT INTO profiles(id,role) VALUES($1,'admin'),($2,'user')",[actor,other]);
 const absentUser=randomUUID();await admin.query('INSERT INTO profiles(id) VALUES($1)',[absentUser]);
 const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
 const purchase=async()=>(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',
  'alipay','standard','fixture','test',1,'terms-v1',$3) o`,[absentUser,plan,
  JSON.stringify([{kind:'email',key_version:'test-v1',digest:'9'.repeat(64)}])])).rows[0];
 const absent=await purchase();
 await service.query("SELECT pay_waffo_claim_checkout($1,$2,'fixture',$3,now()+interval '30 minutes')",
  [absentUser,absent.id,{orderId:absent.id,userId:absentUser,method:'alipay',merchant:'fixture',mode:'test',providerRequest:{fixture:true}}]);
 const close=()=>service.query("SELECT pay_waffo_close_uncreated($1,$2,'fixture')",[absentUser,absent.id]);
 await assert.rejects(close,/CLOSE_DENIED/);
 await admin.query("UPDATE payment_orders SET method_checkout_expires_at=now()-interval '2 hours' WHERE id=$1",[absent.id]);
 await close();await close();assert.notEqual((await purchase()).id,absent.id);
 assert.match((await admin.query('SELECT qualification_closed_ref FROM payment_orders WHERE id=$1',[absent.id])).rows[0].qualification_closed_ref,
  /^verified_absent:/);
 for(let i=0;i<5;i++) {
  const receipt=(await service.query("SELECT pay_waffo_receive_event('fixture','test','subscription.payment_succeeded',$1,$2,$3) id",
   [`offsite-${i}`,'a'.repeat(64),{paymentId:`PAY_offsite${i}`,...(i%2?{}:{subscriptionId:`ORD_offsite${i}`}),orderId:`ORD_offsite${i}`}])).rows[0].id;
  const cash={paymentId:`PAY_offsite${i}`,subscriptionId:`ORD_offsite${i}`,productId:'PROD_fixture',amount:6900,currency:'usd',paidAt:new Date().toISOString()};
  const record=async()=>(await service.query("SELECT pay_waffo_record_offsite($1,'fixture',$2) v",[receipt,cash])).rows[0].v;
  const result=await record();assert.equal(result.payments24h,i+1);assert.equal(result.alert,i===4);
  assert.deepEqual(await record(),result,'repeated receipt does not amplify counters');
  assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[actor])).rows[0].n,0);
 }
 const ref=(await admin.query("UPDATE payment_provider_refs SET external_id='PROD_fixture' WHERE channel='waffo' AND offer_kind='gold_first30' RETURNING id")).rows[0].id;
 const control=async(user,block,version)=>(await service.query('SELECT pay_waffo_product_control($1,$2,$3,$4) v',[user,ref,block,version])).rows[0].v;
 await assert.rejects(()=>control(other,true,0),/ADMIN_REQUIRED/);
 const pending=await control(actor,true,0);assert.equal(pending.state,'blocking');
 assert.equal((await control(actor,true,1)).operationId,pending.operationId,'unknown result recovers same operation');
 await assert.rejects(()=>control(actor,true,0),/CONTROL_VERSION/);
 const resolve=async(op,status)=>(await service.query('SELECT pay_waffo_product_control_result($1,$2,$3) v',[ref,op,status])).rows[0].v;
 assert.equal((await resolve(pending.operationId,'inactive')).state,'blocked');
 await assert.rejects(()=>service.query(`SELECT pay_waffo_create_purchase($1,'membership_plan',
  (SELECT membership_plan_id FROM payment_provider_refs WHERE id=$2),'monthly','card','gold_first30','fixture','test',1,'terms-v1',$3)`,
 [other,ref,JSON.stringify([{kind:'email',key_version:'test-v1',digest:'f'.repeat(64)}])]),/PRODUCT_PAUSED/);
 const restoring=await control(actor,false,1);assert.equal(restoring.state,'restoring');
 const restored=await resolve(restoring.operationId,'active');assert.equal(restored.history.length,1);
 const sub=(await admin.query("SELECT id,user_id FROM user_subscriptions WHERE payment_channel='waffo' LIMIT 1")).rows[0];
 const intent=async(user)=>(await service.query('SELECT pay_waffo_cancel_intent($1,$2) v',[user,sub.id])).rows[0].v;
 await assert.rejects(()=>intent(other),/CANCEL_DENIED/);
 const original=await intent(sub.user_id);assert.equal(original.dispatch,true);assert.equal((await intent(sub.user_id)).dispatch,false);
 const retry=async(db,expected,user=sub.user_id)=>(await db.query(
  'SELECT pay_waffo_retry_cancel($1,$2,$3,$4,$5) v',[user,sub.id,'fixture',original.providerId,expected])).rows[0].v;
 assert.equal(await retry(service,original.dispatchedAt),false,'in-flight first dispatch retains its lease');
 await admin.query("UPDATE user_subscriptions SET method_cancel_dispatched_at=now()-interval '2 minutes' WHERE id=$1",[sub.id]);
 const stale=await intent(sub.user_id);
 await assert.rejects(()=>retry(service,stale.dispatchedAt,other),/CANCEL_DENIED/);
 const parallel=await connect();await parallel.query('SET ROLE service_role');
 assert.equal((await Promise.all([retry(service,stale.dispatchedAt),retry(parallel,stale.dispatchedAt)])).filter(Boolean).length,1);
 assert.equal(await retry(service,stale.dispatchedAt),false,'stale recoveries cannot re-dispatch');
 await assert.rejects(()=>service.query('SELECT pay_waffo_cancel_result($1,$2,$3,$4)',[sub.id,'other',original.providerId,'canceling']),/CANCEL_CONFLICT/);
 await service.query('SELECT pay_waffo_cancel_result($1,$2,$3,$4)',[sub.id,'fixture',original.providerId,'canceling']);
 const result=(await admin.query('SELECT cancel_at_period_end,credit_release_terminated_at FROM user_subscriptions WHERE id=$1',[sub.id])).rows[0];
 assert.equal(result.cancel_at_period_end,'true');assert.equal(result.credit_release_terminated_at,null);
 return ['absence-grace-denied','verified-absence-releases-once','offsite-no-entitlement','offsite-dedup-counter','offsite-threshold-alert','admin-only-unpublish','unpublish-original-intent-recovery',
  'local-purchase-block','restore-outage-history','cancel-cross-user-denied','cancel-once-dispatch','cancel-retry-lease','cancel-retry-concurrent-cas','cancel-retry-cross-user','cancel-wrong-scope-denied','cancel-preserves-paid-grants'];
}
