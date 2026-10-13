/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** PAY-STRIPE-MP step 4b-2 (0253): our approved monthly first-purchase refund of a card subscription. */
export async function stripeMpSubscriptionRefundCases({admin,service}) {
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const current=(await admin.query("SELECT value FROM system_settings WHERE key='payment_method_routes'")).rows[0].value;
  const version=current.version+1;
  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:true},card_cn:{enabled:true},version}]);
  const actor=randomUUID();
  await admin.query("INSERT INTO profiles(id,credits,role,status) VALUES($1,0,'admin','active')",[actor]);
  const one=async(sql,args)=>(await service.query(sql,args)).rows[0];
  // A Gold first month bought by card (international: 49.00 + 9.80 tax; mainland: no tax), a day ago, nothing used.
  const buyer=async(digest,method='card',tax=980)=>{
    const user=randomUUID(); await admin.query('INSERT INTO profiles(id,credits) VALUES($1,0)',[user]);
    const o=(await service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,'monthly',$3,'gold_first30',
      'fixture','test',$4,'terms-v1',$5) o`,[user,plan,method,version,JSON.stringify([{kind:'email',key_version:'test-v1',digest}])])).rows[0];
    const start=new Date(Math.floor(Date.now()/1000)*1000-86400000),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
    await admin.query('UPDATE payment_orders SET created_at=$2 WHERE id=$1',[o.id,new Date(start.getTime()-60000)]);
    const expiry=new Date(Date.now()+1800000);
    await service.query('SELECT pay_waffo_claim_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',
      {orderId:o.id,userId:user,method,merchant:'fixture',mode:'test',providerRequest:{fixture:true}},expiry]);
    await service.query('SELECT pay_waffo_bind_checkout($1,$2,$3,$4,$5)',[user,o.id,'fixture',`cs_${o.id}`,expiry]);
    const paidAt=new Date(start.getTime()+6000);
    assert.equal((await one('SELECT pay_waffo_fulfill_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[o.id,'fixture',`cs_${o.id}`,
      `in_${o.id}`,o.amount_total,'usd',paidAt,`sub_${o.id}`,start,end])).v.state,'fulfilled');
    if(method==='card' && tax!==null) await service.query(`SELECT pay_stripe_mp_record_tax($1,'fixture',$2,$3)`,[o.id,`in_${o.id}`,tax]);
    const row=(await admin.query('SELECT * FROM payment_orders WHERE id=$1',[o.id])).rows[0];
    const sub=(await admin.query('SELECT * FROM user_subscriptions WHERE id=$1',[row.subscription_id])).rows[0];
    const ticket=(await admin.query("INSERT INTO tickets(user_id,title,category) VALUES($1,'refund','billing') RETURNING id,created_at",[user])).rows[0];
    const credits=Number(row.purchase_snapshot.credits)+Number(row.purchase_snapshot.bonus_credits);
    const fee=Math.floor(row.amount_total*6/100);
    // What the server quotes (monthlyRefundService): card orders carry taxMinor; the fee is on the pre-tax amount.
    const terms={kind:'monthly_first_purchase',orderId:o.id,userId:user,ticketId:ticket.id,subscriptionId:sub.id,
      providerSubscriptionId:`sub_${o.id}`,paymentIntentId:`pi_${o.id}`,chargeId:`ch_${o.id}`,invoiceId:`in_${o.id}`,
      merchant:'fixture',mode:'test',currency:'usd',plan:'gold',paidAt:paidAt.toISOString(),submittedAt:ticket.created_at.toISOString(),
      periodEnd:sub.current_period_end.toISOString(),originalCancelAtPeriodEnd:false,paidMinor:row.amount_total,
      basisMinor:row.amount_total,feeMinor:fee,taxMinor:method==='card'?tax:0,netMinor:row.amount_total-fee+(method==='card'?tax:0),
      credits,feePermitted:'confirmed',feeEvidence:'legal:us-ca:2026-10',evidenceRefs:['a','b','c','d'],snapshot:row.purchase_snapshot};
    return {user,order:o.id,sub:sub.id,terms,credits};
  };
  const approve=async(f,terms=f.terms)=>{
    const local=(await one('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4) q',[actor,f.order,terms,'a'.repeat(64)])).q.localVersion;
    return (await one('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4,$5) i',[actor,f.order,terms,'a'.repeat(64),local])).i;
  };
  const seen=(f,patch={})=>({checkedAt:new Date().toISOString(),merchant:'fixture',mode:'test',
    subscription:{id:f.terms.providerSubscriptionId,periodEnd:f.terms.periodEnd,status:'active',cancelAtPeriodEnd:true,
      renewalOwnership:'intent',preflight:'clear',...patch},refunds:{complete:true,rows:[]}});
  const start=async(f,i,stage,e=seen(f))=>(await one('SELECT pay_common_monthly_refund_start($1,$2,$3,$4,$5,$6) i',
    [actor,f.order,i.id,i.revision,stage,e])).i;
  const fact=(f,i,amount=f.terms.netMinor,status='succeeded')=>({id:`re_${f.order}`,intentId:i.id,orderId:f.order,
    chargeId:f.terms.chargeId,paymentIntentId:f.terms.paymentIntentId,currency:'usd',amount,merchant:'fixture',mode:'test',status});
  const result=async(f,i,r)=>(await one('SELECT pay_common_monthly_refund_result($1,$2,$3) i',[f.order,i.id,r])).i;
  const finish=async(f,i,e)=>(await one('SELECT pay_common_monthly_refund_finish($1,$2,$3,$4) i',[actor,f.order,i.id,e])).i;
  const order=async f=>(await admin.query('SELECT status,refund_approval FROM payment_orders WHERE id=$1',[f.order])).rows[0];

  // The approved refund of an international card subscription: stop renewal, refund, cancel at once.
  const f=await buyer('e1'.repeat(32));
  assert.deepEqual([f.terms.paidMinor,f.terms.feeMinor,f.terms.taxMinor,f.terms.netMinor],[4900,294,980,5586]);
  // The terms must carry exactly the recorded tax and its refund; legacy terms (no tax) are refused for a card order.
  for(const bad of [{...f.terms,taxMinor:0,netMinor:4606},{...f.terms,netMinor:4606},(({taxMinor,...t})=>({...t,netMinor:4606}))(f.terms)]) {
    await assert.rejects(()=>approve(f,bad),/PAY_MONTHLY_(CASH|AMOUNT)/);
  }
  let i=await approve(f);
  assert.equal((await approve(f)).id,i.id,'approving again returns the same intent');
  i=(await one('SELECT pay_common_monthly_refund_claim($1,$2,$3,$4) i',[actor,f.order,i.id,f.terms])).i;
  assert.equal(i.hold,'held');
  assert.deepEqual((await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[f.user])).rows[0],
    {credits:0,membership_level:'free'},'the whole first month is taken back while the refund runs');
  // The card subscription sync is held off while the refund runs (the webhook leaves it to the refund flow).
  await assert.rejects(()=>service.query(`SELECT pay_stripe_mp_sync_subscription($1,'fixture',true,false,false)`,[f.sub]),/SOURCE_HELD/);
  i=await start(f,i,'stop_renewal',seen(f,{cancelAtPeriodEnd:false,renewalOwnership:'original'}));
  i=await start(f,i,'refund');
  await assert.rejects(()=>result(f,i,fact(f,i,4606)),/RESULT_MISMATCH/,'the refund must add the tax');
  i=await result(f,i,fact(f,i));
  assert.equal((await order(f)).status,'partially_refunded','the fee was kept');
  i=await start(f,i,'cancel');
  const done=seen(f,{status:'canceled'});done.refunds.rows=[fact(f,i)];
  i=await finish(f,i,done);
  assert.equal(i.status,'succeeded');
  assert.equal((await finish(f,i,done)).status,'succeeded','finishing again changes nothing');
  const sub=(await admin.query('SELECT status,credit_release_terminated_reason FROM user_subscriptions WHERE id=$1',[f.sub])).rows[0];
  assert.deepEqual(sub,{status:'canceled',credit_release_terminated_reason:'approved_monthly_refund'});
  // A finished card refund (with its tax) is financial proof for account erasure; tampered tax is not.
  const proof=(await order(f)).refund_approval;
  assert.equal((await admin.query('SELECT monthly_refund_erasure_safe($1) ok',[proof])).rows[0].ok,true);
  assert.equal((await admin.query('SELECT monthly_refund_erasure_safe($1) ok',
    [{...proof,terms:{...proof.terms,taxMinor:-1}}])).rows[0].ok,false);

  // No fee where the law forbids it: the whole charge comes back and the order is fully refunded.
  const g=await buyer('e2'.repeat(32));
  g.terms={...g.terms,feePermitted:'not_permitted',feeMinor:0,netMinor:5880};
  let gi=await approve(g);
  gi=(await one('SELECT pay_common_monthly_refund_claim($1,$2,$3,$4) i',[actor,g.order,gi.id,g.terms])).i;
  gi=await start(g,gi,'stop_renewal',seen(g,{cancelAtPeriodEnd:false,renewalOwnership:'original'}));
  gi=await start(g,gi,'refund');
  await result(g,gi,fact(g,gi));
  assert.equal((await order(g)).status,'refunded');

  // A failed refund restores the credits, the level and renewal.
  const h=await buyer('e3'.repeat(32));
  let hi=await approve(h);
  hi=(await one('SELECT pay_common_monthly_refund_claim($1,$2,$3,$4) i',[actor,h.order,hi.id,h.terms])).i;
  hi=await start(h,hi,'stop_renewal',seen(h,{cancelAtPeriodEnd:false,renewalOwnership:'original'}));
  hi=await start(h,hi,'refund');
  hi=await result(h,hi,fact(h,hi,h.terms.netMinor,'failed'));
  hi=await start(h,hi,'restore_renewal',{...seen(h),refunds:{complete:true,rows:[fact(h,hi,h.terms.netMinor,'failed')]}});
  const restored={...seen(h,{cancelAtPeriodEnd:false}),refunds:{complete:true,rows:[fact(h,hi,h.terms.netMinor,'failed')]}};
  hi=await finish(h,hi,restored);
  assert.equal(hi.status,'failed');
  assert.deepEqual((await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[h.user])).rows[0],
    {credits:h.credits,membership_level:'gold'});

  // A mainland card carries no tax (taxMinor 0); the tax fact is required for an international card.
  const m=await buyer('e4'.repeat(32),'card_cn');
  assert.equal((await approve(m)).status,'approved');
  await assert.rejects(async()=>{ const n=await buyer('e5'.repeat(32),'card',null); await approve({...n,terms:{...n.terms,taxMinor:980}}); },
    /TAX_PENDING/);
  // An abandoned card checkout does not count as membership history.
  const p=await buyer('e6'.repeat(32));
  await admin.query(`INSERT INTO payment_orders(user_id,item_type,item_id,billing_cycle,status,payment_status,amount_total,currency,
    payment_channel,payment_mode,merchant_namespace,payment_method,purchase_snapshot)
    SELECT user_id,item_type,item_id,billing_cycle,'expired','unpaid',amount_total,currency,payment_channel,payment_mode,
    merchant_namespace,payment_method,purchase_snapshot FROM payment_orders WHERE id=$1`,[p.order]);
  assert.equal((await approve(p)).status,'approved');
  // Used credits since the payment: refused (record AA). A non-admin cannot approve.
  const q=await buyer('e7'.repeat(32));
  await admin.query(`INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,counts_as_spend,balance_before,balance_after)
    VALUES($1,-10,'deduction','spend','spend',true,1000,990)`,[q.user]);
  await assert.rejects(()=>approve(q),/CONSUMPTION_OR_UNKNOWN/);
  await assert.rejects(()=>service.query('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4)',[q.user,q.order,q.terms,'a'.repeat(64)]),
    /ADMIN_REQUIRED/);

  await admin.query("UPDATE system_settings SET value=$1 WHERE key='payment_method_routes'",
    [{...current,card:{enabled:false},card_cn:{enabled:false},version:version+1}]);
  return ['stripe-mp-subscription-refund-tax-terms','stripe-mp-subscription-refund-held','stripe-mp-subscription-refund-cancel',
    'stripe-mp-subscription-refund-erasure-proof','stripe-mp-subscription-refund-no-fee','stripe-mp-subscription-refund-restore',
    'stripe-mp-subscription-refund-mainland','stripe-mp-subscription-refund-abandoned','stripe-mp-subscription-refund-consumption'];
}
