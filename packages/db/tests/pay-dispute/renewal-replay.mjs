/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REL-1 core 6③: a previous period's dispute and the next period's renewal at the same time, with Stripe's usual
// replays (the same renewal invoice and dispute events delivered again), then the dispute won and withdrawn.
// Freeze once, never deliver a renewal twice, and leave the right balance and membership after the withdrawal.
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
export async function renewalReplayCases({c,v,receive,withdraw,ops,report,member,facts,start,nextEnd}) {
 const priorStart=new Date(start);priorStart.setUTCMonth(priorStart.getUTCMonth()-1);
 const credits=user=>v('SELECT credits v FROM profiles WHERE id=$1',[user]);
 const freezes=order=>v(`SELECT count(*)::int v FROM credit_transactions WHERE source_order_id=$1 AND reason_code='dispute_freeze'`,[order]);
 const disputes=order=>v('SELECT count(*)::int v FROM payment_disputes WHERE order_id=$1',[order]);
 const renewals=m=>v('SELECT count(*)::int v FROM payment_orders WHERE user_id=$1 AND id<>$2',[m.user,m.order]);
 const grants=order=>v('SELECT coalesce(sum(credits_granted),0)::int v FROM subscription_credit_grants WHERE source_order_id=$1',[order]);
 const renew=(m,tag)=>v('SELECT pay_dispute_renew($1) v',[{subscription:m.sub,subscriptionId:m.providerSub,merchant:'fixture',mode:'test',
  invoiceId:`in_${tag}_`+m.sub.replaceAll('-',''),paymentIntentId:`pi_${tag}_`+m.sub.replaceAll('-',''),
  amount:1000,currency:'usd',paidAt:start,start,end:nextEnd}]);
 const event=()=>'evt_'+randomUUID().replaceAll('-','');

 // A: the dispute lands first; the renewal arrives during the freeze and is replayed.
 {
  const m=await member(priorStart,start),before=await credits(m.user);
  const opened=event();
  const d=await receive(m,{id:opened,subscriptionId:m.providerSub});
  assert.equal(d.freeze_state,'frozen');
  assert.equal((await receive(m,{id:opened,subscriptionId:m.providerSub})).duplicate,true);
  await receive(m,{id:event(),type:'charge.dispute.updated',status:'under_review',subscriptionId:m.providerSub});
  assert.equal(await disputes(m.order),1);assert.equal(await freezes(m.order),1,'one freeze despite replayed events');
  assert.equal(await credits(m.user),before-100);
  const first=await renew(m,'a'),again=await renew(m,'a');
  assert.equal(first.state,'review');assert.equal(first.disputeRefundRequired,true);
  assert.equal(again.orderId,first.orderId,'a replayed renewal invoice maps to the same order');
  assert.equal(await renewals(m),1);assert.equal(await grants(first.orderId),0,'a renewal held for refund grants nothing');
  assert.equal(await credits(m.user),before-100);
  const won=await receive(m,{id:event(),type:'charge.dispute.closed',status:'won',subscriptionId:m.providerSub});
  assert.equal(won.freeze_state,'frozen','winning alone never releases the hold; an operator withdraws it');
  assert.equal((await withdraw(ops,d)).restored,100);
  assert.equal((await withdraw(ops,d)).duplicate,true);
  await receive(m,{id:event(),type:'charge.dispute.updated',status:'won',subscriptionId:m.providerSub});
  assert.equal(await credits(m.user),before,'withdrawal restores exactly the frozen period, once');
  assert.equal(await freezes(m.order),1);
  assert.notEqual(await v('SELECT dispute_refund_status v FROM payment_orders WHERE id=$1',[first.orderId]),null,
   'the renewal paid during the freeze stays on the full-refund path after the withdrawal');
  assert.equal(await renewals(m),1);assert.equal(await grants(first.orderId),0);
 }
 report.checks.push('REL-1 6③ dispute-first: replayed dispute events freeze once; replayed renewal maps to one order and grants nothing; won + withdrawal restores the frozen period once and keeps the renewal on its refund path');

 // B: the renewal is delivered first; the previous period is disputed; everything is replayed; won and withdrawn.
 {
  const m=await member(priorStart,start);
  const first=await renew(m,'b');
  assert.equal(first.state,'fulfilled');
  const delivered=await credits(m.user);
  const again=await renew(m,'b');
  assert.equal(again.orderId,first.orderId);assert.equal(await renewals(m),1);
  assert.equal(await credits(m.user),delivered,'a replayed renewal never grants a second period');
  const opened=event();
  const d=await receive(m,{id:opened,subscriptionId:m.providerSub});
  await receive(m,{id:opened,subscriptionId:m.providerSub});
  await receive(m,{id:event(),type:'charge.dispute.updated',status:'under_review',subscriptionId:m.providerSub});
  assert.equal(await disputes(m.order),1);assert.equal(await freezes(m.order),1);
  assert.equal(await freezes(first.orderId),0,'the separately paid next period is not frozen');
  assert.equal(await credits(m.user),delivered-100);
  assert.equal((await facts(m.user)).internal_membership.membership_level,'pro');
  await receive(m,{id:event(),type:'charge.dispute.closed',status:'won',subscriptionId:m.providerSub});
  assert.equal((await withdraw(ops,d)).restored,100);
  assert.equal(await credits(m.user),delivered);
  assert.equal(await renew(m,'b').then(r=>r.orderId),first.orderId);
  assert.equal(await credits(m.user),delivered,'a renewal replayed after the withdrawal still grants nothing more');
  assert.equal((await facts(m.user)).internal_membership.membership_level,'pro');
  assert.equal(await v('SELECT membership_level v FROM profiles WHERE id=$1',[m.user]),'pro');
 }
 report.checks.push('REL-1 6③ renewal-first: replayed renewal grants one period; prior-period dispute freezes only its own period once; won + withdrawal restores it and keeps pro');
}
