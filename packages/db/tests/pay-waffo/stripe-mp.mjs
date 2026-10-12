/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP PR-1 (0221): method contract, route shape, price usage and card admission races. */
export async function stripeMpCases({admin,service,connect}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const routes=async()=>(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const save=async value=>admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[value]);
  const current=await routes();
  for(const bad of [{card_cn:{enabled:'yes'}},{card_cn:{enabled:true,annualVerified:true}},{card_cn:true}]) {
    await assert.rejects(()=>save({...current,...bad,version:current.version+1}),/ROUTES_INVALID/);
  }
  // Price usage is set on insert, frozen afterwards; coupons only as the Stripe first-month Gold offer.
  const ref=(await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind) VALUES('stripe','mp_fixture','test','price','price_mp_default',$1,
    'monthly',true,'standard') RETURNING id,price_usage`,[plan])).rows[0];
  assert.equal(ref.price_usage,'subscription');
  await assert.rejects(()=>admin.query("UPDATE payment_provider_refs SET price_usage='one_time' WHERE id=$1",[ref.id]),/FROZEN/);
  const coupon=(external,offer,channel='stripe')=>admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,
    object_type,external_id,membership_plan_id,billing_cycle,is_current,offer_kind,price_usage)
    VALUES($1,'mp_fixture','test','coupon',$2,$3,'monthly',true,$4,'subscription')`,[channel,external,plan,offer]);
  await assert.rejects(()=>coupon('coupon_std','standard'),/pay_stripe_mp_price_usage/);
  await assert.rejects(()=>coupon('coupon_waffo','gold_first30','waffo'),/pay_stripe_mp_price_usage/);
  // Omitted fields are unknown (NULL) and must fail the contract, not pass it.
  await assert.rejects(()=>admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,billing_cycle,is_current,offer_kind) VALUES('stripe','mp_fixture','test','coupon','coupon_no_usage',$1,
    'monthly',true,'gold_first30')`,[plan]),/pay_stripe_mp_price_usage/);
  await assert.rejects(()=>admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,is_current,offer_kind,price_usage) VALUES('stripe','mp_fixture','test','coupon','coupon_no_cycle',$1,
    true,'gold_first30','subscription')`,[plan]),/pay_common_ref_target/);
  await coupon('coupon_first','gold_first30');
  await assert.rejects(()=>coupon('coupon_first_2','gold_first30'),/pay_stripe_mp_current_coupon/);
  // Double submit and parallel submit of the same card purchase reserve one order; switching method waits.
  await save({...current,card:{enabled:true},card_cn:{enabled:true},version:current.version+1});
  const buyer=randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)',[buyer]);
  const one=await connect(),two=await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  const buy=(db,method)=>db.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',$3,'standard',
    'fixture','test',$4,'terms-v1',$5) o`,[buyer,plan,method,current.version+1,
    JSON.stringify([{kind:'email',key_version:'test-v1',digest:'9'.repeat(64)}])]);
  const both=await Promise.all([buy(one,'card_cn'),buy(two,'card_cn')]);
  assert.equal(both[0].rows[0].id,both[1].rows[0].id);
  const order=both[0].rows[0];
  assert.deepEqual([order.payment_channel,order.mode,order.auto_renew,order.stripe_managed_payments,order.amount_total],
    ['stripe','subscription',true,false,6900]);
  await assert.rejects(()=>buy(service,'card'),/PURCHASE_PENDING/);
  assert.equal((await admin.query('SELECT count(*)::int n FROM payment_orders WHERE user_id=$1',[buyer])).rows[0].n,1);
  // Contract: clone the real order changing only method fields. No Waffo for card_cn, Managed Payments only for
  // card, no mainland card packs, no recurring wallets.
  const clone=async patch=>{
    const owner=randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)',[owner]);
    return admin.query(`INSERT INTO payment_orders SELECT * FROM jsonb_populate_record(NULL::payment_orders,
      (SELECT to_jsonb(o) FROM payment_orders o WHERE id=$1)||$2::jsonb)`,
    [order.id,{id:randomUUID(),user_id:owner,purchase_request_id:randomUUID(),...patch}]);
  };
  await clone({});
  await clone({payment_method:'card',stripe_managed_payments:true});
  for(const patch of [{payment_channel:'waffo',stripe_managed_payments:null},{stripe_managed_payments:true},
    {stripe_managed_payments:null},{payment_method:'card'},{payment_method:'card',stripe_managed_payments:null},
    {mode:'payment',auto_renew:false},{payment_method:'wechat_pay',stripe_managed_payments:null},
    {payment_method:'alipay',mode:'payment',auto_renew:false,stripe_managed_payments:true},
    {payment_method:'card',payment_channel:'waffo',stripe_managed_payments:true},{payment_method:'paypal'}]) {
    await assert.rejects(()=>clone(patch),/pay_waffo_method_contract|payment_method_check/,JSON.stringify(patch));
  }
  // Turning the switch off stops new sales (failure path), whatever the client still holds.
  await save({...current,card:{enabled:false},card_cn:{enabled:false},version:current.version+2});
  const late=randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)',[late]);
  await assert.rejects(()=>service.query(`SELECT pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card','standard',
    'fixture','test',$3,'terms-v1',NULL)`,[late,plan,current.version+2]),/SALES_DISABLED/);
  return ['stripe-mp-route-shape','stripe-mp-method-contract','stripe-mp-price-usage-frozen','stripe-mp-coupon-first-month-only','stripe-mp-coupon-omitted-field-denied',
    'stripe-mp-concurrent-card-one-order','stripe-mp-method-switch-waits','stripe-mp-switch-off-denies'];
}
