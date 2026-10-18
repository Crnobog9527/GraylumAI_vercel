/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local PostgreSQL test mode only. No Stripe, credentials or remote state.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {membershipCases} from './membership.mjs';
import {localDb, read} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const v=async(sql,args=[],client=c)=>(await client.query(sql,args)).rows[0]?.v;
const hour = 3600000, iso = ms => new Date(Date.now() + ms).toISOString();

const profile = async credits => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,$2)', [id, credits]);
  return id;
};
// A paid international-card credit pack, granted the way 0211 grants it ('method-package:'), with its payment and
// tax recorded so the real 0247 external-refund function accepts it.
const pack = async (user, credits, at = iso(0), delivered = true, method = 'card') => {
  const item = randomUUID(), order = randomUUID(), payment = 'pi_' + order.replaceAll('-', '');
  await c.query('INSERT INTO credit_packages(id,name,credits_amount,price,bonus_credits) VALUES($1,$2,$3,10,0)', [item, 'Fixture ' + item, credits]);
  const snap = { version: 1, item_type: 'credit_package', item_id: item, item_updated_at: '2026-10-01T00:00:00Z',
    billing_cycle: 'one_time', currency: 'usd', unit: 'major', price: '10', discount: '0', tax_behavior: 'inclusive',
    credits, bonus_credits: 0 };
  await c.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
    payment_channel,merchant_namespace,payment_mode,payment_method,purchase_request_id,purchase_payload_hash,purchase_snapshot,
    amount_total,currency,fulfilled_at,payment_amount_facts,metadata,routing_version,terms_version,terms_accepted_at,auto_renew,offer_kind,
    qualification_state,stripe_managed_payments) VALUES($1,$2,'credit_package',$3,'one_time','payment','completed','paid',
    'stripe','fixture','test',$9,gen_random_uuid(),repeat('a',64),$4,1000,'usd',$5,
    jsonb_build_array(jsonb_build_object('kind','tax','amount','0.00','currency','usd','unit','major','evidence_ref',$6::text)),
    jsonb_build_object('grantedCredits',$7::int),1,'terms-v1',$8,false,'standard','sold',$10)`, [order, user, item, snap, delivered ? at : null, payment, credits, at, method, method === 'card' ? true : null]);
  await c.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('stripe','fixture','test','payment',$1,$2)`, [payment, order]);
  if (delivered) await c.query('UPDATE profiles SET credits=credits+$2 WHERE id=$1', [user, credits]);
  if (delivered) await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key,created_at)
    VALUES($1,$2,'purchase','grant',$3,$4,$5)`, [user, credits, order, 'method-package:' + order, at]);
  return { order, payment, source: await v('SELECT id v FROM credit_package_sources WHERE order_id=$1', [order]) };
};
const externalRefund = (p, refund, amount = 1000) => v(`SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,$3,$4,'usd',now()) v`,
  [p.order, p.payment, refund, amount]);
const reserve = (user, n) => v("SELECT pre_deduct_id v FROM atomic_pre_deduct($1,$2,'fixture',gen_random_uuid())", [user, n]);
const refund = (user, pre) => c.query('SELECT * FROM bill2_legacy_refund($1,$2)', [user, pre]);
const balance = user => v('SELECT credits v FROM profiles WHERE id=$1', [user]);
const packUsed = source => v('SELECT consumed_amount v FROM credit_package_sources WHERE id=$1', [source]);
const blocked = user => assert.rejects(() => reserve(user, 1), /PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED/);
// The most a single reservation can take right now (largest n that atomic_pre_deduct accepts), restored after probing.
const spendable = async user => {
  let lo = 0, hi = await balance(user);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    await c.query('BEGIN');
    try { await reserve(user, mid); lo = mid; } catch { hi = mid - 1; }
    await c.query('ROLLBACK');
  }
  return lo;
};
const settle = (actor, order, decision) => v('SELECT pay_common_pack_refund_review_settle($1,$2,$3) v', [actor, order, decision]);
const admin = async () => {
  const id = await profile(0);
  await c.query("UPDATE profiles SET role='admin',status='active' WHERE id=$1", [id]);
  return id;
};

const receive=async(p, overrides={},client=c)=>{
 const event={id:'evt_'+randomUUID().replaceAll('-',''),disputeId:p.du??'du_'+p.order.replaceAll('-',''),
  chargeId:'ch_'+p.order.replaceAll('-',''),paymentIntentId:'pi_'+p.order.replaceAll('-',''),orderId:p.order,
  type:'charge.dispute.created',created:iso(0),paymentAt:iso(-hour),openedAt:iso(0),amount:1000,currency:'usd',
  reason:'fraudulent',status:'needs_response',balanceTransactions:[],...overrides};
 await client.query('SET ROLE service_role');
 try {return await v("SELECT pay_dispute_receive('fixture','test',$1) v",[event],client);} finally {await client.query('RESET ROLE');}
};
const state=p=>v('SELECT freeze_state v FROM payment_disputes WHERE order_id=$1',[p.order]);
const frozen=p=>v('SELECT dispute_frozen_credits v FROM credit_package_sources WHERE order_id=$1',[p.order]);
const withdraw=async(ops,d)=>{await c.query('SET ROLE service_role');try{return await v('SELECT pay_dispute_withdraw($1,$2) v',[ops,d.id]);}finally{await c.query('RESET ROLE');}};
try {
 const ops=await admin();
 // Multiple disputes of the same payment share a source hold; withdrawing one cannot release another's hold.
 const um=await profile(0),pm=await pack(um,100,iso(-hour));
 const dm1=await receive(pm),dm2=await receive(pm,{disputeId:'du_second_'+pm.order.replaceAll('-','')});
 assert.equal(await frozen(pm),100);assert.equal((await withdraw(ops,dm1)).restored,0);
 assert.equal(await balance(um),0);assert.equal((await withdraw(ops,dm2)).restored,100);
 report.checks.push('multiple disputes on one payment share one hold; only the final withdrawal releases it');
 // Duplicate event, terminal-before-open ordering and separate event receipts.
 const u=await profile(50),p=await pack(u,100,iso(-hour)),q=await pack(u,200,iso(-hour/2));
 const eventId='evt_'+randomUUID().replaceAll('-','');
 let d=await receive(p,{id:eventId});
 assert.equal(await balance(u),250);assert.equal(await frozen(p),100);
 assert.equal(await v('SELECT pay_founder_order_frozen($1) v',[p.order]),true);
 assert.equal((await receive(p,{id:eventId})).duplicate,true);assert.equal(await balance(u),250);
 let pre=await reserve(u,200);
 assert.equal(await packUsed(p.source),0);assert.equal(await packUsed(q.source),150);
 await refund(u,pre);assert.equal(await packUsed(p.source),0);assert.equal(await balance(u),250);
 assert.equal((await withdraw(ops,d)).restored,100);assert.equal(await balance(u),350);
 assert.equal(await v('SELECT pay_founder_order_frozen($1) v',[p.order]),false);
 assert.equal((await withdraw(ops,d)).duplicate,true);assert.equal(await balance(u),350);
 await receive(p);assert.equal(await balance(u),350,'replayed updated actions never refreeze a withdrawn hold');
 report.checks.push('duplicate-event; other sources stay spendable; failed calls stay attributed; withdrawal exactly once');
 const u2=await profile(0),p2=await pack(u2,100,iso(-hour));
 d=await receive(p2,{type:'charge.dispute.closed',status:'won',created:iso(-100)});
 assert.equal(d.freeze_state,'frozen');assert.equal(d.status,'won');
 d=await receive(p2,{type:'charge.dispute.updated',status:'under_review',created:iso(-200)});
 assert.equal(d.status,'won');
 for(const type of ['charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated']){
  const id='evt_'+randomUUID().replaceAll('-','');await receive(p2,{type,id,status:'won'});await receive(p2,{type,id,status:'won'});
 }
 assert.equal(await v('SELECT count(*)::int v FROM payment_dispute_fund_events WHERE dispute_id=$1',[d.id]),2);
 report.checks.push('closed first freezes; late update never reopens; fund events append once');
 // Returns after a freeze go back to this source and increase the hold, never spendable balance.
 const u3=await profile(30),p3=await pack(u3,100,iso(-hour));
 pre=await reserve(u3,80); // 30 unattributed + 50 from this source.
 d=await receive(p3);assert.equal(await balance(u3),0);assert.equal(await frozen(p3),50);
 await refund(u3,pre);assert.equal(await balance(u3),30);assert.equal(await frozen(p3),100);
 assert.equal(await packUsed(p3.source),0);await withdraw(ops,d);assert.equal(await balance(u3),130);
 report.checks.push('in-flight refund restores original source and increases frozen amount');
 const u4=await profile(0),p4=await pack(u4,100,iso(-hour));
 pre=await reserve(u4,30);d=await receive(p4);assert.equal(await frozen(p4),70);
 await c.query('SELECT * FROM bill2_legacy_settle($1,$2,10,$3,NULL)',[u4,pre,{}]);
 assert.equal(await frozen(p4),90);assert.equal(await balance(u4),0);
 await withdraw(ops,d);assert.equal(await balance(u4),90);
 report.checks.push('in-flight lower settlement freezes returned credits');
 // Multiple operations in one transaction cannot mistake a pending freeze adjustment for unattributed credits.
 const ut=await profile(0),pt=await pack(ut,100,iso(-hour)),qt=await pack(ut,100,iso(-hour/2));
 pre=await reserve(ut,30);d=await receive(pt);
 await c.query('BEGIN');await refund(ut,pre);await reserve(ut,50);await c.query('COMMIT');
 assert.equal(await packUsed(pt.source),0);assert.equal(await packUsed(qt.source),50);
 assert.equal(await balance(ut),50);assert.equal(await frozen(pt),100);
 await withdraw(ops,d);assert.equal(await balance(ut),150);
 report.checks.push('same-transaction restore/reserve: pending hold is excluded from both balance admission and source attribution');
 // Extra usage comes out of the original frozen package, even when the spendable balance is zero.
 const ux=await profile(0),px=await pack(ux,100,iso(-hour));
 pre=await reserve(ux,30);d=await receive(px);
 await c.query('SELECT * FROM bill2_legacy_settle($1,$2,50,$3,NULL)',[ux,pre,{}]);
 assert.equal(await frozen(px),50);assert.equal(await balance(ux),0);assert.equal(await packUsed(px.source),50);
 await withdraw(ops,d);assert.equal(await balance(ux),50);
 report.checks.push('excess settlement uses frozen remainder without debiting other sources');
 const uo=await profile(0),po=await pack(uo,50,iso(-hour)),qo=await pack(uo,50,iso(-hour/2));
 pre=await reserve(uo,30);d=await receive(po);
 await c.query('SELECT * FROM bill2_legacy_settle($1,$2,60,$3,NULL)',[uo,pre,{}]);
 assert.equal(await frozen(po),0);assert.equal(await packUsed(po.source),50);assert.equal(await packUsed(qo.source),10);
 assert.equal(await balance(uo),40);
 assert.equal(await v('SELECT source_review_required v FROM payment_disputes WHERE id=$1',[d.id]),true);
 report.checks.push('overrun beyond frozen remainder uses other available balance by existing rules and flags manual review');
 // Unknown source remainder: never take other money.
 const u5=await profile(40),p5=await pack(u5,100,iso(-hour));
 await c.query("INSERT INTO credit_source_reviews(source_kind,source_id,reason) VALUES('credit_package',$1,'pre_attribution_consumption')",
  [p5.source]);
 d=await receive(p5);assert.equal(await balance(u5),140);assert.equal(await frozen(p5),0);
 report.checks.push('unknown sources alert-only, no balance deduction');
 // A cash refund already claimed before the dispute: failure restores into the frozen source.
 const ur=await profile(25),pr=await pack(ur,100,iso(-hour)),intent=randomUUID();
 const cash={chargeId:'ch_refund_race',paymentIntentId:pr.payment};
 await c.query('UPDATE payment_orders SET refund_approval=$2 WHERE id=$1',[pr.order,
  {id:intent,status:'dispatching',idempotencyKey:'pay-common:refund:'+intent,cash,currency:'usd',netMinor:'1000',credits:100}]);
 await c.query('UPDATE profiles SET credits=credits-100 WHERE id=$1',[ur]);
 await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key)
  VALUES($1,-100,'deduction','refund_clawback',$2,$3)`,[ur,pr.order,'pay-common:refund:'+intent]);
 d=await receive(pr);assert.equal(await frozen(pr),0);
 await c.query('SELECT pay_common_package_refund_result($1,$2,$3)',[pr.order,intent,
  {id:'re_race_failed',intentId:intent,orderId:pr.order,paymentIntentId:pr.payment,chargeId:cash.chargeId,
   currency:'usd',amount:'1000',mode:'test',merchant:'fixture',status:'failed'}]);
 assert.equal(await balance(ur),25);assert.equal(await frozen(pr),100);
 await withdraw(ops,d);assert.equal(await balance(ur),125);
 report.checks.push('actual package refund failure after an already claimed refund restores into the dispute hold');
 // PAYG's separate compensation path must also return the original source into the hold.
 const uc=await profile(0),pc=await pack(uc,100,iso(-hour));
 pre=await reserve(uc,40);await c.query('SELECT * FROM bill2_legacy_settle($1,$2,40,$3,NULL)',[uc,pre,{}]);
 d=await receive(pc);
 const call=randomUUID(),run=randomUUID();
 await c.query('ALTER TABLE credit_transactions DISABLE TRIGGER ALL');
 try {
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,bill2_call_id,idempotency_key)
   VALUES($1,0,'adjustment','spend','bill2_spend',$2,$3)`,[uc,call,'fixture-spend:'+call]);
  assert.equal(await v('SELECT bill2_payg_compensate(jsonb_populate_record(NULL::bill2_runs,$1),jsonb_populate_record(NULL::bill2_calls,$2)) v',
   [{id:run,actor_id:uc,closed:true,outcome:'confirmed_failure'},
    {id:call,run_id:run,pre_deduct_id:pre,settled_at:iso(0),charged_delta:40}]),40);
 } finally {await c.query('ALTER TABLE credit_transactions ENABLE TRIGGER ALL');}
 assert.equal(await balance(uc),0);assert.equal(await frozen(pc),100);await withdraw(ops,d);assert.equal(await balance(uc),100);
 report.checks.push('PAYG compensation function with synthetic run/call records increases frozen credits, not spendable balance');
 // Full external refund replaces the freeze; an already refunded payment cannot freeze twice.
 const u6=await profile(50),p6=await pack(u6,100,iso(-hour));
 d=await receive(p6);await externalRefund(p6,'re_dispute_full');
 assert.equal(await balance(u6),50);assert.equal(await state(p6),'superseded');
 await assert.rejects(()=>withdraw(ops,d),/PAY_DISPUTE_NOT_FROZEN/);
 await receive(p6);assert.equal(await balance(u6),50);
 const ul=await profile(0),pl=await pack(ul,100,iso(-hour));
 const flight=await reserve(ul,30);await receive(pl);await externalRefund(pl,'re_inflight_superseded');
 await refund(ul,flight);assert.equal(await balance(ul),0);
 report.checks.push('refund supersedes a freeze: subsequent in-flight pack return is clawed back once');
 const uw=await profile(40),pw=await pack(uw,100,iso(-hour),true,'alipay');
 await receive(pw);await externalRefund(pw,'re_wallet_dispute');assert.equal(await balance(uw),40);
 assert.equal(await state(pw),'superseded');
 report.checks.push('unexpected wallet-pack dispute uses the same freeze-to-refund conversion without touching other credits');
 const u7=await profile(40),p7=await pack(u7,100,iso(-hour));await externalRefund(p7,'re_before_dispute');
 d=await receive(p7);assert.equal(d.freeze_state,'superseded');assert.equal(await balance(u7),140);
 report.checks.push('freeze then external refund; refund then dispute; no duplicate clawback');
 // Concurrent consumption and freeze serialize on the profile. The final available + frozen + consumed is exact.
 const u8=await profile(0),p8=await pack(u8,100,iso(-hour));
 const peer=new pg.Client(c.connectionParameters);await peer.connect();
 try {
  await peer.query('BEGIN');
  await peer.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[u8]);
  const pending=receive(p8);
  const reserved=await peer.query("SELECT pre_deduct_id FROM atomic_pre_deduct($1,30,'concurrent',gen_random_uuid())",[u8]);
  await peer.query('COMMIT');
  d=await pending;assert.equal(await frozen(p8),70);assert.equal(await balance(u8),0);
  await refund(u8,reserved.rows[0].pre_deduct_id);assert.equal(await frozen(p8),100);assert.equal(await balance(u8),0);
  await withdraw(ops,d);assert.equal(await balance(u8),100);
 } finally {await peer.end();}
 report.checks.push('real two-connection consumption/freeze serialization and restoration');
 // A dispute may precede payment mapping. The first fulfillment claims only its own canonical payment.
 const up=await profile(0),pa=await pack(up,100,iso(0),false),pb=await pack(up,100,iso(0),false);
 const fulfill=async(p,user,client=c)=>{
  const checkout='cs_'+p.order.replaceAll('-','');
  await client.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('stripe','fixture','test','checkout',$1,$2) ON CONFLICT DO NOTHING`,[checkout,p.order]);
  return v('SELECT pay_dispute_fulfill($1) v',[{orderId:p.order,merchant:'fixture',mode:'test',checkoutId:checkout,
   paymentId:p.payment,paymentIntentId:p.payment,amount:1000,currency:'usd',paidAt:iso(0),subscriptionId:null,start:null,end:null}],client);
 };
 const pending=await receive(pa,{orderId:null});assert.equal(pending.freeze_state,'pending');
 await fulfill(pb,up);assert.equal(await balance(up),100);
 await fulfill(pa,up);assert.equal(await balance(up),100);assert.equal(await frozen(pa),100);
 assert.equal(await v('SELECT order_id v FROM payment_disputes WHERE id=$1',[pending.id]),pa.order);
 report.checks.push('dispute first: first fulfillment atomically claims pending dispute; another equal-price payment remains usable');
 // Lock the payment first to deterministically exercise a payment winning the two-session race.
 const ua=await profile(0),pp=await pack(ua,100,iso(0),false),otherSession=new pg.Client(c.connectionParameters);
 await otherSession.connect();
 try {
  await otherSession.query('BEGIN');await otherSession.query('SELECT pay_dispute_lock($1,NULL)',['fixture:test:'+pp.payment]);
  const incoming=receive(pp,{orderId:null});
  await fulfill(pp,ua,otherSession);await otherSession.query('COMMIT');await incoming;
  assert.equal(await balance(ua),0);assert.equal(await frozen(pp),100);
 } finally {await otherSession.end();}
 report.checks.push('real two-session payment/dispute race: mapping is rechecked under the same canonical payment lock');
 // Access checks are enforced in SQL, independently of the future admin button.
 await assert.rejects(()=>withdraw(u8,d),/PAY_DISPUTE_ADMIN_REQUIRED/);
 await c.query('SET ROLE authenticated');
 await assert.rejects(()=>v("SELECT pay_dispute_receive('fixture','test','{}') v"),/permission denied/);
 await c.query('RESET ROLE');
 report.checks.push('admin and service-role allow/deny boundaries');
 await membershipCases({c,v,profile,receive,withdraw,ops,report});
 // Optional PAY-EVIDENCE integration: model its documented table locally; no personal evidence is created.
 await c.query(`CREATE TABLE payment_order_evidence(order_id uuid PRIMARY KEY,hold_reason text,
  pending_delete_at timestamptz,expires_at timestamptz)`);
 const ue=await profile(0),pe=await pack(ue,100,iso(-hour)),child=await pack(ue,100,iso(-hour));
 await c.query('UPDATE payment_orders SET source_order_id=$2 WHERE id=$1',[child.order,pe.order]);
 await c.query("INSERT INTO payment_order_evidence VALUES($1,NULL,now()-interval '25 hours',now()-interval '1 day')",[pe.order]);
 d=await receive(child);
 assert.equal(await v('SELECT pending_delete_at v FROM payment_order_evidence WHERE order_id=$1',[pe.order]),null);
 assert.equal(await v('SELECT hold_reason v FROM payment_order_evidence WHERE order_id=$1',[pe.order]),'payment_dispute');
 await receive(child,{type:'charge.dispute.closed',status:'won'});
 assert.equal(await v('SELECT hold_reason v FROM payment_order_evidence WHERE order_id=$1',[pe.order]),null);
 assert.equal(await v("SELECT expires_at>now()+interval '89 days' v FROM payment_order_evidence WHERE order_id=$1",[pe.order]),true);
 report.checks.push('documented PAY-EVIDENCE table adapter: root-order hold, pending-delete reset and 90-day extension');
 console.log(JSON.stringify(report,null,2));
} finally {await db.close();}
