/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function transitionCases({admin,service}) {
 const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
 await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
  membership_plan_id,billing_cycle,is_current,offer_kind) VALUES('stripe','fixture','test','price','price_founder',$1,'yearly',true,'founder')`,[plan]);
 const seed=async(daysAfterEnd)=>{
  const user=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
  const digests=[{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}];
  const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'yearly','alipay','founder',
   'fixture','test',1,'terms-v1',$3) o`,[user,plan,JSON.stringify(digests)])).rows[0];
  const start=new Date(Math.floor(Date.now()/1000)*1000),end=new Date(start);
  if(daysAfterEnd!==null) {start.setUTCFullYear(start.getUTCFullYear()-1);start.setUTCDate(start.getUTCDate()-daysAfterEnd);}
  end.setTime(start.getTime());end.setUTCFullYear(end.getUTCFullYear()+1);
  await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,start]);
  const checkout=`checkout_${o.id}`;
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('stripe','fixture','test','checkout',$1,$2)`,[checkout,o.id]);
  const delivered=(await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,49600,'usd',$4,NULL,$4,$5) v`,
   [o.id,checkout,`payment_${o.id}`,start,end])).rows[0].v;
  return {user,o,sub:delivered.subscriptionId,digests,end};
 };
 const renew=async(f)=>(await service.query(`SELECT o.* FROM pay_waffo_create_transition($1,$2,'yearly','alipay',
  'founder_renewal','fixture',1,'terms-v1',$3,'founder_renewal',$4) o`,[f.user,plan,JSON.stringify(f.digests),f.sub])).rows[0];
 for(const days of [null,3]) {
  const f=await seed(days),o=await renew(f);assert.equal(o.amount_total,49600);assert.equal(o.offer_kind,'founder_renewal');
  const checkout=`checkout_${o.id}`,paid=new Date(Math.floor(Date.now()/1000)*1000),end=new Date(f.end);
  end.setUTCFullYear(end.getUTCFullYear()+1);
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('stripe','fixture','test','checkout',$1,$2)`,[checkout,o.id]);
  const args=[o.id,checkout,`payment_${o.id}`,paid,f.end,end];
  const result=(await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,49600,'usd',$4,NULL,$5,$6) v`,args)).rows[0].v;
  assert.equal(result.state,'fulfilled');assert.equal(result.credits,days===null?0:8970);
  const stored=(await admin.query('SELECT entitlement_start FROM payment_orders WHERE id=$1',[o.id])).rows[0];
  assert.equal(stored.entitlement_start.toISOString(),f.end.toISOString(),'early/grace renewal always joins original end');
  const slots=(await admin.query("SELECT count(*)::int n FROM payment_orders WHERE user_id=$1 AND offer_kind='founder'",[f.user])).rows[0].n;
  assert.equal(slots,1,'renewal never consumes another founder slot');
 }
 const late=await seed(8);await assert.rejects(()=>renew(late),/FOUNDER_EXPIRED/);
 return ['founder-early-renewal-original-end','founder-grace-renewal-original-end','founder-no-free-gap','founder-fixed-496',
  'founder-renewal-no-extra-slot','founder-expired-denied'];
}
