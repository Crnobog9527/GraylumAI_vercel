/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {checkErasureProof} from './erasure-cases.mjs';
export async function runCases({db,Client,connectionString,report}) {
 const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 const fx=async(level='pro')=>(await one('select monthly_test.fixture($1) f',[level])).f;
 const quote=async f=>(await one('select pay_common_monthly_refund_approve($1,$2,$3,$4) q',
  [f.actor,f.order,f.terms,'a'.repeat(64)])).q;
 const approve=async f=>(await one('select pay_common_monthly_refund_approve($1,$2,$3,$4,$5) i',
  [f.actor,f.order,f.terms,'a'.repeat(64),(await quote(f)).localVersion])).i;
 const claim=async(f,i)=>(await one('select pay_common_monthly_refund_claim($1,$2,$3,$4) i',
  [f.actor,f.order,i.id,f.terms])).i;
 const get=async f=>(await one('select refund_approval i from payment_orders where id=$1',[f.order])).i;
 const seen=(f,i)=>({checkedAt:new Date().toISOString(),merchant:'acct_fixture',mode:'test',
  subscription:{id:f.terms.providerSubscriptionId,periodEnd:f.terms.periodEnd,status:'active',cancelAtPeriodEnd:true,
  renewalOwnership:'intent',preflight:'clear'},refunds:{complete:true,rows:[]}});
 const start=async(f,i,stage,e=seen(f,i))=>(await one('select pay_common_monthly_refund_start($1,$2,$3,$4,$5,$6) i',
  [f.actor,f.order,i.id,i.revision,stage,e])).i;
 const fact=(f,i,status='succeeded')=>({id:'re_'+f.order,intentId:i.id,orderId:f.order,chargeId:f.terms.chargeId,
  paymentIntentId:f.terms.paymentIntentId,currency:'usd',amount:6486,merchant:'acct_fixture',mode:'test',status});
 const result=async(f,i,r)=>(await one('select pay_common_monthly_refund_result($1,$2,$3) i',[f.order,i.id,r])).i;
 const finish=async(f,i,e)=>(await one('select pay_common_monthly_refund_finish($1,$2,$3,$4) i',[f.actor,f.order,i.id,e])).i;
 for(const level of ['pro','gold']) {
  const f=await fx(level);let i=await approve(f);
  assert.equal((await approve(f)).id,i.id);
  i=await claim(f,i);assert.equal(i.hold,'held');
  const state=await one('select credits,membership_level from profiles where id=$1',[f.user]);
  assert.deepEqual(state,{credits:400,membership_level:'free'});
  await assert.rejects(()=>db.query("update user_subscriptions set status='active' where id=$1",[f.subscription]),/SOURCE_HELD/);
  await assert.rejects(()=>db.query("update profiles set membership_level='gold' where id=$1",[f.user]),/SOURCE_HELD/);
  await assert.rejects(()=>db.query("update subscription_credit_grants set status='granted' where id=$1",[f.grant]),/SOURCE_HELD/);
  const grant=(await one('select * from subscription_credit_grants where id=$1',[f.grant]));
  const invoiceGrant=(invoice,key,periodKey,start,end)=>db.query(`select * from atomic_grant_subscription_invoice_credits(
   p_user_id=>$1,p_membership_plan_id=>$2,p_stripe_subscription_id=>$3,p_stripe_invoice_id=>$4,p_source_order_id=>$5,
   p_amount_total=>6900,p_currency=>'usd',p_stripe_customer_id=>$6,p_grant_period_key=>$7,p_period_start=>$8,p_period_end=>$9,
   p_total_periods=>null,p_credits_granted=>1100,p_membership_level=>$10,p_idempotency_key=>$11,p_metadata=>$12)`,
   [f.user,f.terms.snapshot.item_id,f.terms.providerSubscriptionId,invoice,f.order,'cus_'+f.user,periodKey,start,end,
    f.terms.plan,key,{stripeSubscriptionStatus:'active',stripeSubscriptionUserId:f.user}]);
  await invoiceGrant(f.terms.invoiceId,grant.idempotency_key,grant.grant_period_key,grant.period_start,grant.period_end);
  const future=(await one("select ($1::timestamptz+interval '1 month') as next_end",[f.terms.periodEnd])).next_end;
  await assert.rejects(()=>invoiceGrant('in_renewal_'+f.order,'monthly:renewal:'+f.order,'monthly:renewal',f.terms.periodEnd,future),/SOURCE_HELD/);
  assert.equal((await one('select credits from profiles where id=$1',[f.user])).credits,400);
  assert.equal((await one('select count(*)::int n from payment_orders where user_id=$1',[f.user])).n,1);
  const before=seen(f,i);before.subscription.cancelAtPeriodEnd=false;before.subscription.renewalOwnership='original';
  i=await start(f,i,'stop_renewal',before);i=await start(f,i,'refund');
  const r=fact(f,i);i=await result(f,i,r);i=await result(f,i,r);
  assert.equal(i.status,'review_required');
  const e=seen(f,i);e.refunds.rows=[r];e.subscription.status='canceled';
  i=await finish(f,i,e);assert.equal(i.status,'succeeded');
  assert.equal((await finish(f,i,e)).status,'succeeded');
  assert.equal((await one('select credits from profiles where id=$1',[f.user])).credits,400);
  await checkErasureProof(db,i);
  assert.equal((await one('select monthly_refund_erasure_safe($1) ok',[{...i,unknownBody:'do not erase'}])).ok,false);
  const conflict=await result(f,i,{...r,status:'failed'});assert.equal(conflict.status,'review_required');
  assert.equal(conflict.recordedRefund.status,'succeeded');
 }
 const drift=await fx();let d=await claim(drift,await approve(drift));
 const clean=seen(drift,d);clean.subscription.cancelAtPeriodEnd=false;clean.subscription.renewalOwnership='original';
 d=await start(drift,d,'stop_renewal',clean);d=await start(drift,d,'refund');
 const settled=fact(drift,d);d=await result(drift,d,settled);
 d=await result(drift,d,{...settled,status:'failed'});
 const observed=seen(drift,d);observed.refunds.rows=[settled];
 await assert.rejects(()=>start(drift,d,'cancel',observed),/CONFLICT/);
 observed.subscription.status='canceled';
 await assert.rejects(()=>finish(drift,d,observed),/CONFLICT/);
 assert.equal((await get(drift)).terminalConflict,true);
 report.checks.push('persisted contradictory cash result blocks cancel and local finalization even after a clean provider reread');
 report.checks.push('Pro/Gold approval identity, source reservation, lifecycle guards, cash partial/full entitlement, duplicate success');
 const f=await fx();let i=await claim(f,await approve(f));
 const e=seen(f,i);e.subscription.cancelAtPeriodEnd=false;e.subscription.renewalOwnership='original';
 i=await start(f,i,'stop_renewal',e);i=await start(f,i,'refund');
 const r=fact(f,i,'failed');i=await result(f,i,r);
 const restore=seen(f,i);restore.refunds.rows=[r];i=await start(f,i,'restore_renewal',restore);
 restore.subscription.cancelAtPeriodEnd=false;i=await finish(f,i,restore);await finish(f,i,restore);
 assert.equal((await one('select credits,membership_level from profiles where id=$1',[f.user])).credits,1500);
 assert.equal((await one('select status from subscription_credit_grants where id=$1',[f.grant])).status,'granted');
 assert.equal((await one('select monthly_refund_erasure_safe($1) ok',[i])).ok,true);
 report.checks.push('complete success/failure financial proofs accepted; each missing/null/wrong-type field and contradictory terminal evidence refused');
 report.checks.push('confirmed failure restores original grant/balance exactly once');
 const blocked=await fx();await db.query("insert into credit_transactions(user_id,amount,type,ledger_type) values($1,-1,'deduction','spend')",[blocked.user]);
 await assert.rejects(()=>approve(blocked),/CONSUMPTION/);
 const noFee=await fx();noFee.terms.feePermitted='not_permitted';noFee.terms.feeMinor=0;noFee.terms.netMinor=6900;
 let nf=await claim(noFee,await approve(noFee));
 const stop=seen(noFee,nf);stop.subscription.cancelAtPeriodEnd=false;stop.subscription.renewalOwnership='original';
 nf=await start(noFee,nf,'stop_renewal',stop);nf=await start(noFee,nf,'refund');
 nf=await result(noFee,nf,{...fact(noFee,nf),amount:6900});
 assert.equal((await one('select status from payment_orders where id=$1',[noFee.order])).status,'refunded');
 const wrong=await fx();wrong.actor=wrong.user;await assert.rejects(()=>approve(wrong),/ADMIN_REQUIRED/);
 for(const [elapsed,passes] of [['167 hours 59 minutes 59.999999 seconds',true],['168 hours',true],['168 hours 0.000001 seconds',false]]){
  const f=await fx();
  f.terms.paidAt=(await one("select ($1::timestamptz-$2::interval)::text at",[f.terms.submittedAt,elapsed])).at;
  if(passes)await approve(f);else await assert.rejects(()=>approve(f),/WINDOW/);
 }
 for(const field of ['mode','merchant','currency','feeMinor','netMinor','credits','billing_cycle']){
  const f=await fx();
  if(field==='billing_cycle')f.terms.snapshot.billing_cycle='yearly';
  else f.terms[field]=typeof f.terms[field]==='number'?f.terms[field]+1:'wrong';
  await assert.rejects(()=>approve(f));
 }
 const untrusted=await fx();
 await db.query("update subscription_credit_grants set accounting_state='review_required',accounting_review_reason='synthetic' where id=$1",[untrusted.grant]);
 await assert.rejects(()=>approve(untrusted),/GRANT_UNRESOLVED/);
 const nested=await fx();let n=await claim(nested,await approve(nested));
 const noStop=seen(nested,n);noStop.subscription.cancelAtPeriodEnd=false;noStop.subscription.renewalOwnership='original';
 n=await start(nested,n,'stop_renewal',noStop);n=await start(nested,n,'refund');
 const cash=fact(nested,n);n=await result(nested,n,cash);
 const terminal=seen(nested,n);terminal.subscription.status='canceled';terminal.refunds.rows=[cash];n=await finish(nested,n,terminal);
 assert.equal((await one('select monthly_refund_erasure_safe($1) ok',[{...n,terms:{...n.terms,snapshot:{...n.terms.snapshot,unknownBody:'preserve'}}}])).ok,false);
 const rejected=await fx();
 const rejection=await one("select pay_common_monthly_refund_reject($1,$2,$3,'evidence_missing') i",[rejected.actor,rejected.order,rejected.ticket]);
 assert.equal(rejection.i.status,'rejected');
 await assert.rejects(()=>db.query("select pay_common_monthly_refund_reject($1,$2,$3,'customer_withdrew')",[nested.actor,nested.order,nested.ticket]),/ALREADY_DISPATCHED/);
 report.checks.push('SQL 168-hour microsecond boundary; amount/scope/yearly/untrusted rejection; nested unknown JSON retained; rejection never resets a claimed identity');
 report.checks.push('deny nonadmin and one-credit spend');
}
