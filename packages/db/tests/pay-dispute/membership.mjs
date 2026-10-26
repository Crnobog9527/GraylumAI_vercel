/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {renewalReplayCases} from './renewal-replay.mjs';
export async function membershipCases({c,v,profile,receive,withdraw,ops,report}) {
 const facts=async user=>{await c.query('SET ROLE service_role');try{return await v('SELECT pay_common_membership_facts($1) v',[user]);}finally{await c.query('RESET ROLE');}};
 const member=async(start,end,cycle='monthly')=>{
  const user=await profile(0),order=randomUUID(),sub=randomUUID(),plan=randomUUID();
  await c.query(`INSERT INTO membership_plans(id,name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,
   allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES($1,'Fixture','pro',10,120,100,1200,true,true,500000000)
   ON CONFLICT(level) DO NOTHING`,[plan]);
  const pid=await v("SELECT id v FROM membership_plans WHERE level='pro'");
  const snap={version:1,item_type:'membership_plan',item_id:pid,item_updated_at:'2026-10-01T00:00:00Z',
   billing_cycle:cycle,currency:'usd',unit:'major',price:cycle==='yearly'?'120':'10',discount:'0',
   tax_behavior:'exclusive',credits:cycle==='yearly'?1200:100,bonus_credits:0};
  const price=(await c.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
   membership_plan_id,billing_cycle,is_current,offer_kind,price_usage)
   VALUES('stripe','fixture','test','price',$1,$2,$3,false,'standard','subscription') RETURNING id`,
   ['price_'+order.replaceAll('-',''),pid,cycle])).rows[0].id;
  await c.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,billing_cycle,status,current_period_start,current_period_end,
   payment_channel,merchant_namespace,payment_mode,contract_snapshot,cancel_at_period_end)
   VALUES($1,$2,$3,$4,'active',$5,$6,'stripe','fixture','test',$7,'false')`,[sub,user,pid,cycle,start,end,snap]);
  await c.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,amount_total,currency,
   payment_channel,merchant_namespace,payment_mode,payment_method,purchase_request_id,purchase_payload_hash,purchase_snapshot,
   fulfilled_at,subscription_id,purchase_action,purchase_membership_level,auto_renew,entitlement_term,
   entitlement_start,entitlement_end,qualified_paid_at,qualification_state,routing_version,terms_version,terms_accepted_at,offer_kind,
   price_ref_id,stripe_managed_payments,dispute_payment_key,dispute_subscription_key)
   VALUES($1,$2,'membership_plan',$3,$4,'subscription','completed','paid',$5,'usd','stripe','fixture','test','card_cn',
    gen_random_uuid(),repeat('a',64),$6,now(),$7,'checkout','pro',true,$8,$9,$10,$9,'sold',1,'terms-v1',now(),'standard',$11,false,$12,$13)`,
   [order,user,pid,cycle,cycle==='yearly'?12000:1000,snap,sub,cycle==='yearly'?'year':'month',start,end,price,
    'fixture:test:pi_'+order.replaceAll('-',''),'fixture:test:sub_'+sub.replaceAll('-','')]);
  await c.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
   VALUES('stripe','fixture','test','payment',$1,$2)`,['in_'+order.replaceAll('-',''),order]);
  await c.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
   VALUES('stripe','fixture','test','subscription',$1,$2)`,['sub_'+sub.replaceAll('-',''),sub]);
  await c.query('SELECT pay_waffo_grant_period($1,1)',[order]);
  return {user,order,sub,start,end,providerSub:'sub_'+sub.replaceAll('-','')};
 };
 const start=new Date(Date.now()-60000),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
 // Missing event subscription identity is derived from the mapped order's scoped provider ref.
 const derived=await member(start,end);
 await c.query('UPDATE payment_orders SET dispute_subscription_key=NULL WHERE id=$1',[derived.order]);
 const derivedDispute=await receive(derived);
 assert.equal(derivedDispute.provider_subscription_id,derived.providerSub);
 assert.equal(await v('SELECT dispute_subscription_key v FROM payment_orders WHERE id=$1',[derived.order]),'fixture:test:'+derived.providerSub);
 await c.query('SET ROLE service_role');
 assert.equal(await v('SELECT pay_dispute_stop_claim($1) v',[derivedDispute.id]),true);
 await c.query('RESET ROLE');
 await assert.rejects(()=>receive(derived,{subscriptionId:'sub_wrong'}),/PAY_DISPUTE_SUBSCRIPTION_CONFLICT/);
 // An unmatched event can be associated later; both repair and fulfillment claiming persist the identity.
 for(const viaMatch of [true,false]) {
  const late=await member(start,end);
  await c.query('UPDATE payment_orders SET dispute_payment_key=NULL,dispute_subscription_key=NULL WHERE id=$1',[late.order]);
  const pending=await receive(late,{orderId:null});
  assert.equal(pending.provider_subscription_id,null);
  if(viaMatch) {
   await c.query('SET ROLE service_role');await v('SELECT pay_dispute_match($1,$2) v',[pending.id,late.order]);await c.query('RESET ROLE');
  } else {
   await c.query("UPDATE payment_orders SET dispute_payment_key=$2,dispute_subscription_key=$3 WHERE id=$1",
    [late.order,'fixture:test:pi_'+late.order.replaceAll('-',''),'fixture:test:'+late.providerSub]);
   await c.query('SELECT pay_dispute_claim_pending($1)',[late.order]);
  }
  assert.equal(await v('SELECT provider_subscription_id v FROM payment_disputes WHERE id=$1',[pending.id]),late.providerSub);
 }
 // A later event must repair retained legacy rows that already have the order but lack provider identity.
 await c.query('UPDATE payment_disputes SET provider_subscription_id=NULL WHERE id=$1',[derivedDispute.id]);
 assert.equal((await receive(derived,{subscriptionId:derived.providerSub})).provider_subscription_id,derived.providerSub);
 report.checks.push('missing subscription derived and locked; conflict rejected; late match, pending claim and later event backfill identity');
 // Stop confirmation must reload the mapping committed while it waited on the advisory lock.
 const matching=await member(start,end),matcher=new pg.Client(c.connectionParameters);
 await c.query('UPDATE payment_orders SET dispute_payment_key=NULL,dispute_subscription_key=NULL WHERE id=$1',[matching.order]);
 const unmapped=await receive(matching,{orderId:null,subscriptionId:matching.providerSub});
 await matcher.connect();
 try {
  await matcher.query('BEGIN');await v('SELECT pay_dispute_match($1,$2) v',[unmapped.id,matching.order],matcher);
  const confirming=v('SELECT pay_dispute_stop_confirm($1,false) v',[unmapped.id]);
  let blocked_=false;
  for(let i=0;i<100&&!blocked_;i++) {
   blocked_=await v('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) v',[c.processID],matcher);
   if(!blocked_)await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(blocked_,true);await matcher.query('COMMIT');await confirming;
  assert.equal(await v("SELECT cancel_at_period_end='true' v FROM user_subscriptions WHERE id=$1",[matching.sub]),true);
  assert.equal(await v('SELECT renewal_stop_state v FROM payment_disputes WHERE id=$1',[unmapped.id]),'confirmed');
 } finally {await matcher.end();}
 report.checks.push('stop confirmation reloads a mapping committed while waiting and synchronizes internal subscription state');
 const outsideMember=await member(start,end);
 await c.query('UPDATE payment_orders SET dispute_payment_key=NULL,dispute_subscription_key=NULL WHERE id=$1',[outsideMember.order]);
 await c.query("DELETE FROM payment_provider_refs WHERE order_id=$1 AND object_type='payment'",[outsideMember.order]);
 const outsideDispute=await receive(outsideMember,{orderId:null});
 await v('SELECT pay_dispute_resolve_external($1,$2) v',[ops,outsideDispute.id]);
 await v('SELECT pay_dispute_match($1,$2) v',[outsideDispute.id,outsideMember.order]);
 assert.equal(await v('SELECT freeze_state v FROM payment_disputes WHERE id=$1',[outsideDispute.id]),'frozen');
 assert.equal(await v('SELECT renewal_stop_state v FROM payment_disputes WHERE id=$1',[outsideDispute.id]),'pending');
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[outsideMember.user]),0);
 report.checks.push('late match after external resolution freezes delivered membership and reopens subscription stop');
 const f=await member(start,end);
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[f.user]),100);
 const d=await receive(f,{subscriptionId:f.providerSub});
 assert.equal((await facts(f.user)).internal_membership.membership_level,'free');
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[f.user]),0);
 await withdraw(ops,d);
 assert.equal((await facts(f.user)).internal_membership.membership_level,'pro');
 report.checks.push('current paid period loses membership during freeze and regains it on withdrawal');
 {
 const refundMember=await member(start,end);
 const ticket=randomUUID();
 const submitted=(await c.query("INSERT INTO tickets(id,user_id,title,category) VALUES($1,$2,'Synthetic refund','billing') RETURNING created_at::text created_at",
  [ticket,refundMember.user])).rows[0].created_at;
 const snapshot=await v('SELECT purchase_snapshot v FROM payment_orders WHERE id=$1',[refundMember.order]);
 const terms={kind:'monthly_first_purchase',orderId:refundMember.order,userId:refundMember.user,ticketId:ticket,
  subscriptionId:refundMember.sub,providerSubscriptionId:refundMember.providerSub,
  paymentIntentId:'pi_'+refundMember.order.replaceAll('-',''),chargeId:'ch_'+refundMember.order.replaceAll('-',''),
  invoiceId:'in_'+refundMember.order.replaceAll('-',''),merchant:'fixture',mode:'test',currency:'usd',plan:'pro',
  paidAt:start.toISOString(),submittedAt:submitted,periodEnd:end.toISOString(),originalCancelAtPeriodEnd:false,
  paidMinor:1000,basisMinor:1000,feeMinor:0,netMinor:1000,taxMinor:0,credits:100,
  feePermitted:'not_permitted',feeEvidence:'fixture',evidenceRefs:['cash','history','ticket','ledger'],snapshot};
 const approve=async()=>{
  const quote=await v('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4) v',[ops,refundMember.order,terms,'a'.repeat(64)]);
  return v('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4,$5) v',
   [ops,refundMember.order,terms,'a'.repeat(64),quote.localVersion]);
 };
 const refundDispute=await receive(refundMember,{subscriptionId:refundMember.providerSub});
 await assert.rejects(()=>v('SELECT pay_common_monthly_refund_claim($1,$2,$3,$4) v',
  [ops,refundMember.order,randomUUID(),terms]),/PAY_DISPUTE_REFUND_FORBIDDEN/);
 await withdraw(ops,refundDispute);
 const refreshed=await approve();
 await v('SELECT pay_common_monthly_refund_claim($1,$2,$3,$4) v',[ops,refundMember.order,refreshed.id,terms]);
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[refundMember.user]),0);
 report.checks.push('withdrawn current-period dispute permits fresh monthly refund approval and claim without loosening active-hold guard');
 }
 // A previous period's freeze cannot take a separately paid current period away.
 const priorStart=new Date(start);priorStart.setUTCMonth(priorStart.getUTCMonth()-1);
 const next=await member(priorStart,start);
 const nextEnd=new Date(start);nextEnd.setUTCMonth(nextEnd.getUTCMonth()+1);
 const renewed=await v('SELECT pay_dispute_renew($1) v',[{subscription:next.sub,subscriptionId:next.providerSub,
  merchant:'fixture',mode:'test',invoiceId:'in_next_'+next.sub.replaceAll('-',''),paymentIntentId:'pi_next_'+next.sub.replaceAll('-',''),
  amount:1000,currency:'usd',paidAt:start,start,end:nextEnd}]);
 assert.equal(renewed.state,'fulfilled');
 await receive(next,{subscriptionId:next.providerSub});
 assert.equal((await facts(next.user)).internal_membership.membership_level,'pro');
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[next.user]),100);
 report.checks.push('previous-period dispute preserves an already delivered next period and its credits');
 const frozen=await member(priorStart,start);await receive(frozen,{subscriptionId:frozen.providerSub});
 const refused=await v('SELECT pay_dispute_renew($1) v',[{subscription:frozen.sub,subscriptionId:frozen.providerSub,
  merchant:'fixture',mode:'test',invoiceId:'in_blocked_'+frozen.sub.replaceAll('-',''),paymentIntentId:'pi_blocked_'+frozen.sub.replaceAll('-',''),
  amount:1000,currency:'usd',paidAt:start,start,end:nextEnd}]);
 assert.equal(refused.state,'review');assert.equal(refused.disputeRefundRequired,true);
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[frozen.user]),0);
 report.checks.push('renewal after frozen previous period is retained without grants and requires full refund');
 // Both real commit orders, with the second connection blocked on the shared subscription lock.
 for (const disputeFirst of [true,false]) {
  const racing=await member(priorStart,start),connection=new pg.Client(c.connectionParameters);
  await connection.connect();
  const renew=client=>v('SELECT pay_dispute_renew($1) v',[{subscription:racing.sub,subscriptionId:racing.providerSub,
   merchant:'fixture',mode:'test',invoiceId:'in_race_'+racing.sub.replaceAll('-',''),
   paymentIntentId:'pi_race_'+racing.sub.replaceAll('-',''),amount:1000,currency:'usd',paidAt:start,start,end:nextEnd}],client);
  try {
   await connection.query('BEGIN');
   if(disputeFirst)await receive(racing,{},connection);
   else await renew(connection);
   const waiting=disputeFirst?renew(c):receive(racing);
   let blocked_=false;
   for(let i=0;i<100&&!blocked_;i++) {
    blocked_=await v('SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) v',[c.processID],connection);
    if(!blocked_)await new Promise(r=>setTimeout(r,5));
   }
   assert.equal(blocked_,true,'second renewal/dispute transaction must wait on the first lock');
   await connection.query('COMMIT');
   const result=await waiting;
   assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[racing.user]),disputeFirst?0:100);
   assert.equal((await facts(racing.user)).internal_membership.membership_level,disputeFirst?'free':'pro');
   if(disputeFirst)assert.equal(result.disputeRefundRequired,true);
  } finally {await connection.end();}
 }
 report.checks.push('real two-connection prior-dispute/next-renewal races in both commit orders preserve delivered periods or require refund');
 const annualStart=new Date(start);annualStart.setUTCMonth(annualStart.getUTCMonth()-1);
 const annualEnd=new Date(annualStart);annualEnd.setUTCFullYear(annualEnd.getUTCFullYear()+1);
 const annual=await member(annualStart,annualEnd,'yearly');await receive(annual,{subscriptionId:annual.providerSub});
 assert.equal(await v('SELECT pay_waffo_grant_period($1,2) v',[annual.order]),0);
 report.checks.push('annual monthly release rechecks frozen source under lock');
 // A subscription reservation returned after an external refund must not resurrect spendable credit.
 const late=await member(start,end);
 await c.query("SELECT pay_stripe_mp_record_tax($1,'fixture',$2,0)",[late.order,'in_'+late.order.replaceAll('-','')]);
 const reservation=await v("SELECT pre_deduct_id v FROM atomic_pre_deduct($1,30,'late return',gen_random_uuid())",[late.user]);
 await receive(late,{subscriptionId:late.providerSub});
 await c.query("SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,'re_subscription_late',1000,'usd',now())",
  [late.order,'in_'+late.order.replaceAll('-','')]);
 await c.query('SELECT * FROM bill2_legacy_refund($1,$2)',[late.user,reservation]);
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[late.user]),0);
 report.checks.push('full subscription refund replaces frozen credits and intercepts later in-flight returns');
 // Construct the already claimed monthly refund state; exercise the actual stop-confirm and finish RPCs.
 const held=await member(start,end),intent=randomUUID(),refundId='re_monthly_'+intent.replaceAll('-','');
 const terms={userId:held.user,subscriptionId:held.sub,providerSubscriptionId:held.providerSub,merchant:'fixture',mode:'test',
  credits:100,plan:'pro',periodEnd:end.toISOString(),originalCancelAtPeriodEnd:false};
 await c.query('BEGIN');
 await c.query("SELECT set_config('pay_common.monthly_transition',$1,true)",[intent]);
 await c.query('UPDATE payment_orders SET refund_approval=$2 WHERE id=$1',[held.order,
  {id:intent,kind:'monthly_first_purchase',hold:'held',status:'review_required',revision:1,terms,
   recordedRefund:{id:refundId,status:'failed'}}]);
 await c.query("UPDATE profiles SET credits=credits-100,membership_level='free' WHERE id=$1",[held.user]);
 await c.query("UPDATE subscription_credit_grants SET status='reversed' WHERE source_order_id=$1",[held.order]);
 await c.query("UPDATE user_subscriptions SET status='paused' WHERE id=$1",[held.sub]);
 await c.query('COMMIT');
 const dispute=await receive(held,{subscriptionId:held.providerSub});
 await c.query('SET ROLE service_role');
 try {
  await c.query('SELECT pay_dispute_stop_confirm($1,false)',[dispute.id]);
  await c.query('SELECT pay_common_monthly_refund_finish($1,$2,$3,$4)',[ops,held.order,intent,
   {mode:'test',merchant:'fixture',checkedAt:new Date().toISOString(),
    subscription:{id:held.providerSub,periodEnd:end.toISOString(),status:'active',preflight:'clear',cancelAtPeriodEnd:true},
    refunds:{complete:true,rows:[{id:refundId,status:'failed'}]}}]);
 } finally {await c.query('RESET ROLE');}
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[held.user]),0);
 assert.equal(await v('SELECT membership_level v FROM profiles WHERE id=$1',[held.user]),'free');
 assert.equal(await v('SELECT dispute_frozen_credits v FROM subscription_credit_grants WHERE source_order_id=$1',[held.order]),100);
 await withdraw(ops,dispute);
 assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1',[held.user]),100);
 assert.equal(await v('SELECT cancel_at_period_end v FROM user_subscriptions WHERE id=$1',[held.sub]),'true');
 report.checks.push('monthly refund failure during dispute: source and balance remain frozen; stop survives restore and withdrawal');
 await renewalReplayCases({c,v,receive,withdraw,ops,report,member,facts,start,nextEnd});

}
