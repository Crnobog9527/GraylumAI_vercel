/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const routesNow=async admin=>(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
const setRoutes=async(admin,patch)=>{
  const value=await routesNow(admin);
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[{...value,...patch,version:value.version+1}]);
  return value.version+1;
};
const buy=(service,user,plan,method,offer,version)=>service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,
  'monthly',$3,$4,'fixture','test',$5,'terms-v1',$6) o`,[user,plan,method,offer,version,
  JSON.stringify([{kind:'email',key_version:'test-v1',digest:user.replaceAll('-','').repeat(2)}])]);

/** Before 0221: one paid Waffo card subscription, as staging already holds. */
export async function seedLegacyWaffo({admin,service}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const version=await setRoutes(admin,{card:{enabled:true}});
  const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
  const o=(await buy(service,user,plan,'card','gold_first30',version)).rows[0];
  assert.equal(o.payment_channel,'waffo');
  const request={orderId:o.id,userId:user,method:'card',merchant:'fixture',mode:'test',providerRequest:{fixture:true}};
  const expiry=new Date(Date.now()+1800000),checkout=`checkout_${o.id}`;
  await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',request,expiry]);
  await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',checkout,expiry]);
  const start=new Date(Math.floor(Date.now()/1000)*1000);start.setUTCDate(start.getUTCDate()-32);
  await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,start]);
  const end=new Date(start);end.setUTCDate(end.getUTCDate()+30);
  const paid=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
    [o.id,'fixture',checkout,`payment_${o.id}`,o.amount_total,'usd',start,`sub_${o.id}`,start,end])).rows[0].v;
  return {plan,user,order:o.id,subscription:paid.subscriptionId,end,cardVersion:version};
}

/** After 0221: the old Waffo subscription keeps its channel and flows; new card sales are Stripe. */
export async function verifyAfterStripeRouting({admin,service},legacy) {
  const routes=await routesNow(admin);
  assert.equal(routes.card.enabled,false,'0221 closes a card switch that was opened for Waffo');
  assert.equal(routes.version,legacy.cardVersion+1);
  const order=(await admin.query('SELECT * FROM payment_orders WHERE id=$1',[legacy.order])).rows[0];
  assert.equal(order.payment_channel,'waffo'); assert.equal(order.stripe_managed_payments,null);
  assert.equal(order.entitlement_term,'days30');
  const usage=(await admin.query(`SELECT DISTINCT price_usage FROM payment_provider_refs WHERE object_type='price'
    AND channel='stripe' AND membership_plan_id IS NOT NULL`)).rows.map(r=>r.price_usage);
  assert.deepEqual(usage,['subscription'],'existing Stripe membership prices are recurring');
  // Renewal and stop of the existing Waffo subscription still work.
  const renewalEnd=new Date(legacy.end);renewalEnd.setUTCMonth(renewalEnd.getUTCMonth()+1);
  const renewed=(await service.query(`SELECT pay_waffo_renew_subscription($1,'fixture',$2,6900,'usd',$3,$4,$5) v`,
    [legacy.subscription,`renew_${legacy.order}`,new Date(Math.floor(Date.now()/1000)*1000),legacy.end,renewalEnd])).rows[0].v;
  assert.equal(renewed.duplicate,false);
  assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[legacy.user])).rows[0].credits,17940);
  const renewal=(await admin.query(`SELECT payment_channel,payment_method FROM payment_orders WHERE subscription_id=$1
    ORDER BY created_at DESC LIMIT 1`,[legacy.subscription])).rows[0];
  assert.deepEqual(renewal,{payment_channel:'waffo',payment_method:'card'});
  const stop=(await service.query('SELECT pay_waffo_cancel_intent($1,$2) v',[legacy.user,legacy.subscription])).rows[0].v;
  assert.ok(stop,'stop renewal of the old Waffo subscription is still accepted');
  // New sales: international card -> Stripe Managed Payments subscription; card_cn absent -> closed.
  const version=await setRoutes(admin,{card:{enabled:true}});
  const fresh=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[fresh]);
  await assert.rejects(()=>buy(service,fresh,legacy.plan,'card_cn','standard',version),/SALES_DISABLED/);
  const card=(await buy(service,fresh,legacy.plan,'card','standard',version)).rows[0];
  assert.deepEqual([card.payment_channel,card.mode,card.auto_renew,card.stripe_managed_payments,card.entitlement_term],
    ['stripe','subscription',true,true,'month']);
  assert.equal(card.purchase_snapshot.tax_behavior,'exclusive');
  return ['0221-closes-waffo-card-switch','0221-keeps-waffo-order-channel','0221-backfills-recurring-price-usage',
    '0221-waffo-renewal-still-works','0221-waffo-stop-still-works','0221-card-cn-absent-closed','0221-new-card-is-stripe-mp'];
}
