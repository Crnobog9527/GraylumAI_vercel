/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {addUtcMonths} from '../utc-months.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** R7 PR-B2 (0297): refunds of live Stripe orders run in live mode end to end; a test-mode answer is refused.
 * Runs after stripeMpLiveCases, which created the live catalog (prices, coupon and the member pack price). */
export async function stripeMpLiveRefundCases({admin,service}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const pkg=(await admin.query("SELECT id FROM credit_packages WHERE name='Pack refund fixture'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const actor=randomUUID();
  await admin.query("INSERT INTO profiles(id,credits,role,status) VALUES($1,0,'admin','active')",[actor]);
  const one=async(sql,args)=>(await service.query(sql,args)).rows[0];
  const digests=digest=>JSON.stringify([{kind:'email',key_version:'test-v1',digest}]);
  const pay=async(user,o,{payment=`in_${o.id}`,subscription=null,start=null,end=null,paidAt})=>{
    const expiry=new Date(Date.now()+1800000);
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method:'card',merchant:'fixture',mode:'live',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',`cs_${o.id}`,expiry]);
    const v=(await one('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[o.id,'fixture',`cs_${o.id}`,payment,
      o.amount_total,'usd',paidAt,subscription,start,end])).v;
    assert.equal(v.state,'fulfilled',JSON.stringify(v));
  };
  // A live Gold first month (49.00 + 9.80 tax), paid a day ago, nothing used.
  const member=async digest=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const o=(await one(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly','card','gold_first30',
      'fixture','live',$3,'terms-v1',$4) o`,[user,plan,version,digests(digest)]));
    assert.equal(o.payment_mode,'live');
    const start=new Date(Math.floor(Date.now()/1000)*1000-86400000),end=addUtcMonths(start,1);
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,new Date(start.getTime()-60000)]);
    const paidAt=new Date(start.getTime()+6000);
    await pay(user,o,{subscription:`sub_${o.id}`,start,end,paidAt});
    await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,980)`,[o.id,`in_${o.id}`]);
    return {user,o,paidAt};
  };

  // External refund (Stripe dashboard / dispute flow): recorded against the live payment, as a live reference.
  const ext=await member('f1'.repeat(32));
  const external=(await one(`SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,'re_live_ext',100,'usd',now()) v`,
    [ext.o.id,`in_${ext.o.id}`])).v;
  assert.ok(external,'recorded');
  assert.deepEqual((await admin.query("SELECT mode FROM payment_provider_refs WHERE external_id='re_live_ext'")).rows,[{mode:'live'}]);

  // Monthly first-purchase refund of a live card subscription: terms carry 'live'; every step stays live.
  const m=await member('f2'.repeat(32));
  const row=(await admin.query('SELECT * FROM payment_orders WHERE id=$1',[m.o.id])).rows[0];
  const sub=(await admin.query('SELECT * FROM user_subscriptions WHERE id=$1',[row.subscription_id])).rows[0];
  const ticket=(await admin.query("INSERT INTO tickets(user_id,title,category) VALUES($1,'refund','billing') RETURNING id,created_at::text AS created_at",
    [m.user])).rows[0];
  const fee=Math.floor(row.amount_total*6/100);
  const terms={kind:'monthly_first_purchase',orderId:m.o.id,userId:m.user,ticketId:ticket.id,subscriptionId:sub.id,
    providerSubscriptionId:`sub_${m.o.id}`,paymentIntentId:`pi_${m.o.id}`,chargeId:`ch_${m.o.id}`,invoiceId:`in_${m.o.id}`,
    merchant:'fixture',mode:'live',currency:'usd',plan:'gold',paidAt:m.paidAt.toISOString(),submittedAt:ticket.created_at,
    periodEnd:sub.current_period_end.toISOString(),originalCancelAtPeriodEnd:false,paidMinor:row.amount_total,
    basisMinor:row.amount_total,feeMinor:fee,taxMinor:980,netMinor:row.amount_total-fee+980,
    credits:Number(row.purchase_snapshot.credits)+Number(row.purchase_snapshot.bonus_credits),feePermitted:'confirmed',
    feeEvidence:'legal:us-ca:2026-10',evidenceRefs:['a','b','c','d'],snapshot:row.purchase_snapshot};
  const approve=async(t=terms)=>{
    const local=(await one('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4) q',[actor,m.o.id,t,'a'.repeat(64)])).q.localVersion;
    return (await one('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4,$5) i',[actor,m.o.id,t,'a'.repeat(64),local])).i;
  };
  await assert.rejects(()=>approve({...terms,mode:'test'}),/PAY_MONTHLY_(AMOUNT|SCOPE_OR_STATE)/,'terms in the other mode are refused');
  let i=await approve();
  i=(await one('SELECT pay_common_monthly_refund_claim($1,$2,$3,$4) i',[actor,m.o.id,i.id,terms])).i;
  const seen=(mode='live',patch={})=>({checkedAt:new Date().toISOString(),merchant:'fixture',mode,
    subscription:{id:terms.providerSubscriptionId,periodEnd:terms.periodEnd,status:'active',cancelAtPeriodEnd:true,
      renewalOwnership:'intent',preflight:'clear',...patch},refunds:{complete:true,rows:[]}});
  const start=async(stage,e=seen())=>(await one('SELECT pay_common_monthly_refund_start($1,$2,$3,$4,$5,$6) i',
    [actor,m.o.id,i.id,i.revision,stage,e])).i;
  await assert.rejects(()=>start('stop_renewal',seen('test',{cancelAtPeriodEnd:false,renewalOwnership:'original'})),
    /PAY_MONTHLY_OBSERVATION/,'a test-mode observation cannot drive a live refund');
  i=await start('stop_renewal',seen('live',{cancelAtPeriodEnd:false,renewalOwnership:'original'}));
  i=await start('refund');
  const fact=(mode='live')=>({id:`re_${m.o.id}`,intentId:i.id,orderId:m.o.id,chargeId:terms.chargeId,
    paymentIntentId:terms.paymentIntentId,currency:'usd',amount:terms.netMinor,merchant:'fixture',mode,status:'succeeded'});
  await assert.rejects(()=>one('SELECT pay_common_monthly_refund_result($1,$2,$3) i',[m.o.id,i.id,fact('test')]),/RESULT_MISMATCH/);
  i=(await one('SELECT pay_common_monthly_refund_result($1,$2,$3) i',[m.o.id,i.id,fact()])).i;
  assert.deepEqual((await admin.query("SELECT mode FROM payment_provider_refs WHERE external_id=$1",[`re_${m.o.id}`])).rows,[{mode:'live'}]);
  await assert.rejects(()=>one('SELECT pay_common_monthly_refund_conflict($1,$2,$3) i',[m.o.id,i.id,{id:'ch_x',
    chargeId:terms.chargeId,paymentIntentId:terms.paymentIntentId,currency:'usd',merchant:'fixture',mode:'test',amount:1,status:'unknown'}]),
  /RESULT_MISMATCH/);
  i=await start('cancel');
  const done=seen('live',{status:'canceled',cancelAtPeriodEnd:false});done.refunds.rows=[fact()];
  i=(await one('SELECT pay_common_monthly_refund_finish($1,$2,$3,$4) i',[actor,m.o.id,i.id,done])).i;
  assert.equal(i.status,'succeeded');
  const proof=(await admin.query('SELECT refund_approval FROM payment_orders WHERE id=$1',[m.o.id])).rows[0].refund_approval;
  assert.equal((await admin.query('SELECT monthly_refund_erasure_safe($1) ok',[proof])).rows[0].ok,true,'live proof is erasure-safe');
  assert.equal((await admin.query('SELECT monthly_refund_erasure_safe($1) ok',[{...proof,terms:{...proof.terms,mode:'sandbox'}}]))
    .rows[0].ok,false);

  // Credit-pack refund of a live international card pack (member price + tax): quoted, claimed and recorded in live.
  const p=await member('f3'.repeat(32));
  const pack=(await one(`SELECT o.* FROM pay_waffo_create_purchase($1,'credit_package',$2,'one_time','card','standard','fixture',
    'live',$3,'terms-v1',NULL) o`,[p.user,pkg,version]));
  assert.equal(pack.payment_mode,'live');
  const packPaid=new Date(Date.now()-60000);
  await pay(p.user,pack,{payment:`pi_${pack.id}`,paidAt:packPaid});
  await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,188)`,[pack.id,`pi_${pack.id}`]);
  const packTicket=(await admin.query("INSERT INTO tickets(user_id,title,category) VALUES($1,'refund','billing') RETURNING id",[p.user]))
    .rows[0].id;
  const cash={orderId:pack.id,merchant:'fixture',mode:'live',currency:'usd',paymentIntentId:`pi_${pack.id}`,chargeId:`ch_${pack.id}`,
    paidMinor:pack.amount_total,taxMinor:188,paidAt:packPaid.toISOString(),refundedMinor:0,refundCount:0,disputed:false};
  const quote=(c=cash)=>one(`SELECT pay_common_package_refund_quote($1,$2,$3,$4,'confirmed','legal:us-ca:2026-10') q`,
    [actor,pack.id,packTicket,c]);
  await assert.rejects(()=>quote({...cash,mode:'test'}),/CASH_EVIDENCE_INVALID/,'test-mode cash cannot quote a live pack');
  const q=(await quote()).q;
  const intent=(await one(`SELECT pay_common_package_refund_decide($1,$2,$3,$4,'confirmed','legal:us-ca:2026-10',$5,'approve') q`,
    [actor,pack.id,packTicket,cash,q.versionHash])).q;
  await service.query('SELECT pay_common_package_refund_claim($1,$2,$3,$4)',[actor,pack.id,intent.id,cash]);
  await service.query('SELECT pay_common_package_refund_result($1,$2,$3)',[pack.id,intent.id,{id:`re_${intent.id}`,intentId:intent.id,
    orderId:pack.id,paymentIntentId:cash.paymentIntentId,chargeId:cash.chargeId,currency:'usd',amount:q.netMinor,mode:'live',
    merchant:'fixture',status:'succeeded'}]);
  assert.equal((await admin.query('SELECT status FROM payment_orders WHERE id=$1',[pack.id])).rows[0].status,'partially_refunded');
  assert.deepEqual((await admin.query("SELECT mode FROM payment_provider_refs WHERE external_id=$1",[`re_${intent.id}`])).rows,
    [{mode:'live'}]);

  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['live-external-refund','live-monthly-refund-terms-mode','live-monthly-refund-observation-mode',
    'live-monthly-refund-result-and-conflict-mode','live-monthly-refund-erasure-proof','live-pack-refund-cash-mode',
    'live-pack-refund-result'];
}
