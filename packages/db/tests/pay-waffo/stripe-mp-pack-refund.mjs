/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP step 4b-1 (0252): our approved refund of an international card pack (Managed Payments, tax on top). */
export async function stripeMpPackRefundCases({admin,service}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const actor=randomUUID();
  await admin.query("INSERT INTO profiles(id,credits,role,status) VALUES($1,0,'admin','active')",[actor]);
  const bind=async(user,o)=>{
    const expiry=new Date(Date.now()+1800000),id=`cs_${o.id}`;
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method:'card',merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',id,expiry]);
    return id;
  };
  const pkg=(await admin.query(`INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,active)
    VALUES('Pack refund fixture',990,990,0,'true') RETURNING id`)).rows[0].id;
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,credit_package_id,
    billing_cycle,is_current,package_tier,price_usage) VALUES('stripe','fixture','test','price',$1,$2,'one_time',true,'gold','package')`,
    [`price_pack_refund_${pkg}`,pkg]);
  // A Gold member who bought an international card pack (8.90 member price + 1.88 tax), within 7 days, no credit used since.
  const buyer=async digest=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const m=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card','gold_first30',
      'fixture','test',$3,'terms-v1',$4) o`,[user,plan,version,JSON.stringify([{kind:'email',key_version:'test-v1',digest}])])).rows[0];
    const start=new Date(Math.floor(Date.now()/1000)*1000-120000),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[m.id,new Date(start.getTime()-60000)]);
    assert.equal((await service.query('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[m.id,'fixture',await bind(user,m),
      `in_${m.id}`,m.amount_total,'usd',new Date(start.getTime()+6000),`sub_${m.id}`,start,end])).rows[0].v.state,'fulfilled');
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'credit_package',$2,'one_time','card','standard','fixture',
      'test',$3,'terms-v1',NULL) o`,[user,pkg,version])).rows[0];
    const paidAt=new Date(Date.now()-60000);
    assert.equal((await service.query(`SELECT pay_waffo_fulfill_payment($1,'fixture',$2,$3,$4,'usd',$5,NULL,NULL,NULL) v`,
      [o.id,await bind(user,o),`pi_${o.id}`,o.amount_total,paidAt])).rows[0].v.state,'fulfilled');
    await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,188)`,[o.id,`pi_${o.id}`]);
    const ticket=(await admin.query("INSERT INTO tickets(user_id,title,category) VALUES($1,'refund','billing') RETURNING id",[user])).rows[0].id;
    const cash={orderId:o.id,merchant:'fixture',mode:'test',currency:'usd',paymentIntentId:`pi_${o.id}`,chargeId:`ch_${o.id}`,
      paidMinor:o.amount_total,taxMinor:188,paidAt:paidAt.toISOString(),refundedMinor:0,refundCount:0,disputed:false};
    return {user,o,ticket,cash};
  };
  const quote=(f,fee='confirmed',cash=f.cash)=>service.query(`SELECT pay_common_package_refund_quote($1,$2,$3,$4,$5,'legal:us-ca:2026-10') q`,
    [actor,f.o.id,f.ticket,cash,fee]);

  const f=await buyer('d1'.repeat(32));
  assert.equal(f.o.amount_total,890);
  // Refund = pre-tax 890 - floor(890 x 6%) (= 53) + tax 188; the whole pack (990) is taken back.
  const q=(await quote(f)).rows[0].q;
  assert.deepEqual([q.basisMinor,q.feeMinor,q.taxMinor,q.netMinor,q.credits],[890,53,188,1025,990]);
  // Where the law forbids the fee: pre-tax + tax in full.
  assert.deepEqual([(await quote(f,'not_permitted')).rows[0].q.netMinor],[1078]);
  // The Stripe evidence must carry exactly the recorded tax.
  await assert.rejects(()=>quote(f,'confirmed',{...f.cash,taxMinor:0}),/CASH_EVIDENCE_INVALID/);
  await assert.rejects(()=>quote(f,'confirmed',{...f.cash,taxMinor:200}),/CASH_EVIDENCE_INVALID/);
  // Approve, claim (the pack's credits are reserved), Stripe result: partial refund because of the fee.
  const intent=(await service.query(`SELECT pay_common_package_refund_decide($1,$2,$3,$4,'confirmed','legal:us-ca:2026-10',$5,'approve') q`,
    [actor,f.o.id,f.ticket,f.cash,q.versionHash])).rows[0].q;
  const before=(await admin.query('SELECT credits FROM profiles WHERE id=$1',[f.user])).rows[0].credits;
  await service.query('SELECT pay_common_package_refund_claim($1,$2,$3,$4)',[actor,f.o.id,intent.id,f.cash]);
  assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[f.user])).rows[0].credits,before-990);
  const res=refund=>service.query('SELECT pay_common_package_refund_result($1,$2,$3) q',[f.o.id,intent.id,{id:`re_${intent.id}`,
    intentId:intent.id,orderId:f.o.id,paymentIntentId:f.cash.paymentIntentId,chargeId:f.cash.chargeId,currency:'usd',
    amount:1025,mode:'test',merchant:'fixture',status:'succeeded',...refund}]);
  await assert.rejects(()=>res({amount:1078}),/RESULT_MISMATCH/,'the refund amount must be the approved one');
  assert.equal((await res({})).rows[0].q.status,'succeeded');
  assert.equal((await admin.query('SELECT status FROM payment_orders WHERE id=$1',[f.o.id])).rows[0].status,'partially_refunded');
  // No fee: the whole charge (pre-tax + tax) comes back, so the order is fully refunded.
  const g=await buyer('d2'.repeat(32));
  const gq=(await quote(g,'not_permitted')).rows[0].q;
  const gi=(await service.query(`SELECT pay_common_package_refund_decide($1,$2,$3,$4,'not_permitted','legal:us-ca:2026-10',$5,'approve') q`,
    [actor,g.o.id,g.ticket,g.cash,gq.versionHash])).rows[0].q;
  await service.query('SELECT pay_common_package_refund_claim($1,$2,$3,$4)',[actor,g.o.id,gi.id,g.cash]);
  await service.query('SELECT pay_common_package_refund_result($1,$2,$3)',[g.o.id,gi.id,{id:`re_${gi.id}`,intentId:gi.id,orderId:g.o.id,
    paymentIntentId:g.cash.paymentIntentId,chargeId:g.cash.chargeId,currency:'usd',amount:1078,mode:'test',merchant:'fixture',status:'succeeded'}]);
  assert.equal((await admin.query('SELECT status FROM payment_orders WHERE id=$1',[g.o.id])).rows[0].status,'refunded');
  // Any credit used since the payment: not eligible (record AA).
  const h=await buyer('d3'.repeat(32));
  await admin.query(`INSERT INTO credit_transactions(idempotency_key,user_id,amount,type,description,ledger_type,counts_as_spend,balance_before,balance_after)
    VALUES('fixture:'||gen_random_uuid(),$1,-10,'deduction','spend','spend',true,1000,990)`,[h.user]);
  await assert.rejects(()=>quote(h),/PAY_REFUND_CREDITS_CONSUMED/);
  // A non-admin cannot quote.
  await assert.rejects(()=>service.query(`SELECT pay_common_package_refund_quote($1,$2,$3,$4,'confirmed','x') q`,
    [f.user,f.o.id,f.ticket,f.cash]),/ADMIN_REQUIRED/);

  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['stripe-mp-pack-refund-net-with-tax','stripe-mp-pack-refund-no-fee','stripe-mp-pack-refund-tax-evidence',
    'stripe-mp-pack-refund-claim-result','stripe-mp-pack-refund-full','stripe-mp-pack-refund-consumption','stripe-mp-pack-refund-admin'];
}
