/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function advancedCases({admin,service,connect,actor,create,bind,pay,current,switchTo,plan,gold,first}) {
 const cases=[];
 const expired=await create();await bind(expired);
 await admin.query("UPDATE payment_orders SET method_dispatched_at=now()-interval '41 minutes' WHERE id=$1",[expired.id]);
 await assert.rejects(()=>service.query("SELECT pay_waffo_close_card_checkout($1,$2,'fixture',false)",[expired.user_id,expired.id]),/CLOSE_DENIED/);
 assert.equal((await admin.query('SELECT qualification_state FROM payment_orders WHERE id=$1',[expired.id])).rows[0].qualification_state,'reserved');
 await assert.rejects(()=>service.query("SELECT pay_waffo_close_uncreated($1,$2,'fixture')",[expired.user_id,expired.id]),/CLOSE_DENIED/);
 const frozenExpiry=(await admin.query('SELECT method_checkout_expires_at FROM payment_orders WHERE id=$1',[expired.id])).rows[0].method_checkout_expires_at;
 await assert.rejects(()=>service.query("SELECT pay_waffo_abort_before_dispatch($1,$2,'fixture',$3)",[expired.user_id,expired.id,frozenExpiry]),/CLOSE_DENIED/);
 assert.equal((await pay(expired)).state,'fulfilled','a missing callback is recovered from checked cash instead of releasing its order');
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[expired.user_id])).rows[0].credits,3480);
 const terminal=await create();await bind(terminal);
 await service.query("SELECT pay_waffo_observe_qualification($1,'fixture','test',$2,'closed_unpaid',NULL,0,'usd',NULL)",
  [terminal.id,`checkout_${terminal.id}`]);
 assert.equal((await pay(terminal)).state,'review','late cash after a confirmed terminal unpaid checkout cannot issue a second term');
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[terminal.user_id])).rows[0].credits,0);
 const rejected=await create({method:'alipay'});
 const expiry=new Date(Date.now()+1800000);
 await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[rejected.user_id,rejected.id,'fixture',
  {orderId:rejected.id,userId:rejected.user_id,method:'alipay',merchant:'fixture',mode:'test',purchaseMode:'payment',providerRequest:{}},expiry]);
 await service.query("SELECT pay_waffo_close_card_checkout($1,$2,'fixture',true)",[rejected.user_id,rejected.id]);
 assert.equal((await admin.query('SELECT qualification_state FROM payment_orders WHERE id=$1',[rejected.id])).rows[0].qualification_state,'released');
 cases.push('expired-local-timer-keeps-pending-and-checked-cash-fulfills','definitive-provider-rejection-releases','provider-confirmed-terminal-unpaid-late-cash-review');
 const members=[];
 for(const method of ['card','alipay','failed_refund']){
  const actual=method==='failed_refund'?'card':method;
  const o=await create({method:actual});await bind(o);assert.equal((await pay(o,{method:actual})).state,'fulfilled');
  members.push({...o,refundFailure:method==='failed_refund'});
 }
 const pack=(await admin.query(`INSERT INTO credit_packages(name,price,credits_amount,bonus_credits)
  VALUES('PAY-FAILOVER pack',990,990,0) RETURNING id`)).rows[0].id;
 for(const tier of ['pro','gold'])await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,
  external_id,credit_package_id,billing_cycle,is_current,offer_kind,price_usage,package_tier)
  VALUES('waffo','fixture','test','price',$1,$2,'one_time',true,'standard','package',$3)`,
  [`PROD_${randomUUID().replaceAll('-','')}`,pack,tier]);
 const packOrder=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'credit_package',$2,'one_time','card_cn',
  'standard','fixture','test',$3,'terms-v1','[]') o`,[first.user_id,pack,(await current()).version])).rows[0];
 assert.equal(packOrder.amount_total,940);assert.equal(packOrder.mode,'payment');assert.equal(packOrder.auto_renew,false);
 await bind(packOrder);assert.equal((await pay(packOrder)).state,'fulfilled');
 for(const o of [...members,packOrder]){
  const ticket=randomUUID();await admin.query("INSERT INTO tickets(id,user_id,title,description,category) VALUES($1,$2,'Test','Synthetic','billing')",[ticket,o.user_id]);
  const row=(await admin.query('SELECT qualified_paid_at FROM payment_orders WHERE id=$1',[o.id])).rows[0];
  const cash={orderId:o.id,merchant:'fixture',mode:'test',currency:'usd',paidMinor:o.amount_total,
   taxMinor:0,refundedMinor:0,refundCount:0,disputed:false,chargeId:`PAY_${o.id}`,paymentIntentId:`PAY_${o.id}`,paidAt:row.qualified_paid_at};
  const quote=(await service.query('SELECT pay_common_package_refund_quote($1,$2,$3,$4,$5,$6) v',
   [actor,o.id,ticket,cash,'not_permitted','test-case'])).rows[0].v;
  const approval=(await service.query('SELECT pay_common_package_refund_decide($1,$2,$3,$4,$5,$6,$7,$8) v',
   [actor,o.id,ticket,cash,'not_permitted','test-case',quote.versionHash,'approve'])).rows[0].v;
  await service.query('SELECT pay_common_package_refund_claim($1,$2,$3,$4)',[actor,o.id,approval.id,cash]);
  const refund={id:`REF_${approval.id}`,intentId:approval.id,orderId:o.id,paymentIntentId:cash.paymentIntentId,
   chargeId:cash.chargeId,currency:'usd',amount:approval.netMinor,mode:'test',merchant:'fixture',status:o.refundFailure?'failed':'succeeded'};
  await service.query('SELECT pay_common_package_refund_result($1,$2,$3)',[o.id,approval.id,refund]);
  await service.query('SELECT pay_common_package_refund_result($1,$2,$3)',[o.id,approval.id,refund]);
  const late=await pay(o,{method:o.payment_method==='alipay'?'alipay':'card'});
  if(o.refundFailure){
   assert.equal(late.duplicate,true);
   assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[o.user_id])).rows[0].credits,3480);
  } else assert.equal(late.reason,'refund_observed');
  const status=(await admin.query('SELECT payment_status FROM payment_orders WHERE id=$1',[o.id])).rows[0].payment_status;
  assert.equal(status,o.refundFailure?'paid':'refunded');
  assert.equal((await admin.query("SELECT channel FROM payment_provider_refs WHERE order_id=$1 AND object_type='refund'",[o.id])).rows[0].channel,'waffo');
  if(o.item_type==='membership_plan'&&!o.refundFailure)assert.equal((await admin.query('SELECT status FROM user_subscriptions WHERE id=(SELECT subscription_id FROM payment_orders WHERE id=$1)',[o.id])).rows[0].status,'canceled');
 }
 cases.push('waffo-discounted-card-cn-credit-pack','card-and-alipay-membership-refund-closes-entitlements','package-refund-on-original-provider','failed-waffo-refund-restores-once','duplicate-refund-and-late-paid-never-regrant');
 // Actual Alipay facts are simulated; checkout's requested card stays frozen as original evidence.
 const hosted=await create();await bind(hosted);await pay(hosted,{method:'alipay'});
 const hostedFacts=(await admin.query('SELECT payment_method,provider_payment_method FROM payment_orders WHERE id=$1',[hosted.id])).rows[0];
 assert.equal(hostedFacts.payment_method,'card');assert.equal(hostedFacts.provider_payment_method,'alipay');
 cases.push('actual-alipay-differs-from-requested-card');
 // Waffo one-time source can append a Stripe wallet term after the emergency ends.
 await switchTo('stripe');
 const prior=(await admin.query('SELECT subscription_id,entitlement_end FROM payment_orders WHERE id=$1',[hosted.id])).rows[0];
 const back=await create({user:hosted.user_id,method:'alipay',cycle:'yearly',transition:'wallet_renewal',prior:prior.subscription_id});
 assert.equal(back.payment_channel,'stripe');assert.equal(back.auto_renew,false);
 await switchTo('waffo');
 cases.push('switchback-wallet-renewal-accepts-waffo-source');
 // Live is code-compatible without touching a real store, keys, or settings.
 await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
  membership_plan_id,billing_cycle,is_current,offer_kind,price_usage)
  SELECT channel,merchant_namespace,'live',object_type,external_id||'live',membership_plan_id,billing_cycle,is_current,
   offer_kind,price_usage FROM payment_provider_refs WHERE channel='waffo' AND mode='test'
   AND membership_plan_id=$1 AND billing_cycle='monthly' AND offer_kind='standard' AND price_usage='one_time'`,[plan]);
 const live=await create({mode:'live'});await bind(live);assert.equal((await pay(live)).state,'fulfilled');
 assert.equal((await admin.query('SELECT payment_mode FROM user_subscriptions WHERE id=(SELECT subscription_id FROM payment_orders WHERE id=$1)',[live.id])).rows[0].payment_mode,'live');
 const receipt=(await service.query("SELECT pay_waffo_receive_event('fixture','live','onetime.payment_succeeded',$1,$2,$3) v",[
  randomUUID(),'b'.repeat(64),{paymentId:`PAY_${live.id}`,orderId:live.id}])).rows[0].v;
 await service.query("SELECT pay_waffo_resolve_receipt($1,'fixture','applied','onetime_paid')",[receipt]);
 assert.equal((await admin.query('SELECT status FROM waffo_event_receipts WHERE id=$1',[receipt])).rows[0].status,'applied');
 cases.push('live-one-time-code-contract-only','live-receipt-mode-retained');
 // The same locked pool is shared by both providers, including reservations and unknown-cash review.
 for(let i=0;i<49;i++)await create({item:gold,cycle:'yearly',offer:'founder'});
 const userA=randomUUID(),userB=randomUUID();await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0),($2,0)',[userA,userB]);
 const second=await connect();await second.query('SET ROLE service_role');
 const competition=await Promise.allSettled([create({user:userA,item:gold,cycle:'yearly',offer:'founder'}),
  create({user:userB,item:gold,cycle:'yearly',offer:'founder',db:second})]);
 assert.equal(competition.filter(r=>r.status==='fulfilled').length,1);
 assert.match(competition.find(r=>r.status==='rejected').reason.message,/FOUNDER_SOLD_OUT/);
 await switchTo('stripe');
 await assert.rejects(()=>create({item:gold,cycle:'yearly',offer:'founder',method:'alipay'}),/FOUNDER_SOLD_OUT/);
 await switchTo('waffo');
 cases.push('concurrent-founder-pool-max-50','same-founder-pool-after-route-change');
 // Checkout erasure projects only the known one-time transport; PII and redirect URLs are removed.
 const envelope=(await admin.query('SELECT checkout_request FROM payment_orders WHERE id=$1',[hosted.id])).rows[0].checkout_request;
 const projected=(await service.query("SELECT erasure_payment_envelope($1,'checkout') v",[envelope]).catch(()=>({rows:[]}))).rows[0]?.v
  ??(await admin.query("SELECT erasure_payment_envelope($1,'checkout') v",[envelope])).rows[0].v;
 assert.equal(projected.purchaseMode,'payment');assert.equal(projected.providerRequest.buyerIdentity,undefined);
 assert.equal(projected.providerRequest.successUrl,undefined);
 await assert.rejects(()=>admin.query("SELECT erasure_payment_envelope($1,'checkout')",[{...envelope,providerRequest:{...envelope.providerRequest,evil:'unrecognized'}}]),/REQUEST_REVIEW/);
 const liveEnvelope={...envelope,mode:'live'};
 assert.equal((await admin.query("SELECT erasure_payment_envelope($1,'checkout') v",[liveEnvelope])).rows[0].v.mode,'live');
 const owning=(await admin.query('SELECT to_jsonb(o) v FROM payment_orders o WHERE id=$1',[hosted.id])).rows[0].v;
 const erased={...owning,checkout_request:projected,request_erased_at:new Date().toISOString()};
 // No account closure exists yet, so the transition returns false after validating the transport/row binding.
 assert.equal((await admin.query('SELECT erasure_envelope_transition($1,$2) v',[owning,erased])).rows[0].v,false);
 await assert.rejects(()=>admin.query('SELECT erasure_envelope_transition($1,$2)',[
  {...owning,mode:'subscription'},erased]),/REQUEST_REVIEW/);
 cases.push('test-and-live-one-time-erasure-shape','erasure-removes-buyer-and-redirect','erasure-unknown-shape-review');
 return cases;
}
