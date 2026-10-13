/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP 3c (0247): external refunds (Link, Stripe, Dashboard) of Stripe card orders. */
export async function stripeMpExternalRefundCases({admin,service,connect}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const terms=digest=>JSON.stringify([{kind:'email',key_version:'test-v1',digest}]);
  const checkout=async(user,o,method)=>{
    const expiry=new Date(Date.now()+1800000),id=`cs_${o.id}`;
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',id,expiry]);
    return id;
  };
  // A card subscription whose first month is running now.
  const member=async(method,digest,tax=0)=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    // International card: first month 69-20 (gold_first30); mainland card: standard 69.
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',$3,$4,'fixture',
      'test',$5,'terms-v1',$6) o`,[user,plan,method,method==='card'?'gold_first30':'standard',version,terms(digest)])).rows[0];
    const cs=await checkout(user,o,method);
    const start=new Date(Math.floor(Date.now()/1000)*1000-60000),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
    const paid=(await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[o.id,'fixture',cs,
      `in_${o.id}`,o.amount_total,'usd',new Date(start.getTime()+6000),`sub_${o.id}`,start,end])).rows[0].v;
    assert.equal(paid.state,'fulfilled',JSON.stringify(paid));
    // Every card payment records its tax right after fulfillment (0237; 0 without Managed Payments).
    if(tax!==null) await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,$3)`,[o.id,`in_${o.id}`,tax]);
    return {user,o,payment:`in_${o.id}`};
  };
  const record=(f,refund,amount,db=service)=>db.query(`SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,$3,$4,'usd',$5) v`,
    [f.o.id,f.payment,refund,amount,new Date()]);
  const profile=async user=>(await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[user])).rows[0];
  const order=async f=>(await admin.query('SELECT status,payment_status,metadata,payment_amount_facts FROM payment_orders WHERE id=$1',
    [f.o.id])).rows[0];
  const facts=async user=>(await service.query('SELECT pay_common_membership_facts($1) v',[user])).rows[0].v.internal_membership;

  // Taxed first month (69-20=49 + 9.80 tax): a partial refund is only recorded and kept for review.
  const card=await member('card','c1'.repeat(32),980);
  assert.deepEqual(await profile(card.user),{credits:8970,membership_level:'gold'});
  const partial=(await record(card,'re_partial',1000)).rows[0].v;
  assert.equal(partial.state,'partial_review');
  assert.deepEqual([partial.refundedMinor,partial.chargedMinor],[1000,5880],'charged = pre-tax 4900 + recorded tax 980');
  assert.deepEqual(await profile(card.user),{credits:8970,membership_level:'gold'},'a partial refund changes nothing');
  assert.equal((await facts(card.user)).mapping_state,'internal_paid');
  assert.equal((await order(card)).metadata.stripeExternalRefund.state,'partial_review');
  // The refund that completes the full amount ends what the order paid for, once.
  const full=(await record(card,'re_rest',4880)).rows[0].v;
  assert.deepEqual([full.state,full.creditsTakenBack,full.creditsShortfall,full.renewing],['refunded',8970,0,true]);
  assert.equal((await record(card,'re_rest',4880)).rows[0].v.duplicate,true,'a repeated event is recorded once');
  assert.deepEqual(await profile(card.user),{credits:0,membership_level:'free'},'credits back and the cached level settled (0243)');
  const ended=await order(card);
  assert.deepEqual([ended.status,ended.payment_status],['refunded','refunded'],'recognisable as refunded (founder rules)');
  assert.deepEqual(ended.payment_amount_facts.filter(x=>x.kind==='refund').map(x=>x.amount),['10.00','48.80']);
  assert.notEqual((await facts(card.user)).mapping_state,'internal_paid','no membership from a refunded order');
  assert.equal((await admin.query(`SELECT count(*)::int n FROM subscription_credit_grants WHERE source_order_id=$1 AND status='reversed'`,
    [card.o.id])).rows[0].n,1);
  assert.equal((await admin.query(`SELECT count(*)::int n FROM credit_transactions WHERE source_order_id=$1 AND ledger_type='refund_clawback'`,
    [card.o.id])).rows[0].n,1);
  assert.equal((await admin.query(`SELECT count(*)::int n FROM payment_provider_refs WHERE order_id=$1 AND object_type='refund'`,
    [card.o.id])).rows[0].n,2);

  // Credits already used: only the remaining balance is taken back; the shortfall is Graylum's and is recorded.
  const spent=await member('card_cn','c2'.repeat(32));
  await admin.query('UPDATE profiles SET credits=500 WHERE id=$1',[spent.user]);
  const short=(await record(spent,'re_spent',spent.o.amount_total)).rows[0].v;
  assert.deepEqual([short.state,short.creditsTakenBack,short.creditsShortfall],['refunded',500,8470]);
  assert.equal((await profile(spent.user)).credits,0,'never below zero');
  assert.equal((await order(spent)).metadata.stripeExternalRefund.creditsShortfall,8470);
  const ledger=async f=>(await admin.query(`SELECT amount,source_refund_id,metadata FROM credit_transactions WHERE source_order_id=$1
    AND ledger_type='refund_clawback'`,[f.o.id])).rows;
  assert.deepEqual((await ledger(spent)).map(r=>[r.amount,r.source_refund_id,r.metadata.creditsShortfall,r.metadata.shortfallAbsorbedBy]),
    [[-500,'re_spent',8470,'graylum']],'the shortfall Graylum absorbs is in the ledger');
  // Nothing left to take back: the ledger still records the whole grant as Graylum's loss.
  const empty=await member('card_cn','c5'.repeat(32));
  await admin.query('UPDATE profiles SET credits=0 WHERE id=$1',[empty.user]);
  assert.equal((await record(empty,'re_empty',empty.o.amount_total)).rows[0].v.creditsShortfall,8970);
  assert.deepEqual((await ledger(empty)).map(r=>[r.amount,r.metadata.creditsShortfall]),[[0,8970]]);

  // Without the payment's recorded tax the charged total is unknown: refused (Stripe retries), nothing recorded.
  const untaxed=await member('card','c7'.repeat(32),null);
  await assert.rejects(()=>record(untaxed,'re_untaxed',untaxed.o.amount_total),/TAX_PENDING/);
  assert.equal((await order(untaxed)).payment_amount_facts.filter(x=>x.kind==='refund').length,0);
  await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,980)`,[untaxed.o.id,untaxed.payment]);
  assert.equal((await record(untaxed,'re_untaxed',untaxed.o.amount_total)).rows[0].v.state,'partial_review',
    'the pre-tax amount alone is not a full refund of a taxed charge');

  // Only this period's unused grant credits are taken back; credits from other sources stay.
  const mixed=await member('card_cn','c8'.repeat(32));
  await admin.query(`UPDATE subscription_credit_grants SET consumed_amount=8000 WHERE source_order_id=$1`,[mixed.o.id]);
  await admin.query('UPDATE profiles SET credits=5970 WHERE id=$1',[mixed.user]);
  const mixedRefund=(await record(mixed,'re_mixed',mixed.o.amount_total)).rows[0].v;
  assert.deepEqual([mixedRefund.creditsTakenBack,mixedRefund.creditsShortfall],[970,0]);
  assert.equal((await profile(mixed.user)).credits,5000,'the 5000 credits from another source are untouched');

  // Several partial refunds: the one that reaches the full amount ends the order, exactly once; later ones only record.
  const parts=await member('card_cn','c6'.repeat(32));
  const states=[];
  for(const [id,amount] of [['re_p1',2000],['re_p2',2000],['re_p1',2000],['re_p3',parts.o.amount_total-4000],['re_p4',100]]) {
    const v=(await record(parts,id,amount)).rows[0].v; states.push(`${v.state}${v.duplicate?':dup':''}`);
  }
  assert.deepEqual(states,['partial_review','partial_review','recorded:dup','refunded','refunded'],JSON.stringify(states));
  assert.equal((await ledger(parts)).length,1,'credits are taken back once');
  assert.equal((await profile(parts.user)).credits,0);
  assert.equal((await order(parts)).payment_amount_facts.filter(x=>x.kind==='refund').length,4,'re_p1 delivered twice, recorded once');

  // Two refunds arriving together that only add up to a full refund: exactly one ends the order.
  const both=await member('card_cn','c3'.repeat(32));
  const one=await connect(),two=await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  const half=Math.floor(both.o.amount_total/2);
  const results=(await Promise.all([record(both,'re_half_a',half,one),record(both,'re_half_b',both.o.amount_total-half,two)]))
    .map(r=>r.rows[0].v.state).sort();
  assert.deepEqual(results,['partial_review','refunded'],JSON.stringify(results));
  assert.equal((await admin.query(`SELECT count(*)::int n FROM credit_transactions WHERE source_order_id=$1 AND ledger_type='refund_clawback'`,
    [both.o.id])).rows[0].n,1);

  // International card credit pack (member only): a full refund takes the pack's credits back.
  const buyer=await member('card','c4'.repeat(32));
  const pkg=(await admin.query(`INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,active)
    VALUES('Refund fixture',990,990,0,'true') RETURNING id`)).rows[0].id;
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
    billing_cycle,is_current,package_tier,price_usage) VALUES('stripe','fixture','test','price',$1,$2,'one_time',true,'gold','package')`,
    [`price_refund_${pkg}`,pkg]);
  const po=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'credit_package',$2,'one_time','card','standard','fixture',
    'test',$3,'terms-v1',NULL) o`,[buyer.user,pkg,version])).rows[0];
  const pcs=await checkout(buyer.user,po,'card');
  assert.equal((await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,$4,'usd',$5,NULL,NULL,NULL) v`,
    [po.id,pcs,`pi_${po.id}`,po.amount_total,new Date()])).rows[0].v.state,'fulfilled');
  const pack={o:po,payment:`pi_${po.id}`};
  await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,0)`,[po.id,pack.payment]);
  const beforePack=(await profile(buyer.user)).credits;
  // A pack is not tracked per source yet: the full refund ends the order and is reported for a person to settle
  // (MASTER_PLAN item 47), with the pack, its credits and the balance; no credits are taken automatically.
  const packRefund=(await record(pack,'re_pack',po.amount_total)).rows[0].v;
  assert.deepEqual([packRefund.state,packRefund.packageId,packRefund.packCredits,packRefund.balance],
    ['pack_review',pkg,990,beforePack]);
  assert.equal((await record(pack,'re_pack',po.amount_total)).rows[0].v.duplicate,true,'the same refund event, once');
  assert.equal((await profile(buyer.user)).credits,beforePack);
  assert.deepEqual([(await order(pack)).status,(await order(pack)).metadata.stripeExternalRefund.state],['refunded','pack_review']);
  assert.equal((await record(pack,'re_pack_more',10)).rows[0].v.state,'refunded','a later refund only records');
  assert.equal((await order(pack)).metadata.stripeExternalRefund.state,'pack_review','and keeps the review marker');
  assert.equal((await profile(buyer.user)).membership_level,'gold','a pack refund leaves the membership alone');

  // Scope: only a payment this card order recorded; one refund belongs to one order; service role only.
  await assert.rejects(()=>service.query(`SELECT pay_stripe_mp_record_external_refund($1,'fixture','in_not_ours','re_x',100,'usd',now())`,
    [buyer.o.id]),/REFUND_SCOPE/);
  await assert.rejects(()=>record(buyer,'re_pack',100),/REFUND_IDENTITY_MISMATCH/,'a refund id cannot move to another order');
  await assert.rejects(()=>service.query(`SELECT pay_stripe_mp_record_external_refund($1,'other_merchant',$2,'re_z',100,'usd',now())`,
    [buyer.o.id,buyer.payment]),/REFUND_SCOPE/);
  for(const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>record(buyer,'re_role',100),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['stripe-mp-external-refund-partial-review','stripe-mp-external-refund-full-ends-order','stripe-mp-external-refund-once',
    'stripe-mp-external-refund-settles-level','stripe-mp-external-refund-shortfall-recorded',
    'stripe-mp-external-refund-concurrent-one-end','stripe-mp-external-refund-pack','stripe-mp-external-refund-duplicate-once',
    'stripe-mp-external-refund-partials-reach-full-once','stripe-mp-external-refund-tax-pending',
    'stripe-mp-external-refund-only-this-grant','stripe-mp-external-refund-pack-review','stripe-mp-external-refund-shortfall-ledger','stripe-mp-external-refund-scope'];
}
