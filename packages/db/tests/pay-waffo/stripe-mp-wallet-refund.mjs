/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** R7 PR-B3 (0298): our approved refund of a wallet one-time membership (WeChat Pay / Alipay), through the pack refund
 * path, in the order's mode (live here). Runs after the live cases, which created the live catalog. */
export async function stripeMpWalletRefundCases({admin,service}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",[{...current,version,
    card:{enabled:true},card_cn:{enabled:true},wechat_pay:{enabled:true,annualVerified:true},alipay:{enabled:true,annualVerified:true}}]);
  // Wallet Gold yearly at the standard price (one-time), in both modes.
  for(const mode of ['test','live']) await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,
    external_id,membership_plan_id,billing_cycle,is_current,offer_kind,price_usage) VALUES('stripe','fixture',$1,'price',$2,$3,'yearly',
    true,'standard','one_time') ON CONFLICT DO NOTHING`,[mode,`price_wallet_gold_year_${mode}`,plan]);
  const actor=randomUUID();
  await admin.query("INSERT INTO profiles(id,credits,role,status) VALUES($1,0,'admin','active')",[actor]);
  const one=async(sql,args)=>(await service.query(sql,args)).rows[0];
  const profile=async user=>(await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[user])).rows[0];
  const facts=async user=>(await one('SELECT pay_common_membership_facts($1) v',[user])).v.internal_membership;

  // A live Gold year paid by WeChat Pay a day ago (one-time: the term starts at payment); month 1 credits granted.
  const buyer=async digest=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const o=(await one(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'yearly','wechat_pay','standard',
      'fixture','live',$3,'terms-v1',$4) o`,[user,plan,version,JSON.stringify([{kind:'email',key_version:'test-v1',digest}])]));
    assert.deepEqual([o.payment_mode,o.auto_renew],['live',false]);
    const paidAt=new Date(Math.floor(Date.now()/1000)*1000-86400000),end=new Date(paidAt);end.setUTCFullYear(end.getUTCFullYear()+1);
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,new Date(paidAt.getTime()-60000)]);
    const expiry=new Date(Date.now()+1800000);
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method:'wechat_pay',merchant:'fixture',mode:'live',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',`cs_${o.id}`,expiry]);
    const v=(await one('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9) v',[o.id,'fixture',`cs_${o.id}`,`pi_${o.id}`,
      o.amount_total,'usd',paidAt,paidAt,end])).v;
    assert.equal(v.state,'fulfilled',JSON.stringify(v));
    const ticket=(await admin.query("INSERT INTO tickets(user_id,title,category) VALUES($1,'refund','billing') RETURNING id",[user])).rows[0].id;
    const cash={orderId:o.id,merchant:'fixture',mode:'live',currency:'usd',paymentIntentId:`pi_${o.id}`,chargeId:`ch_${o.id}`,
      paidMinor:o.amount_total,taxMinor:0,paidAt:paidAt.toISOString(),refundedMinor:0,refundCount:0,disputed:false};
    const sub=(await admin.query('SELECT subscription_id FROM payment_orders WHERE id=$1',[o.id])).rows[0].subscription_id;
    return {user,o,ticket,cash,sub,granted:v.credits};
  };
  const quote=(f,fee='confirmed',cash=f.cash)=>one(`SELECT pay_common_package_refund_quote($1,$2,$3,$4,$5,'legal:us-ca:2026-10') q`,
    [actor,f.o.id,f.ticket,cash,fee]);
  const approveAndClaim=async(f,fee='confirmed')=>{
    const q=(await quote(f,fee)).q;
    const i=(await one(`SELECT pay_common_package_refund_decide($1,$2,$3,$4,$5,'legal:us-ca:2026-10',$6,'approve') q`,
      [actor,f.o.id,f.ticket,f.cash,fee,q.versionHash])).q;
    await service.query('SELECT pay_common_package_refund_claim($1,$2,$3,$4)',[actor,f.o.id,i.id,f.cash]);
    return {q,i};
  };
  const result=(f,i,amount,status='succeeded')=>one('SELECT pay_common_package_refund_result($1,$2,$3) q',[f.o.id,i.id,{
    id:`re_${i.id}`,intentId:i.id,orderId:f.o.id,paymentIntentId:f.cash.paymentIntentId,chargeId:f.cash.chargeId,currency:'usd',
    amount,mode:'live',merchant:'fixture',status}]);
  // Test-only time travel past the frozen-field guard: the order's second month falls due now.
  const shiftMonth=async f=>{
    await admin.query('BEGIN'); await admin.query('SET LOCAL session_replication_role=replica');
    await admin.query(`UPDATE payment_orders SET entitlement_start=entitlement_start-interval '1 month',
      entitlement_end=entitlement_end-interval '1 month' WHERE id=$1`,[f.o.id]);
    await admin.query('COMMIT');
  };

  // Successful refund: the 6% fee kept (partial), the granted month taken back, the membership ends, no further release.
  const f=await buyer('a1'.repeat(32));
  assert.ok(f.granted>0);
  assert.equal((await profile(f.user)).membership_level,'gold');
  await assert.rejects(()=>quote(f,'confirmed',{...f.cash,mode:'test'}),/CASH_EVIDENCE_INVALID/);
  const {q,i}=await approveAndClaim(f);
  assert.deepEqual([q.treatment,q.credits,q.basisMinor,q.feeMinor,q.netMinor],
    ['wallet_membership',f.granted,f.o.amount_total,Math.floor(f.o.amount_total*6/100),f.o.amount_total-Math.floor(f.o.amount_total*6/100)]);
  assert.equal((await profile(f.user)).credits,0,'the granted credits are reserved before the cash refund');
  await shiftMonth(f);
  assert.equal((await one('SELECT pay_waffo_grant_period($1,2) n',[f.o.id])).n,0,'nothing is released while the refund runs');
  await result(f,i,q.netMinor);
  assert.equal((await admin.query('SELECT status FROM payment_orders WHERE id=$1',[f.o.id])).rows[0].status,'partially_refunded');
  const sub=(await admin.query('SELECT status,credit_release_terminated_reason FROM user_subscriptions WHERE id=$1',[f.sub])).rows[0];
  assert.deepEqual(sub,{status:'canceled',credit_release_terminated_reason:'approved_wallet_refund'});
  const grants=async o=>(await admin.query('SELECT array_agg(DISTINCT status) s FROM subscription_credit_grants WHERE source_order_id=$1',
    [o.id])).rows[0].s;
  assert.deepEqual(await grants(f.o),['reversed'],'the taken-back grants are reversed, never left to quarantine later credits');
  assert.notEqual((await facts(f.user)).mapping_state,'internal_paid','no membership after the refund');
  assert.deepEqual(await profile(f.user),{credits:0,membership_level:'free'});
  await service.query('SELECT pay_waffo_release_due(500)');
  assert.equal((await profile(f.user)).credits,0,'released months stay stopped');
  assert.deepEqual((await admin.query("SELECT mode FROM payment_provider_refs WHERE external_id=$1",[`re_${i.id}`])).rows,[{mode:'live'}]);

  // Without the fee the whole payment comes back: fully refunded.
  const g=await buyer('a2'.repeat(32));
  const gi=await approveAndClaim(g,'not_permitted');
  assert.equal(gi.q.netMinor,g.o.amount_total);
  await result(g,gi.i,gi.q.netMinor);
  assert.equal((await admin.query('SELECT status FROM payment_orders WHERE id=$1',[g.o.id])).rows[0].status,'refunded');

  // A failed refund restores the credits and the membership; monthly release resumes.
  const h=await buyer('a3'.repeat(32));
  const hi=await approveAndClaim(h);
  await result(h,hi.i,hi.q.netMinor,'failed');
  assert.deepEqual(await profile(h.user),{credits:h.granted,membership_level:'gold'});
  assert.equal((await facts(h.user)).mapping_state,'internal_paid');
  assert.deepEqual(await grants(h.o),['granted'],'a failed refund leaves the grants as they were');
  await shiftMonth(h);
  assert.ok((await one('SELECT pay_waffo_grant_period($1,2) n',[h.o.id])).n>0,'release resumes after a failed refund');

  // Any credit used since the payment: not refundable (record AA). The admin can reject a wallet membership request.
  const k=await buyer('a4'.repeat(32));
  await admin.query(`INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,counts_as_spend,balance_before,balance_after)
    VALUES($1,-10,'deduction','spend','spend',true,$2::integer,$2::integer-10)`,[k.user,k.granted]);
  await assert.rejects(()=>quote(k),/CONSUMPTION_OR_UNKNOWN/);
  assert.equal((await one(`SELECT pay_common_package_refund_reject($1,$2,$3,'ineligible') q`,[actor,k.o.id,k.ticket])).q.status,'rejected');

  // A refund made outside our flow (Stripe Dashboard): a partial one is only recorded for review; the full one reverses
  // the grants, takes back what they still hold, ends the subscription and the membership.
  const ext=await buyer('a5'.repeat(32));
  const external=(amount,id)=>one(`SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,$3,$4,'usd',now()) v`,
    [ext.o.id,ext.cash.paymentIntentId,id,amount]);
  const partial=(await external(1000,'re_dash_part')).v;
  assert.deepEqual([partial.state,partial.duplicate],['partial_review',false]);
  assert.equal((await facts(ext.user)).mapping_state,'internal_paid','a partial external refund leaves the membership for review');
  const full=(await external(ext.o.amount_total-1000,'re_dash_rest')).v;
  assert.equal(full.state,'refunded',JSON.stringify(full));
  assert.equal(full.creditsTakenBack,ext.granted);
  assert.deepEqual(await profile(ext.user),{credits:0,membership_level:'free'});
  assert.deepEqual(await grants(ext.o),['reversed']);
  assert.deepEqual((await admin.query('SELECT status,credit_release_terminated_reason r FROM user_subscriptions WHERE id=$1',[ext.sub])).rows[0],
    {status:'canceled',r:'external_wallet_refund'});
  assert.equal((await external(ext.o.amount_total-1000,'re_dash_rest')).v.duplicate,true,'a replay records nothing twice');
  assert.deepEqual((await admin.query("SELECT mode FROM payment_provider_refs WHERE external_id='re_dash_rest'")).rows,[{mode:'live'}]);

  // An auto-renewing card membership keeps its own refund path (subscription refund), never this one.
  const card=(await admin.query(`SELECT id,user_id FROM payment_orders WHERE item_type='membership_plan' AND payment_method='card'
    AND auto_renew AND fulfilled_at IS NOT NULL LIMIT 1`)).rows[0];
  const cardTicket=(await admin.query("INSERT INTO tickets(user_id,title,category) VALUES($1,'refund','billing') RETURNING id",
    [card.user_id])).rows[0].id;
  await assert.rejects(()=>one(`SELECT pay_common_package_refund_quote($1,$2,$3,$4,'confirmed','x') q`,[actor,card.id,cardTicket,{}]),
    /TYPE_NOT_IMPLEMENTED/);

  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['wallet-refund-live-cash-mode','wallet-refund-takes-granted-credits','wallet-refund-pauses-release',
    'wallet-refund-ends-membership','wallet-refund-no-fee-full','wallet-refund-failure-restores','wallet-refund-consumption',
    'wallet-refund-reject','wallet-external-refund-partial-then-full','card-subscription-not-this-path'];
}
