/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function packageCases({admin,service}) {
 const pack=(await admin.query(`INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,active)
  VALUES('Pack fixture',990,990,0,true) RETURNING id`)).rows[0].id;
 const refs={};
 for(const tier of ['legacy','pro','gold']) refs[tier]=(await admin.query(`INSERT INTO payment_provider_refs(channel,
  merchant_namespace,mode,object_type,external_id,credit_package_id,billing_cycle,is_current,package_tier)
  VALUES('stripe','fixture','test','price',$1,$2,'one_time',true,$3) RETURNING id`,
 [`price_pack_${tier}`,pack,tier])).rows[0].id;
 await assert.rejects(()=>admin.query("UPDATE payment_provider_refs SET package_tier='gold' WHERE id=$1",[refs.pro]),/FROZEN_FIELD/);
 for(const tier of ['pro','gold']) {
  const user=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
  const plan=(await admin.query('SELECT id FROM membership_plans WHERE level=$1',[tier])).rows[0].id;
  if(tier==='pro') await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,
   external_id,membership_plan_id,billing_cycle,is_current) VALUES('stripe','fixture','test','price','price_pro_month',$1,'monthly',true)`,[plan]);
  const membership=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',
   'alipay','standard','fixture','test',1,'terms-v1',$3) o`,[user,plan,
   JSON.stringify([{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}])])).rows[0];
  const checkout=`checkout_${membership.id}`;
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('stripe','fixture','test','checkout',$1,$2)`,[checkout,membership.id]);
  const start=new Date(Math.floor(Date.now()/1000)*1000),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,$4,'usd',$5,NULL,$5,$6)`,
   [membership.id,checkout,`payment_${membership.id}`,membership.amount_total,start,end]);
  const buy=async()=>(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'credit_package',$2,'one_time',
   'alipay','standard','fixture','test',1,'terms-v1','[]') o`,[user,pack])).rows[0];
  await admin.query('UPDATE payment_provider_refs SET is_current=false WHERE id=$1',[refs[tier]]);
  await assert.rejects(buy,/PRICE_MAPPING_MISSING/);
  await admin.query('UPDATE payment_provider_refs SET is_current=true WHERE id=$1',[refs[tier]]);
  const order=await buy();assert.equal(order.price_ref_id,refs[tier]);assert.equal(order.amount_total,tier==='pro'?940:890);
 }
 const save=(values,external,amount=990)=>service.query(
  "SELECT pay_common_save_catalog('credit_package',$1,$2,$3,'fixture','test',NULL)",
  [pack,values,{one_time:{external_id:external,unit_amount:amount,currency:'usd',mode:'test',billing_cycle:'one_time'}}]);
 const tiers=async()=>(await admin.query("SELECT id FROM payment_provider_refs WHERE credit_package_id=$1 AND is_current AND package_tier<>'legacy' ORDER BY id",
  [pack])).rows.map(r=>r.id);
 const original=await tiers();
 await assert.rejects(()=>save({price:1990},'price_changed',1990),/TIER_PRICE_UPDATE_REQUIRED/);
 assert.deepEqual(await tiers(),original);
 assert.equal((await admin.query('SELECT price FROM credit_packages WHERE id=$1',[pack])).rows[0].price,990);
 await assert.rejects(()=>save({},'price_pack_pro'),/PRICE_MAPPING_CONFLICT/);
 await save({price:990},'price_pack_legacy_replaced');assert.deepEqual(await tiers(),original);
 refs.legacy=(await admin.query("SELECT id FROM payment_provider_refs WHERE external_id='price_pack_legacy_replaced'")).rows[0].id;
 // Legacy protocol before method activation must still see exactly its original price.
 await admin.query('BEGIN');
 try {
// Disposable fixture only: restore pre-activation settings; never relax the trigger during the RPC.
  await admin.query("ALTER TABLE system_settings DISABLE TRIGGER pay_waffo_routes_guard");
  await admin.query("DELETE FROM system_settings WHERE key='payment_method_routes'");
  await admin.query("ALTER TABLE system_settings ENABLE TRIGGER pay_waffo_routes_guard");
  await admin.query(`INSERT INTO system_settings(key,value) VALUES('payment_new_purchase_channel',
   '{"channel":"stripe","version":1}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  const user=randomUUID();await admin.query('INSERT INTO profiles(id) VALUES($1)',[user]);
  await admin.query('SET LOCAL ROLE service_role');
  const legacy=(await admin.query("SELECT o.* FROM pay_common_create_purchase($1,'credit_package',$2,'one_time','fixture','test','free') o",
   [user,pack])).rows[0];
  assert.equal(legacy.price_ref_id,refs.legacy);assert.equal(legacy.amount_total,990);
 } finally {await admin.query('ROLLBACK');}
 return ['package-pro-price-95','package-gold-price-90','package-no-other-tier-fallback','package-tier-immutable','legacy-package-three-mappings','catalog-preserves-tier-prices','catalog-denies-unvalidated-tier-amount-change','catalog-denies-tier-adoption'];
}
