/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function refundCases({ admin, service, connect }) {
  const plan = (await admin.query("SELECT id FROM membership_plans WHERE level='gold'")).rows[0].id;
  const start = '2026-10-01T00:00:00.000Z', end = '2027-10-01T00:00:00.000Z';
  async function pair(kind, legacy = false) {
    const user = randomUUID(), external = `sub_collision_${randomUUID()}`;
    await admin.query('INSERT INTO profiles(id,credits) VALUES($1,200)', [user]);
    const rows = [];
    for (let i = 0; i < 2; i++) {
      const sub = randomUUID(), order = randomUUID(), grant = randomUUID(), tx = randomUUID();
      const merchant = i && kind === 'merchant' ? 'other-fixture' : 'fixture';
      const mode = i && kind === 'mode' ? 'live' : 'test';
      const stripeId = legacy && i === 0 ? external : null;
      const invoice = `in_${order}`;
      const key = stripeId ? `annual:${start}:01` : `payment:${order}:01`;
      const snap = { version: 1, item_type: 'membership_plan', item_id: plan, item_updated_at: start,
        billing_cycle: 'yearly', currency: 'usd', unit: 'major', price: '621.00', discount: '0.00',
        tax_behavior: 'inclusive', credits: 1200, bonus_credits: 0 };
      await admin.query(`INSERT INTO user_subscriptions(id,user_id,membership_plan_id,billing_cycle,status,
        current_period_start,current_period_end,payment_channel,merchant_namespace,payment_mode,contract_snapshot,stripe_subscription_id)
        VALUES($1,$2,$3,'yearly','active',$4,$5,'stripe',$6,$7,$8,$9)`,
      [sub,user,plan,start,end,merchant,mode,snap,stripeId]);
      await admin.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
        payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_membership_level,
        purchase_snapshot,amount_total,currency,fulfilled_at,subscription_id,qualification_state,entitlement_start,entitlement_end)
        VALUES($1,$2,'membership_plan',$3,'yearly','payment','completed','paid','stripe',$4,$5,$6,$7,'gold',$8,62100,'usd',$9,$10,'sold',$9,$11)`,
      [order,user,plan,merchant,mode,randomUUID(),'a'.repeat(64),snap,start,sub,end]);
      await admin.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
        VALUES('stripe',$1,$2,'subscription',$3,$4)`, [merchant,mode,external,sub]);
      await admin.query(`INSERT INTO credit_transactions(id,user_id,amount,type,ledger_type,source_type,source_order_id,
        idempotency_key,balance_before,balance_after) VALUES($1,$2,100,'purchase','grant','payment_order',$3,$4,0,100)`,
      [tx,user,order,`grant:${order}`]);
      await admin.query(`INSERT INTO subscription_credit_grants(id,user_id,membership_plan_id,billing_cycle,grant_type,
        grant_period_key,period_start,period_end,credits_granted,consumed_amount,idempotency_key,credit_transaction_id,
        subscription_id,source_order_id,grant_snapshot,accounting_state,accounting_review_reason,period_index,total_periods,
        stripe_subscription_id,stripe_invoice_id)
        VALUES($1,$2,$3,'yearly','annual_monthly_release',$4,$5,'2026-11-01',100,$6,$7,$8,$9,$10,$11,'trusted',NULL,1,12,$12,$13)`,
      [grant,user,plan,key,start,i ? 20 : 10,`grant:${order}`,tx,sub,order,snap,stripeId,stripeId ? invoice : null]);
      rows.push({sub,order,grant,user,external,key});
    }
    return rows;
  }
  const run = (db, row, event = 'same-event') => db.query(`SELECT * FROM pay_waffo_atomic_refund_termination_clawback_fresh(
    p_source_order_id=>$1,p_user_id=>$2,p_subscription_id=>$3,p_event_id=>$4,
    p_refund_created_at=>'2026-10-15',p_refund_id=>'same-refund',p_now=>'2026-10-15')`,
  [row.order,row.user,row.external,event]);
  const snapshot = async row => (await admin.query(`SELECT to_jsonb(s) sub,to_jsonb(g) AS "grant" FROM user_subscriptions s
    JOIN subscription_credit_grants g ON g.subscription_id=s.id WHERE s.id=$1`,[row.sub])).rows[0];
  const balance = async row => (await admin.query('SELECT credits FROM profiles WHERE id=$1',[row.user])).rows[0].credits;
  const count = async row => Number((await admin.query("SELECT count(*) n FROM credit_transactions WHERE user_id=$1 AND ledger_type='refund_clawback'",[row.user])).rows[0].n);
  const cases = [];
  for (const kind of ['mode','merchant']) {
    const [first,second] = await pair(kind);
    const before = await snapshot(first);
    await assert.rejects(()=>service.query(`SELECT * FROM atomic_refund_termination_clawback_fresh(
      $1,$2,'old-caller','2026-10-15')`,[second.user,second.external]),/MIRROR_MISSING/);
    assert.deepEqual(await snapshot(first),before);
    // The cash observation may already mark the order refunded before entitlement reconciliation.
    await admin.query("UPDATE payment_orders SET status='refunded',payment_status='refunded' WHERE id=$1",[second.order]);
    const result = (await run(service,second)).rows[0];
    assert.equal(result.applied_clawback_amount,80);
    assert.equal(result.review_required,false);
    assert.equal((await snapshot(second)).grant.status,'reversed');
    assert.ok((await snapshot(second)).sub.credit_release_terminated_at);
    assert.deepEqual(await snapshot(first),before);
    assert.equal(await balance(second),120);
    const replay = (await run(service,second)).rows[0];
    assert.equal(replay.already_applied,true);
    assert.equal(await count(second),1);
    assert.equal((await run(service,second,'later-event')).rows[0].applied_clawback_amount,0);
    // Same user + same external event/refund IDs on the other source remain independent.
    assert.equal((await run(service,first)).rows[0].applied_clawback_amount,90);
    assert.equal(await count(first),2);
    assert.equal(await balance(first),30);
    cases.push(`refund-second-${kind}-source-only`,`refund-${kind}-replay-and-event-isolation`);
  }
  const [legacy,internal] = await pair('mode',true);
  assert.equal((await run(service,internal)).rows[0].applied_clawback_amount,80);
  const legacyResult = (await run(service,legacy)).rows[0];
  assert.equal(legacyResult.applied_clawback_amount,90);
  assert.ok(legacyResult.idempotency_key.includes(`:sub:${legacy.external}:`));
  const oldReplay = (await service.query(`SELECT * FROM atomic_refund_termination_clawback_fresh(
    $1,$2,'same-event','2026-10-15',NULL,'stripe_refund','same-refund','2026-10-15')`,[legacy.user,legacy.external])).rows[0];
  assert.equal(oldReplay.already_applied,true);
  assert.equal(await count(legacy),2);
  cases.push('refund-legacy-signature-canonical-replay');

  for (const available of [0,5]) {
    const [,row] = await pair('mode');
    await admin.query('UPDATE profiles SET credits=$2 WHERE id=$1',[row.user,available]);
    const result = (await run(service,row)).rows[0];
    assert.equal(result.applied_clawback_amount,available);
    assert.equal(result.shortfall_amount,80-available);
    const again = (await run(service,row)).rows[0];
    assert.equal(again.already_applied,true);
    assert.equal(again.shortfall_amount,80-available);
    assert.equal(await balance(row),0);
    assert.equal(await count(row),1);
  }
  cases.push('refund-zero-and-shortfall-replay');
  const [known,unknown] = await pair('mode');
  const knownBefore = await snapshot(known);
  await admin.query('UPDATE payment_orders SET payment_status=NULL WHERE id=$1',[unknown.order]);
  const uncertain = (await run(service,unknown)).rows[0];
  assert.equal(uncertain.review_required,true);
  assert.equal(uncertain.applied_clawback_amount,0);
  assert.equal(await count(unknown),0);
  assert.deepEqual(await snapshot(known),knownBefore);
  cases.push('refund-unknown-paid-source-stops-without-guessing');
  const [peer,target] = await pair('mode');
  const before = await snapshot(peer);
  const one = await connect(), two = await connect();
  await one.query('SET ROLE service_role'); await two.query('SET ROLE service_role');
  await admin.query('BEGIN');
  await admin.query('SELECT 1 FROM profiles WHERE id=$1 FOR UPDATE',[target.user]);
  const concurrent = [run(one,target),run(two,target)];
  let blocked = false;
  for (let i=0;i<100;i++) {
    const waiting = await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock'
      AND query LIKE 'SELECT * FROM pay_waffo_atomic_refund_termination_clawback_fresh%'`);
    if (waiting.rows[0].n===2) { blocked=true; break; }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(blocked,'two real refund sessions wait on the profile barrier');
  await admin.query('UPDATE subscription_credit_grants SET consumed_amount=30 WHERE id=$1',[target.grant]);
  await admin.query('UPDATE profiles SET credits=190 WHERE id=$1',[target.user]);
  await admin.query('COMMIT');
  const completed = (await Promise.all(concurrent)).map(result=>result.rows[0]);
  assert.equal(completed.filter(row=>row.already_applied).length,1);
  assert.ok(completed.every(row=>row.applied_clawback_amount===70));
  assert.equal(await balance(target),120);
  assert.equal(await count(target),1);
  assert.deepEqual(await snapshot(peer),before);
  cases.push('refund-real-concurrent-same-event-once','refund-lock-rechecks-latest-consumption');
  await assert.rejects(()=>run(service,{...target,user:legacy.user}),/SOURCE_MISMATCH/);
  await assert.rejects(()=>run(service,{...target,external:'wrong-subscription'}),/SOURCE_MISMATCH/);
  for (const role of ['anon','authenticated']) {
    await service.query(`SET ROLE ${role}`);
    await assert.rejects(()=>run(service,target),/permission denied/);
  }
  await service.query('SET ROLE service_role');
  cases.push('refund-source-binding-denied','refund-service-only');
  return cases;
}
