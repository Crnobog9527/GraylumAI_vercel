/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
export async function retentionCases({admin,service}) {
  const buyer=randomUUID();
  await admin.query('INSERT INTO profiles(id) VALUES($1)',[buyer]);
  const plan=(await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const raw=[{kind:'email',key_version:'test-v1',digest:'7'.repeat(64)}];
  const dig=createHash('sha256').update(`gold_purchase:${raw[0].digest}`).digest('hex');
  const buy=(user,mode='test')=>service.query(`SELECT o.* FROM pay_waffo_create_purchase($1,'membership_plan',$2,
    'monthly','card','gold_first30','fixture',$3,3,'terms-v1',$4) o`,[user,plan,mode,JSON.stringify(raw)]);
  const order=(await buy(buyer)).rows[0];
  await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('waffo','fixture','test','checkout','checkout_paid',$1)`,[order.id]);
  const observe=()=>service.query(`SELECT pay_waffo_observe_qualification($1,'fixture','test','checkout_paid',
    'paid','payment_gold',4900,'usd',now()) AS state`,[order.id]);
  assert.equal((await observe()).rows[0].state,'sold');
  assert.equal((await observe()).rows[0].state,'sold');
  const fact=(await admin.query("SELECT * FROM opening_grant_identity_digests WHERE purpose='gold_purchase_test' AND digest=$1",[dig])).rows[0];
  assert.equal(fact.expires_at.toISOString(),`${new Date().getUTCFullYear()+2}-01-01T00:00:00.000Z`);
  assert.equal(fact.expires_when,'gold_last_transaction_year_plus_one');
  assert.notEqual(fact.digest,raw[0].digest);
  // Refund does not restore the first-Gold offer or founder inventory.
  await admin.query("UPDATE payment_orders SET payment_status='refunded',status='refunded' WHERE id=$1",[order.id]);
  await service.query('SELECT account_erasure_confirm_with_digests($1,$2,$3)',[buyer,randomUUID(),JSON.stringify(raw)]);
  await assert.rejects(()=>buy(buyer),/ACCOUNT_CLOSED/);
  const returning=randomUUID(); await admin.query('INSERT INTO profiles(id) VALUES($1)',[returning]);
  await assert.rejects(()=>buy(returning),/GOLD_FIRST_INELIGIBLE/);
  assert.equal((await admin.query("SELECT count(*)::int n FROM opening_grant_identity_digests WHERE purpose='gold_purchase_live' AND digest=$1",[dig])).rows[0].n,0);
  // Retention expiry removes only Gold facts, not opening-grant facts or financial orders.
  await admin.query(`UPDATE opening_grant_identity_digests SET expires_at='2020-01-01'
    WHERE purpose='gold_purchase_test' AND digest=$1`,[dig]);
  assert.equal((await service.query('SELECT pay_waffo_expire_gold_identities() AS n')).rows[0].n,1);
  assert.equal((await admin.query("SELECT count(*)::int n FROM payment_orders WHERE id=$1",[order.id])).rows[0].n,1);
  // The live account history itself is still authoritative after a retained summary expires.
  await assert.rejects(()=>buy(buyer),/ACCOUNT_CLOSED/);
  return ['paid-qualification-idempotency','purpose-separated-gold-hash','year-end-plus-one-retention',
    'refund-keeps-gold-history','atomic-erasure-gold-retention','closed-account-denied','reregister-ineligible',
    'gold-history-mode-isolation','expired-digest-purge-keeps-financial-order'];
}
