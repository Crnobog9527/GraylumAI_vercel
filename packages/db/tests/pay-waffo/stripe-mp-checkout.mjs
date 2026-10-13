/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP PR-2 (0222): card first month on the standard price + coupon; card checkout closing. */
export async function stripeMpCheckoutCases({admin,service,connect}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const user=async()=>{const id=randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)',[id]); return id;};
  const buy=(db,buyer,method,digest)=>db.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',
    $3,'gold_first30','fixture','test',$4,'terms-v1',$5) o`,[buyer,plan,method,version,
    JSON.stringify([{kind:'email',key_version:'test-v1',digest}])]);
  const standard=(await admin.query(`SELECT id FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace='fixture'
    AND object_type='price' AND membership_plan_id=$1 AND billing_cycle='monthly' AND offer_kind='standard'
    AND price_usage='subscription' AND is_current`,[plan])).rows[0].id;
  // First month 49 = standard 69 subscription price - 20 coupon; renewals stay on the standard price.
  for(const [method,digest] of [['card','1'.repeat(64)],['card_cn','2'.repeat(64)]]) {
    const o=(await buy(service,await user(),method,digest)).rows[0];
    assert.deepEqual([o.amount_total,o.price_ref_id,o.mode,o.auto_renew,o.entitlement_term],[4900,standard,'subscription',true,'month']);
    assert.deepEqual([o.purchase_snapshot.price,o.purchase_snapshot.discount],['69.00','20.00']);
  }
  // Missing or non-current coupon mapping: the order is refused, nothing is reserved.
  await admin.query("UPDATE payment_provider_refs SET is_current=false WHERE object_type='coupon' AND merchant_namespace='fixture'");
  const refused=await user();
  await assert.rejects(()=>buy(service,refused,'card','3'.repeat(64)),/PRICE_MAPPING_MISSING/);
  assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[refused])).rows[0].n,0);
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,membership_plan_id,
    billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture','test','coupon','coupon_first_month_v2',$1,
    'monthly',true,'gold_first30','subscription')`,[plan]);
  // Repeat and parallel submit: one order.
  const twice=await user(),one=await connect(),two=await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  const both=await Promise.all([buy(one,twice,'card','4'.repeat(64)),buy(two,twice,'card','4'.repeat(64))]);
  assert.equal(both[0].rows[0].id,both[1].rows[0].id);
  assert.equal((await buy(service,twice,'card','4'.repeat(64))).rows[0].id,both[0].rows[0].id);
  assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[twice])).rows[0].n,1);
  // A card checkout that never reached Stripe releases the reservation; the account can buy again.
  const order=both[0].rows[0],expiry=new Date(Date.now()+1800000);
  await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[twice,order.id,'fixture',
    {orderId:order.id,userId:twice,method:'card',merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
  await service.query('SELECT pay_waffo_abort_before_dispatch($1,$2,$3,$4)',[twice,order.id,'fixture',expiry]);
  await service.query('SELECT pay_waffo_abort_before_dispatch($1,$2,$3,$4)',[twice,order.id,'fixture',expiry]);
  assert.equal((await admin.query('SELECT qualification_state s FROM payment_orders WHERE id=$1',[order.id])).rows[0].s,'released');
  const again=(await buy(service,twice,'card','4'.repeat(64))).rows[0];
  assert.notEqual(again.id,order.id);
  // Verified-absent close only after the checkout window plus an hour, and never once a session is bound.
  await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[twice,again.id,'fixture',
    {orderId:again.id,userId:twice,method:'card',merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
  const closeAbsent=()=>service.query('SELECT pay_waffo_close_uncreated($1,$2,$3)',[twice,again.id,'fixture']);
  await assert.rejects(closeAbsent,/CLOSE_DENIED/);
  await admin.query("UPDATE payment_orders SET method_checkout_expires_at=now()-interval '61 minutes' WHERE id=$1",[again.id]);
  await closeAbsent();
  assert.equal((await admin.query('SELECT qualification_state s FROM payment_orders WHERE id=$1',[again.id])).rows[0].s,'released');
  const bound=(await buy(service,twice,'card_cn','4'.repeat(64))).rows[0];
  await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[twice,bound.id,'fixture',
    {orderId:bound.id,userId:twice,method:'card_cn',merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
  await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[twice,bound.id,'fixture',`cs_${bound.id}`,expiry]);
  await assert.rejects(()=>service.query('SELECT pay_waffo_abort_before_dispatch($1,$2,$3,$4)',[twice,bound.id,'fixture',expiry]),
    /CLOSE_DENIED/);
  // Admitted but never claimed, then the coupon mapping disappears: release with no expiry, nothing reached Stripe.
  const stranded=await user();
  const unclaimed=(await buy(service,stranded,'card','5'.repeat(64))).rows[0];
  const release=(expected)=>service.query('SELECT pay_waffo_abort_before_dispatch($1,$2,$3,$4)',
    [stranded,unclaimed.id,'fixture',expected]);
  await assert.rejects(()=>release(expiry),/CLOSE_DENIED/,'an unclaimed order has no frozen expiry to match');
  await admin.query("UPDATE payment_provider_refs SET is_current=false WHERE object_type='coupon' AND merchant_namespace='fixture'");
  await release(null); await release(null);
  assert.equal((await admin.query('SELECT qualification_state s FROM payment_orders WHERE id=$1',[unclaimed.id])).rows[0].s,'released');
  await assert.rejects(()=>service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[stranded,unclaimed.id,'fixture',
    {orderId:unclaimed.id,userId:stranded,method:'card',merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]),
  /CHECKOUT_DENIED/,'a released order can never be claimed afterwards');
  await admin.query("UPDATE payment_provider_refs SET is_current=true WHERE external_id='coupon_first_month_v2'");
  assert.notEqual((await buy(service,stranded,'card','5'.repeat(64))).rows[0].id,unclaimed.id,'the account can buy again');
  await assert.rejects(()=>service.query('SELECT pay_waffo_abort_before_dispatch($1,$2,$3,$4)',[twice,bound.id,'fixture',null]),
    /CLOSE_DENIED/,'a claimed order needs its exact expiry');
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['stripe-mp-card-first-month-69-minus-20','stripe-mp-card-cn-first-month-69-minus-20',
    'stripe-mp-first-month-coupon-required','stripe-mp-card-first-month-concurrent-one-order',
    'stripe-mp-card-never-dispatched-released','stripe-mp-card-verified-absent-released','stripe-mp-card-bound-checkout-not-closed',
    'stripe-mp-card-unclaimed-released-without-coupon'];
}
