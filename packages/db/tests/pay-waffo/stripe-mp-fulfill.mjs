/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {addUtcMonths} from '../utc-months.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP 3a: first payment of card / card_cn subscriptions through pay_waffo_fulfill_payment. */
export async function stripeMpFulfillCases({admin,service,connect}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  await admin.query(`UPDATE payment_provider_refs SET is_current=true WHERE object_type='coupon' AND merchant_namespace='fixture'
    AND external_id='coupon_first_month_v2'`);
  const order=async(method,offer,cycle,digest)=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,$3,$4,$5,'fixture','test',$6,
      'terms-v1',$7) o`,[user,plan,cycle,method,offer,version,JSON.stringify([{kind:'email',key_version:'test-v1',digest}])])).rows[0];
    const expiry=new Date(Date.now()+1800000),checkout=`cs_${o.id}`;
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',checkout,expiry]);
    return {o,user,checkout};
  };
  // Stripe's subscription item period: anchor time-of-day kept, calendar month (Jan 31 -> Feb 28 handled by SQL).
  const start=new Date(Math.floor(Date.now()/1000)*1000-60000),end=addUtcMonths(start,1);
  const paid=new Date(start.getTime()+6000);
  const fulfill=(db,f,{amount=f.o.amount_total,subscription=`sub_${f.o.id}`,from=start,to=end,payment=`in_${f.o.id}`}={})=>db.query(
    'SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
    [f.o.id,'fixture',f.checkout,payment,amount,'usd',paid,subscription,from,to]);

  // Card (MP) first month: 49 pre-tax, Gold monthly credits, membership, subscription mapped to the Stripe id.
  const card=await order('card','gold_first30','monthly','6'.repeat(64));
  await assert.rejects(()=>fulfill(service,card,{amount:5880}),/PAYMENT_FACT_MISMATCH/,'tax-inclusive amount refused');
  await assert.rejects(()=>fulfill(service,card,{subscription:null}),/SUBSCRIPTION_CONFLICT/,'a card subscription needs its Stripe id');
  const late=new Date(end);late.setUTCDate(late.getUTCDate()+1);
  await assert.rejects(()=>fulfill(service,card,{to:late}),/TERM_INVALID/,'the period must be one calendar month');
  // Checkout completion, first invoice and browser return can arrive together: one grant.
  const one=await connect(),two=await connect(),three=await connect();
  for(const c of [one,two,three]) await c.query('SET ROLE service_role');
  const results=(await Promise.all([fulfill(one,card),fulfill(two,card),fulfill(three,card)])).map(r=>r.rows[0].v);
  assert.equal(results.filter(r=>r.duplicate===false).length,1,JSON.stringify(results));
  assert.equal((await fulfill(service,card)).rows[0].v.duplicate,true);
  const profile=(await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[card.user])).rows[0];
  assert.deepEqual([profile.credits,profile.membership_level],[8970,'gold']);
  const sub=(await admin.query(`SELECT s.payment_channel,s.stripe_subscription_id,s.cancel_at_period_end,r.external_id
    FROM user_subscriptions s JOIN payment_provider_refs r ON r.subscription_id=s.id AND r.object_type='subscription'
    WHERE s.user_id=$1`,[card.user])).rows;
  assert.deepEqual(sub,[{payment_channel:'stripe',stripe_subscription_id:null,cancel_at_period_end:'false',external_id:`sub_${card.o.id}`}]);
  assert.equal((await admin.query('SELECT count(*)::int n FROM subscription_credit_grants WHERE source_order_id=$1',[card.o.id])).rows[0].n,1);
  // Managed Payments tax: appended once to the order's payment facts; a different amount for the same payment conflicts.
  const tax=(f,payment,cents,db=service)=>db.query('SELECT pay_stripe_mp_record_tax($1,$2,$3,$4) v',[f.o.id,'fixture',payment,cents]);
  assert.equal((await tax(card,`in_${card.o.id}`,980)).rows[0].v.duplicate,false);
  assert.equal((await tax(card,`in_${card.o.id}`,980)).rows[0].v.duplicate,true);
  await assert.rejects(()=>tax(card,`in_${card.o.id}`,981),/PAYMENT_EVIDENCE_CONFLICT/);
  await assert.rejects(()=>tax(card,'in_not_this_order',980),/TAX_SCOPE/,'only a payment this order recorded');
  const facts=(await admin.query('SELECT payment_amount_facts f FROM payment_orders WHERE id=$1',[card.o.id])).rows[0].f;
  assert.deepEqual(facts.filter(x=>x.kind==='tax'),[{kind:'tax',amount:'9.80',currency:'usd',unit:'major',evidence_ref:`in_${card.o.id}`}]);
  assert.equal(facts.filter(x=>x.kind==='paid').length,1,'the pre-tax paid fact is unchanged');
  for(const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>tax(card,`in_${card.o.id}`,980),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  // The same Stripe payment cannot be claimed by another order.
  const other=await order('card_cn','standard','monthly','7'.repeat(64));
  await assert.rejects(()=>fulfill(service,other,{payment:`in_${card.o.id}`,amount:other.o.amount_total}),/PAYMENT_REBOUND|EXTRA_PAYMENT/);
  // Mainland card subscription: standard 69, no Managed Payments.
  assert.equal((await fulfill(service,other)).rows[0].v.state,'fulfilled');
  await assert.rejects(()=>tax(other,`in_${other.o.id}`,100),/TAX_SCOPE/,'no Managed Payments, no tax');
  assert.equal((await tax(other,`in_${other.o.id}`,0)).rows[0].v.duplicate,false);
  assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[other.user])).rows[0].credits,8970);

  // Expired or failed unpaid card checkout: closed, founder slot released, the buyer can try again.
  // The admission cases fill all 50 founder slots; free one earlier test reservation (disposable fixture only).
  await admin.query(`UPDATE payment_orders SET qualification_state='released' WHERE id=(SELECT id FROM payment_orders
    WHERE offer_kind='founder' AND qualification_state='reserved' AND payment_mode='test' ORDER BY created_at LIMIT 1)`);
  const founder=await order('card','founder','yearly','8'.repeat(64));
  const slots=async()=>(await admin.query(`SELECT count(*)::int n FROM payment_orders WHERE payment_mode='test' AND offer_kind='founder'
    AND qualification_state IN ('reserved','sold')`)).rows[0].n;
  const before=await slots();
  const close=()=>service.query(`SELECT pay_waffo_observe_qualification($1,'fixture','test',$2,'closed_unpaid',NULL,0,'usd',NULL) v`,
    [founder.o.id,founder.checkout]);
  assert.equal((await close()).rows[0].v,'released');
  assert.equal((await close()).rows[0].v,'released');
  assert.equal(await slots(),before-1);
  // A payment that arrives after the close is kept for review, never re-taking the released slot.
  const yearEnd=new Date(start);yearEnd.setUTCFullYear(yearEnd.getUTCFullYear()+1);
  assert.equal((await fulfill(service,founder,{to:yearEnd})).rows[0].v.state,'review');
  assert.equal((await tax(founder,`in_${founder.o.id}`,500)).rows[0].v.duplicate,false,'a payment kept for review keeps its tax');
  assert.equal(await slots(),before-1);
  assert.equal((await admin.query('SELECT membership_level FROM profiles WHERE id=$1',[founder.user])).rows[0].membership_level,'free');

  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['stripe-mp-card-first-month-granted-once-concurrently','stripe-mp-card-pre-tax-only','stripe-mp-card-period-calendar-month',
    'stripe-mp-card-subscription-mapped','stripe-mp-card-tax-recorded-once','stripe-mp-card-cn-no-tax','stripe-mp-card-payment-not-rebound','stripe-mp-card-cn-first-payment',
    'stripe-mp-card-expired-releases-founder-slot','stripe-mp-card-late-payment-review'];
}
