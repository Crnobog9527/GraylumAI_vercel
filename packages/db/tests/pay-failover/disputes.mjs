/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function disputeCases({admin,service,connect,actor,create,bind,pay}) {
 const member=await create();await bind(member);await pay(member);
 const ticket=randomUUID();await admin.query("INSERT INTO tickets(id,user_id,title,description,category) VALUES($1,$2,'Test','Synthetic','billing')",[ticket,member.user_id]);
 const paidAt=(await admin.query('SELECT qualified_paid_at FROM payment_orders WHERE id=$1',[member.id])).rows[0].qualified_paid_at;
 const cash={orderId:member.id,merchant:'fixture',mode:'test',currency:'usd',paidMinor:member.amount_total,
  taxMinor:0,refundedMinor:0,refundCount:0,disputed:false,chargeId:`PAY_${member.id}`,paymentIntentId:`PAY_${member.id}`,paidAt};
 const quote=(await service.query('SELECT pay_common_package_refund_quote($1,$2,$3,$4,$5,$6) v',
  [actor,member.id,ticket,cash,'not_permitted','test-case'])).rows[0].v;
 const approval=(await service.query('SELECT pay_common_package_refund_decide($1,$2,$3,$4,$5,$6,$7,$8) v',
  [actor,member.id,ticket,cash,'not_permitted','test-case',quote.versionHash,'approve'])).rows[0].v;
 const nativeId=`CB_${randomUUID()}`;
 const observed=async(o=member,{merchant='fixture',mode='test',amount=o.amount_total,currency='usd',dispute=nativeId}={})=>(await service.query(
  'SELECT pay_failover_dispute_observed($1,$2,$3,$4,$5,$6,$7,$8) v',
  [o.id,merchant,mode,`PAY_${o.id}`,dispute,amount,currency,new Date()])).rows[0].v;
 await assert.rejects(()=>observed(member,{merchant:'wrong'}),/DISPUTE_SCOPE/);
 await assert.rejects(()=>observed(member,{mode:'live'}),/DISPUTE_SCOPE/);
 await assert.rejects(()=>observed(member,{amount:member.amount_total+1}),/DISPUTE_SCOPE/);
 const first=await observed(member,{amount:100});assert.equal(first.amount,100);assert.equal(first.provider,'waffo');assert.equal(first.provider_dispute_id,nativeId);
 assert.equal(first.freeze_state,'frozen');assert.equal(first.renewal_stop_state,'not_applicable');assert.equal(first.closed_at,null);
 assert.equal((await observed(member,{amount:100})).id,first.id);
 assert.equal((await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[member.user_id])).rows[0].credits,0);
 assert.equal((await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[member.user_id])).rows[0].membership_level,'free');
 assert.equal((await admin.query("SELECT count(*)::int n FROM credit_transactions WHERE source_order_id=$1 AND reason_code='dispute_freeze'",[member.id])).rows[0].n,1);
 await assert.rejects(()=>service.query('SELECT pay_common_package_refund_claim($1,$2,$3,$4)',
  [actor,member.id,approval.id,cash]),/DISPUTE_REFUND_FORBIDDEN/);
 // Won case: an administrator withdraws the hold exactly like a Stripe dispute; the next daily scan never re-freezes.
 const held=-(await admin.query("SELECT amount FROM credit_transactions WHERE source_order_id=$1 AND reason_code='dispute_freeze'",[member.id])).rows[0].amount;
 assert.ok(held>0);
 const withdrawn=(await service.query('SELECT pay_dispute_withdraw($1,$2) v',[actor,first.id])).rows[0].v;
 assert.deepEqual(withdrawn,{restored:held,duplicate:false});
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[member.user_id])).rows[0].credits,held);
 assert.equal((await observed(member,{amount:100})).freeze_state,'withdrawn');
 assert.equal((await service.query('SELECT pay_dispute_withdraw($1,$2) v',[actor,first.id])).rows[0].v.duplicate,true);
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[member.user_id])).rows[0].credits,held);
 // Delivery-time lookup and the daily scan can observe one chargeback at the same moment: one record, one hold.
 const raced=await create();await bind(raced);await pay(raced);
 const racedId=`CB_${randomUUID()}`,other=await connect();await other.query('SET ROLE service_role');
 const call=c=>c.query('SELECT pay_failover_dispute_observed($1,$2,$3,$4,$5,$6,$7,$8) v',
  [raced.id,'fixture','test',`PAY_${raced.id}`,racedId,raced.amount_total,'usd',new Date()]);
 const both=await Promise.all([call(service),call(other)]);
 assert.equal(both[0].rows[0].v.id,both[1].rows[0].v.id);
 assert.equal((await admin.query('SELECT count(*)::int n FROM payment_disputes WHERE provider_dispute_id=$1',[racedId])).rows[0].n,1);
 assert.equal((await admin.query("SELECT count(*)::int n FROM credit_transactions WHERE source_order_id=$1 AND reason_code='dispute_freeze'",[raced.id])).rows[0].n,1);
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[raced.user_id])).rows[0].credits,0);
 const before=await create();await bind(before);
 const review=await pay(before,{review:'chargeback_observed'});assert.equal(review.state,'review');
 assert.equal(review.reason,'chargeback_observed');
 const actual=(await admin.query('SELECT provider_payment_method,fulfilled_at,payment_amount_facts FROM payment_orders WHERE id=$1',[before.id])).rows[0];
 assert.equal(actual.provider_payment_method,'card');assert.equal(actual.fulfilled_at,null);assert.equal(actual.payment_amount_facts.length,1);
 await observed(before,{dispute:`CB_${randomUUID()}`});
 assert.equal((await pay(before)).state,'review','late retry cannot grant under a frozen chargeback');
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[before.user_id])).rows[0].credits,0);
 // A supplier's real chargeback identity can never be rebound to another PAY.
 await assert.rejects(()=>observed(before),/DISPUTE_IDENTITY_CONFLICT/);
 const unknownAmount=await create();await bind(unknownAmount);await pay(unknownAmount);
 const uncertainId=`CB_${randomUUID()}`;
 const uncertain=await observed(unknownAmount,{amount:null,currency:null,dispute:uncertainId});
 assert.equal(uncertain.amount,null);assert.equal(uncertain.currency,null);assert.equal(uncertain.source_review_required,true);assert.equal(uncertain.freeze_state,'frozen');
 assert.equal((await admin.query('SELECT credits FROM profiles WHERE id=$1',[unknownAmount.user_id])).rows[0].credits,0);
 assert.equal((await observed(unknownAmount,{amount:100,dispute:uncertainId})).amount,100,'first verified amount fills the unknown fact');
 await assert.rejects(()=>observed(unknownAmount,{amount:200,dispute:uncertainId}),/IDENTITY_CONFLICT/);
 for(const reason of ['product_scope','source_term_unknown','founder_term_unknown','term_invalid']){
  const o=await create();await bind(o);assert.equal((await pay(o,{review:reason})).reason,reason);
  assert.equal((await admin.query('SELECT provider_payment_method FROM payment_orders WHERE id=$1',[o.id])).rows[0].provider_payment_method,'card');
 }
 return ['waffo-chargeback-real-id-and-payment-scope','chargeback-freezes-existing-membership-and-credits-once',
  'chargeback-blocks-already-approved-refund','known-method-review-keeps-real-method-and-cash',
  'pre-fulfillment-chargeback-never-grants','chargeback-id-cannot-rebind','unknown-chargeback-amount-freezes-without-inventing-cash','review-reasons-do-not-pretend-method-unknown',
  'waffo-won-case-admin-withdraw-and-rescan-never-refreezes','waffo-concurrent-observation-one-record-one-hold'];
}
