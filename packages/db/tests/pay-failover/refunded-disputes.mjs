/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** A later chargeback is a separate supplier cash fact, even when our refund already ended membership. */
export async function refundedChargebackCase({admin,service,order}) {
 const snapshot=async()=>({
  profile:(await admin.query('SELECT credits,membership_level FROM profiles WHERE id=$1',[order.user_id])).rows[0],
  subscription:(await admin.query(`SELECT s.status,s.cancel_at_period_end,s.credit_release_terminated_at,
   s.credit_release_terminated_reason FROM user_subscriptions s
   JOIN payment_orders o ON o.subscription_id=s.id WHERE o.id=$1`,[order.id])).rows[0],
  grants:(await admin.query(`SELECT id,status,credits_granted,consumed_amount,dispute_frozen,dispute_frozen_credits
   FROM subscription_credit_grants WHERE source_order_id=$1 ORDER BY id`,[order.id])).rows,
  ledger:(await admin.query(`SELECT id,amount,ledger_type,reason_code,idempotency_key FROM credit_transactions
   WHERE source_order_id=$1 ORDER BY id`,[order.id])).rows,
 });
 const status=(await admin.query('SELECT payment_status FROM payment_orders WHERE id=$1',[order.id])).rows[0].payment_status;
 assert.ok(['refunded','partially_refunded'].includes(status));
 const before=await snapshot();
 assert.equal(before.profile.credits,0);
 assert.equal(before.profile.membership_level,'free');
 assert.equal(before.subscription.status,'canceled');
 assert.ok(before.grants.every(g=>g.status==='reversed'));
 const nativeId=`CB_${randomUUID()}`;
 const observe=async()=>(await service.query(
  'SELECT pay_failover_dispute_observed($1,$2,$3,$4,$5,$6,$7,$8) v',
  [order.id,'fixture','test',`PAY_${order.id}`,nativeId,100,'usd',new Date()])).rows[0].v;
 const first=await observe();
 assert.equal(first.provider,'waffo');
 assert.equal(first.provider_dispute_id,nativeId,'keep the supplier-native chargeback identity');
 assert.equal(first.provider_payment_intent_id,`PAY_${order.id}`);
 assert.equal(first.order_id,order.id);
 assert.equal(first.amount,100,'a later partial chargeback must not become the full original sale');
 assert.equal(first.currency,'usd');
 assert.equal(first.freeze_state,'superseded','a refunded source is already closed and cannot be clawed back twice');
 assert.equal((await observe()).id,first.id,'the same supplier chargeback replays its original record');
 assert.deepEqual(await snapshot(),before,'chargeback and replay do not change balance, ended entitlement, grants, or ledger');
 assert.equal((await admin.query(`SELECT count(*)::int n FROM payment_disputes
  WHERE provider='waffo' AND merchant_namespace='fixture' AND mode='test' AND provider_dispute_id=$1`,[nativeId])).rows[0].n,1);
 return status==='refunded'?'chargeback-after-full-refund-audited-no-second-clawback'
  :'chargeback-after-partial-refund-audited-no-second-clawback';
}
