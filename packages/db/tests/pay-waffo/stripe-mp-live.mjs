/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** R7 PR-B1 (0296): Stripe card / wallet orders run in the Stripe account's mode (live in production); PAY-FAILOVER also permits one-time Waffo live orders in code.
 * Every step writes and reads in the order's own mode and never crosses into the other mode's references. */
export async function stripeMpLiveCases({admin,service}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const allowed=async(channel,mode)=>(await admin.query('SELECT pay_method_mode_allowed($1,$2) v',[channel,mode])).rows[0].v;
  assert.deepEqual([await allowed('stripe','test'),await allowed('stripe','live'),await allowed('waffo','test'),
    await allowed('waffo','live'),await allowed('stripe',null),await allowed(null,'live'),await allowed('stripe','LIVE')],
  [true,true,true,true,false,false,false]);
  const user=async()=>{const id=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[id]); return id;};
  const terms=digest=>JSON.stringify([{kind:'email',key_version:'test-v1',digest}]);
  const buy=(buyer,{item=plan,method='card',offer='standard',cycle='monthly',mode='live',digest}={})=>service.query(
    `SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,$3,$4,$5,'fixture',$6,$7,'terms-v1',$8) o`,
    [buyer,item,cycle,method,offer,mode,version,terms(digest)]);

  // No live catalog yet: a live order is refused for its missing price, nothing is reserved.
  const early=await user();
  await assert.rejects(()=>buy(early,{digest:'d1'.repeat(32)}),/PRICE_MAPPING_MISSING/);
  // The live catalog mirrors the test one with its own Stripe ids (the production account has different objects).
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
    membership_plan_id,credit_package_id,billing_cycle,is_current,offer_kind,price_usage,package_tier)
    SELECT channel,merchant_namespace,'live',object_type,external_id||'_live',membership_plan_id,credit_package_id,
      billing_cycle,is_current,offer_kind,price_usage,package_tier FROM payment_provider_refs
    WHERE merchant_namespace='fixture' AND mode='test' AND object_type IN ('price','coupon') AND is_current`);

  const order=async(opts,buyer)=>{
    buyer??=await user(); const o=(await buy(buyer,opts)).rows[0];
    const price=(await admin.query('SELECT mode FROM payment_provider_refs WHERE id=$1',[o.price_ref_id])).rows[0].mode;
    assert.deepEqual([o.payment_channel,o.payment_mode,price],['stripe','live','live']);
    // Paid times below lie before now; the order must already exist then (observe_qualification checks it).
    await admin.query("UPDATE payment_orders SET created_at=now()-interval '40 days' WHERE id=$1",[o.id]);
    const expiry=new Date(Date.now()+1800000),checkout=`cs_live_${o.id}`;
    const request=mode=>({orderId:o.id,userId:buyer,method:opts.method??'card',merchant:'fixture',mode,providerRequest:{fixture:true}});
    // The frozen request must name the order's own mode.
    await assert.rejects(()=>service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[buyer,o.id,'fixture',request('test'),expiry]),
      /CHECKOUT_INVALID/);
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[buyer,o.id,'fixture',request('live'),expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[buyer,o.id,'fixture',checkout,expiry]);
    const ref=(await admin.query("SELECT mode FROM payment_provider_refs WHERE order_id=$1 AND object_type='checkout'",[o.id])).rows;
    assert.deepEqual(ref,[{mode:'live'}]);
    return {o,user:buyer,checkout};
  };

  // Erasure keeps a live checkout envelope's financial identifiers (the shape buildStripeCheckoutRequest emits).
  const envelope=mode=>{
    const ids={orderId:randomUUID(),userId:randomUUID()};
    const metadata={...ids,itemId:plan,itemType:'membership_plan',billingCycle:'monthly',priceId:'price_live_x'};
    return admin.query(`SELECT erasure_payment_envelope($1,'checkout') v`,[{...ids,method:'card',merchant:'fixture',mode,
      providerRequest:{mode:'subscription',line_items:[{price:'price_live_x',quantity:1}],metadata,
        subscription_data:{metadata},expires_at:1900000000,client_reference_id:ids.userId,managed_payments:{enabled:true}}}]);
  };
  assert.equal((await envelope('live')).rows[0].v.mode,'live');
  assert.equal((await envelope('test')).rows[0].v.mode,'test');
  await assert.rejects(()=>envelope('sandbox'),/ERASURE_PAYMENT_REQUEST_REVIEW/);

  // Card monthly, live: first payment, tax, renewal, failure, stop, observation and entitlement.
  // The first month ended two hours ago, so its renewal is due now.
  const end=new Date(Math.floor(Date.now()/1000)*1000-2*3600000),start=new Date(end);start.setUTCMonth(start.getUTCMonth()-1);
  const card=await order({digest:'d2'.repeat(32)});
  const fulfilled=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[card.o.id,'fixture',
    card.checkout,`in_live_${card.o.id}`,card.o.amount_total,'usd',new Date(start.getTime()+6000),`sub_live_${card.o.id}`,start,end])).rows[0].v;
  assert.equal(fulfilled.state,'fulfilled',JSON.stringify(fulfilled));
  const sub=(await admin.query(`SELECT s.payment_mode,r.mode ref_mode FROM user_subscriptions s JOIN payment_provider_refs r
    ON r.subscription_id=s.id AND r.object_type='subscription' WHERE s.id=$1`,[fulfilled.subscriptionId])).rows[0];
  assert.deepEqual(sub,{payment_mode:'live',ref_mode:'live'});
  const payment=(await admin.query("SELECT mode FROM payment_provider_refs WHERE order_id=$1 AND object_type='payment'",[card.o.id])).rows;
  assert.deepEqual(payment,[{mode:'live'}]);
  assert.equal((await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,0) v`,[card.o.id,`in_live_${card.o.id}`]))
    .rows[0].v.duplicate,false);
  const facts=async buyer=>(await service.query('SELECT pay_common_membership_facts($1) v',[buyer])).rows[0].v.internal_membership;
  assert.equal((await facts(card.user)).mapping_state,'internal_paid','a paid live order entitles');
  assert.equal((await service.query(`SELECT pay_stripe_mp_observe_subscription($1,'fixture') v`,[fulfilled.subscriptionId])).rows.length,1);
  await service.query(`SELECT pay_stripe_mp_record_renewal_failure($1,'fixture','in_live_fail',$2)`,[fulfilled.subscriptionId,new Date()]);
  const next=new Date(end);next.setUTCMonth(next.getUTCMonth()+1);
  const renewed=(await service.query(`SELECT pay_stripe_mp_renew_subscription($1,'fixture','in_live_renew',$2,'usd',$3,$4,$5) v`,
    [fulfilled.subscriptionId,card.o.amount_total,new Date(end.getTime()+60000),end,next])).rows[0].v;
  assert.equal(renewed.duplicate,false,JSON.stringify(renewed));
  const renewal=(await admin.query(`SELECT o.payment_mode,r.mode FROM payment_orders o JOIN payment_provider_refs r ON r.order_id=o.id
    AND r.object_type='payment' WHERE o.subscription_id=$1 AND o.source_order_id IS NOT NULL`,[fulfilled.subscriptionId])).rows;
  assert.deepEqual(renewal,[{payment_mode:'live',mode:'live'}]);
  assert.equal((await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[card.user])).rows[0].membership_level,'gold');
  await service.query(`SELECT pay_stripe_mp_sync_subscription($1,'fixture',true,false,false)`,[fulfilled.subscriptionId]);
  assert.equal((await admin.query('SELECT cancel_at_period_end c FROM user_subscriptions WHERE id=$1',[fulfilled.subscriptionId]))
    .rows[0].c,'true');
  // Pro -> Gold upgrade of a live subscription is admitted in live mode only: the prior paid order must share the mode.
  const pro=(await admin.query("SELECT id FROM membership_plans WHERE level='pro'")).rows[0].id;
  const upgrader=await user(),proOrder=await order({item:pro,digest:'d6'.repeat(32)},upgrader);
  const proStart=new Date(Math.floor(Date.now()/1000)*1000-86400000),proEnd=new Date(proStart);proEnd.setUTCMonth(proEnd.getUTCMonth()+1);
  await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[proOrder.o.id,new Date(proStart.getTime()-60000)]);
  const proPaid=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[proOrder.o.id,'fixture',
    proOrder.checkout,`in_live_${proOrder.o.id}`,proOrder.o.amount_total,'usd',new Date(),`sub_live_${proOrder.o.id}`,proStart,proEnd]))
    .rows[0].v;
  assert.equal(proPaid.state,'fulfilled',JSON.stringify(proPaid));
  assert.ok((await service.query(`SELECT pay_stripe_mp_observe_subscription($1,'fixture') v`,[proPaid.subscriptionId])).rows[0].v);
  const upgrade=mode=>service.query(`SELECT o.* FROM pay_waffo_create_transition($1,$2,'monthly','card','standard','fixture',$3,
    'terms-v1',$4,'upgrade',$5,$6) o`,[upgrader,plan,version,terms('d6'.repeat(32)),proPaid.subscriptionId,mode]);
  await assert.rejects(()=>upgrade('test'),/TRANSITION_DENIED/);
  const goldOrder=(await upgrade('live')).rows[0];
  assert.deepEqual([goldOrder.payment_mode,goldOrder.method_transition,goldOrder.source_order_id],['live','upgrade',proOrder.o.id]);

  // card_cn yearly (founder, the live pool is separate from the test one), live: monthly credits are released too.
  const yearStart=new Date(Math.floor(Date.now()/1000)*1000-60000),yearEnd=new Date(yearStart);
  yearEnd.setUTCFullYear(yearEnd.getUTCFullYear()+1);
  const yearly=await order({method:'card_cn',offer:'founder',cycle:'yearly',digest:'d3'.repeat(32)});
  const y=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[yearly.o.id,'fixture',
    yearly.checkout,`in_live_${yearly.o.id}`,yearly.o.amount_total,'usd',new Date(yearStart.getTime()+6000),`sub_live_${yearly.o.id}`,
    yearStart,yearEnd])).rows[0].v;
  assert.equal(y.state,'fulfilled',JSON.stringify(y));
  const grants=async()=>(await admin.query('SELECT count(*)::int n FROM subscription_credit_grants WHERE source_order_id=$1',
    [yearly.o.id])).rows[0].n;
  assert.equal(await grants(),1);
  // Test-only time travel: the frozen-field guard is bypassed for this fixture so the second month falls due now.
  await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role=replica');
  await admin.query(`UPDATE payment_orders SET entitlement_start=entitlement_start-interval '1 month',
    entitlement_end=entitlement_end-interval '1 month' WHERE id=$1`,[yearly.o.id]);
  await admin.query('COMMIT');
  await service.query('SELECT pay_waffo_release_due(500)');
  assert.equal(await grants(),2,'the second live month is released');

  // Cross-mode: a live order never accepts a test request, a test order never a live one.
  const testBuyer=await user(),testOrder=(await buy(testBuyer,{mode:'test',digest:'d4'.repeat(32)})).rows[0];
  assert.equal(testOrder.payment_mode,'test');
  await assert.rejects(()=>service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[testBuyer,testOrder.id,'fixture',
    {orderId:testOrder.id,userId:testBuyer,method:'card',merchant:'fixture',mode:'live',providerRequest:{fixture:true}},
    new Date(Date.now()+1800000)]),/CHECKOUT_INVALID/);
  const other=await user();
  await assert.rejects(()=>buy(other,{mode:'other',digest:'d5'.repeat(32)}),/LIVE_DISABLED/);
  return ['live-mode-helper','live-requires-live-catalog','live-claim-bind-in-mode','live-erasure-envelope',
    'live-first-payment-and-tax','live-entitlement','live-renewal-failure-sync-observe','live-upgrade-mode-bound',
    'live-yearly-release','cross-mode-refused'];
}
