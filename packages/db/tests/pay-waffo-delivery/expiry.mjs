/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const DAY=86400000;
const routesNow=async admin=>(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
const setRoutes=async(admin,patch)=>{
  const value=await routesNow(admin);
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[{...value,...patch,version:value.version+1}]);
  return value.version+1;
};
const purchase=(db,user,plan,method,offer,version)=>db.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,
  'monthly',$3,$4,'fixture','test',$5,'terms-v1',$6) o`,[user,plan,method,offer,version,
  JSON.stringify([{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}])]);
const level=async(admin,user)=>(await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[user])).rows[0].membership_level;
const orders=async(admin,user)=>(await admin.query(`SELECT count(*)::int n FROM payment_orders WHERE user_id=$1
  AND item_type='membership_plan'`,[user])).rows[0].n;

/** Pays one order for a term that may lie in the past; returns the subscription id. */
async function payTerm({admin,service},user,plan,method,offer,version,start,end) {
  const o=(await purchase(service,user,plan,method,offer,version)).rows[0];
  const request={orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}};
  const expiry=new Date(Date.now()+1800000),checkout=`checkout_${o.id}`;
  await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',request,expiry]);
  await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',checkout,expiry]);
  await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,new Date(start.getTime()-60000)]);
  const paid=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
    [o.id,'fixture',checkout,`payment_${o.id}`,o.amount_total,'usd',start,method==='card'?`sub_${o.id}`:null,start,end])).rows[0].v;
  assert.equal(paid.state,'fulfilled');
  return paid.subscriptionId;
}
const newUser=async admin=>{const id=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[id]);return id;};
const secondsAgo=ms=>new Date(Math.floor((Date.now()-ms)/1000)*1000);
const plusMonth=d=>{const e=new Date(d);e.setUTCMonth(e.getUTCMonth()+1);return e;};

/** Before 0221: ended wallet and Waffo card terms whose cached level was never lowered (staging state). */
export async function seedEndedMemberships({admin,service}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const version=await setRoutes(admin,{card:{enabled:true}});
  const seeded={plan};
  for(const name of ['wallet','walletRace','walletHeld','goldThenPro']) {
    const user=await newUser(admin),start=secondsAgo(40*DAY);
    await payTerm({admin,service},user,plan,'alipay','standard',version,start,plusMonth(start));
    seeded[name]={user};
  }
  // Waffo card terms: 30 days; ended 10 days ago (stopped / still renewing) or 2 hours ago (inside 0214 grace).
  for(const [name,ago] of [['cardStopped',40*DAY],['cardRenewing',40*DAY],['cardGrace',30*DAY+2*3600000]]) {
    const user=await newUser(admin),start=secondsAgo(ago);
    const subscription=await payTerm({admin,service},user,plan,'card','gold_first30',version,start,new Date(start.getTime()+30*DAY));
    seeded[name]={user,subscription};
  }
  const stop=(await service.query('SELECT pay_waffo_cancel_intent($1,$2) v',[seeded.cardStopped.user,seeded.cardStopped.subscription])).rows[0].v;
  await service.query("SELECT pay_waffo_cancel_result($1,'fixture',$2,'canceled')",[seeded.cardStopped.subscription,stop.providerId]);
  // The cache kept the level it had while the term was current.
  for(const name of ['wallet','walletRace','walletHeld','goldThenPro','cardStopped','cardRenewing','cardGrace'])
    await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[seeded[name].user]);
  return seeded;
}

/** After 0221..0243: ended terms settle to free and can buy again; renewal grace and renewing cards are kept. */
export async function verifyEndedMemberships({admin,service,connect},seeded) {
  const {plan}=seeded;
  const version=await setRoutes(admin,{wechat_pay:{enabled:true,annualVerified:true},alipay:{enabled:true,annualVerified:true}});
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture','test','price',
    'price_wallet_standard_monthly',$1,'monthly',true,'standard','one_time')`,[plan]);
  for(const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>service.query('SELECT pay_common_settle_membership_levels(100)'),/permission denied/);
    await assert.rejects(()=>service.query('SELECT pay_common_settle_membership_level($1)',[seeded.wallet.user]),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  // Admission settles under the account lock, so buying again does not wait for the daily cron.
  const again=(await purchase(service,seeded.wallet.user,plan,'alipay','standard',version)).rows[0];
  assert.equal(again.payment_channel,'stripe'); assert.equal(await level(admin,seeded.wallet.user),'free');
  // Two connections buying at once after expiry: one order, the second gets the same intent.
  const one=await connect(),two=await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  const race=await Promise.all([one,two].map(db=>purchase(db,seeded.walletRace.user,plan,'alipay','standard',version)));
  assert.equal(race[0].rows[0].id,race[1].rows[0].id);
  assert.equal(await orders(admin,seeded.walletRace.user),2,'one ended order plus one new intent');
  // A held monthly first-purchase refund owns the level change; settling skips it instead of failing.
  await admin.query(`UPDATE payment_orders SET refund_approval=jsonb_build_object('kind','monthly_first_purchase','hold','held',
    'id',gen_random_uuid()) WHERE user_id=$1`,[seeded.walletHeld.user]);
  assert.equal((await service.query('SELECT pay_common_settle_membership_level($1) v',[seeded.walletHeld.user])).rows[0].v,false);
  assert.equal(await level(admin,seeded.walletHeld.user),'gold');
  // Repeated small batches: a profile the setter would skip never takes a slot, so every run still settles one.
  for(let run=0;run<2;run++)
    assert.equal((await service.query('SELECT pay_common_settle_membership_levels(1) n')).rows[0].n,1,`run ${run}`);
  assert.equal(await level(admin,seeded.walletHeld.user),'gold');
  await admin.query("UPDATE payment_orders SET refund_approval=NULL WHERE user_id=$1",[seeded.walletHeld.user]);
  // Daily batch: ended terms settle, renewal grace keeps the level, and a second run changes nothing.
  assert.ok((await service.query('SELECT pay_common_settle_membership_levels(100) n')).rows[0].n>=2);
  for(const name of ['walletHeld','goldThenPro','cardStopped','cardRenewing'])
    assert.equal(await level(admin,seeded[name].user),'free',name);
  assert.equal(await level(admin,seeded.cardGrace.user),'gold','24-hour renewal grace keeps the level');
  assert.equal((await service.query('SELECT pay_common_settle_membership_levels(100) n')).rows[0].n,0);
  await assert.rejects(()=>service.query('SELECT pay_common_settle_membership_levels(0)'),/LIMIT_INVALID/);
  // A stopped card can buy again; a still-renewing card stays blocked (its provider may still charge).
  assert.ok((await purchase(service,seeded.cardStopped.user,plan,'alipay','standard',version)).rows[0].id);
  await assert.rejects(()=>purchase(service,seeded.cardRenewing.user,plan,'alipay','standard',version),/TRANSITION_REQUIRED/);
  await assert.rejects(()=>purchase(service,seeded.cardGrace.user,plan,'alipay','standard',version),/TRANSITION_REQUIRED/);
  // Gold ended while a Pro term is current: the cache drops to pro, never to free, never up.
  const pro=(await admin.query(`INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
    allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES('Pro','pro',2900,27900,3480,41760,false,false,0)
    ON CONFLICT(level) DO UPDATE SET monthly_price=2900,yearly_price=27900,monthly_credits=3480,yearly_credits=41760 RETURNING id`)).rows[0].id;
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture','test','price',
    'price_wallet_pro_monthly',$1,'monthly',true,'standard','one_time')`,[pro]);
  const start=secondsAgo(DAY);
  await payTerm({admin,service},seeded.goldThenPro.user,pro,'alipay','standard',version,start,plusMonth(start));
  assert.equal(await level(admin,seeded.goldThenPro.user),'pro');
  await admin.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[seeded.goldThenPro.user]);
  assert.equal((await service.query('SELECT pay_common_settle_membership_levels(100) n')).rows[0].n,1);
  assert.equal(await level(admin,seeded.goldThenPro.user),'pro');
  assert.equal((await service.query('SELECT pay_common_settle_membership_level($1) v',[seeded.goldThenPro.user])).rows[0].v,false);
  return ['0243-settle-service-only','0243-admission-settles-ended-wallet','0243-ended-wallet-buys-again',
    '0243-concurrent-rebuy-one-order','0243-held-monthly-refund-skipped','0243-skipped-profiles-do-not-starve-batch','0243-batch-settles-wallet-and-waffo-card',
    '0243-grace-keeps-level','0243-batch-idempotent','0243-stopped-card-buys-again','0243-renewing-card-still-blocked',
    '0243-gold-ended-pro-current-to-pro'];
}
