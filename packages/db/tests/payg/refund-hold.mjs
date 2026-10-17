/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// PAY-DISPUTE-GUARD refund hold (0289): a pack refunded outside Graylum without a clawback is held out of the
// PAYG claim balance like a terminated period's remainder, until a person settles it.
export async function refundHoldCases(db,report,createFixture,claim) {
  const f=await createFixture(db);
  const order=randomUUID(),item=randomUUID();
  await db.query('INSERT INTO credit_packages(id,name,credits_amount,price,bonus_credits) VALUES($1,$2,100,10,0)',[item,'Hold '+item]);
  await db.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,payment_channel,
    merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,amount_total,currency,
    fulfilled_at) VALUES($1,$2,'credit_package',$3,'one_time','payment','completed','paid','stripe','fixture','test',
    gen_random_uuid(),repeat('a',64),$4,1000,'usd',now())`,[order,f.actor,item,{version:1,item_type:'credit_package',item_id:item,
    item_updated_at:'2026-10-01T00:00:00Z',billing_cycle:'one_time',currency:'usd',unit:'major',price:'10',discount:'0',
    tax_behavior:'inclusive',credits:100,bonus_credits:0}]);
  await db.query('UPDATE profiles SET credits=credits+100 WHERE id=$1',[f.actor]);
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key)
    VALUES($1,100,'purchase','grant',$2,$3)`,[f.actor,order,'method-package:'+order]);
  // The opening grant has been spent elsewhere; only the pack's 100 credits remain, then the pack is refunded (0247).
  await db.query('UPDATE profiles SET credits=100 WHERE id=$1',[f.actor]);
  await db.query(`UPDATE payment_orders SET status='refunded',payment_status='refunded',
    metadata=jsonb_build_object('stripeExternalRefund',jsonb_build_object('state','pack_review')) WHERE id=$1`,[order]);
  const waiting=await claim(db,f,1,false);
  assert.deepEqual([waiting.state,waiting.id],['waiting_credits',null],'held credits do not start a PAYG call');
  assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n,0);
  const ops=randomUUID();
  await db.query("INSERT INTO profiles(id,credits,role,status) VALUES($1,0,'admin','active')",[ops]);
  await db.query("SELECT pay_common_pack_refund_review_settle($1,$2,'kept')",[ops,order]);
  const started=await claim(db,f,1,false);
  assert.ok(started.id,'after the pack is settled as kept the same call starts');
  report.checks.push('refunded pack held out of the PAYG claim balance (waiting_credits) until settled; settled "kept" claims normally');
}
