/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Only called by the local runner against the ephemeral container it owns.
export async function testConcurrency({ endpoint, name, sql, ok }) {
  assert.ok(endpoint.startsWith('unix:///'));
  assert.match(name, /^graylum-pay-common-[a-f0-9]{8}$/);
  const actor = randomUUID();
  const workers = [];
  const worker = label => {
    const app = `pay-common-${label}-${randomUUID().slice(0, 8)}`;
    const child = spawn('docker', ['--host', endpoint, 'exec', '-i', name,
      'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'paycommon', '-v', 'ON_ERROR_STOP=1'],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const closed = new Promise(resolve => child.on('close', code => resolve(code)));
    child.stdin.write(`SET application_name='${app}'; SET statement_timeout='15s'; BEGIN;\n`);
    const wait = async marker => {
      for (let i = 0; i < 200; i++) {
        if (output.split('\n').includes(marker)) return;
        assert.equal(errors, '', errors);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`Concurrent SQL barrier timed out: ${label}/${marker}`);
    };
    const value = { app, child, wait, closed, send: text => child.stdin.write(`${text}\n`),
      finish: async () => {
        child.stdin.end('COMMIT;\n');
        assert.equal(await closed, 0, errors);
        return output;
      } };
    workers.push(value);
    return value;
  };
  const blockedBy = async (waiting, holder) => {
    for (let i = 0; i < 200; i++) {
      const blocked = ok(sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity w,pg_stat_activity h
        WHERE w.application_name='${waiting.app}' AND h.application_name='${holder.app}'
        AND h.pid=ANY(pg_blocking_pids(w.pid)));`));
      if (blocked === 't') return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Concurrent RPC never reached the expected database lock');
  };
  const plan = ok(sql(`WITH existing AS (SELECT id FROM membership_plans WHERE level='pro' LIMIT 1),
    created AS (INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      SELECT 'Concurrency fixture','pro',false,false,0 WHERE NOT EXISTS(SELECT 1 FROM existing) RETURNING id)
    SELECT id FROM existing UNION ALL SELECT id FROM created;`));
  assert.match(plan, /^[a-f0-9-]{36}$/);
  ok(sql(`INSERT INTO profiles(id,membership_level) VALUES('${actor}','free');
    UPDATE membership_plans SET yearly_price=1999,yearly_credits=1205,
      monthly_bonus_credits=0,is_active='true' WHERE id='${plan}';
    INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,
      membership_plan_id,billing_cycle,is_current)
    VALUES('stripe','acct_concurrency','test','price','price_concurrency','${plan}','yearly',true);`));
  const setChannel = channel => `UPDATE system_settings SET value=jsonb_build_object('channel','${channel}',
    'version',(value->>'version')::bigint+1) WHERE key='payment_new_purchase_channel';`;
  const switchFirst = worker('channel-switch-first');
  switchFirst.send(`${setChannel('waffo')} SELECT 'holding';`);
  await switchFirst.wait('holding');
  const newPurchase = worker('channel-purchase-after-switch');
  newPurchase.send(`DO $race$ BEGIN
    PERFORM pay_common_create_purchase('${actor}','membership_plan','${plan}',
      'yearly','acct_concurrency','test','free');
    RAISE EXCEPTION 'Expected unavailable channel';
    EXCEPTION WHEN check_violation THEN
      IF SQLERRM <> 'PAY_COMMON_CHANNEL_NOT_READY' THEN RAISE; END IF;
    END $race$; SELECT 'done';`);
  await blockedBy(newPurchase, switchFirst);
  await switchFirst.finish();
  await newPurchase.wait('done');
  await newPurchase.finish();
  assert.equal(ok(sql(`SELECT count(*) FROM payment_orders WHERE user_id='${actor}';`)), '0');
  ok(sql(setChannel('stripe')));
  const purchaseFirst = worker('channel-purchase-first');
  purchaseFirst.send(`SELECT (pay_common_create_purchase('${actor}','membership_plan','${plan}',
    'yearly','acct_concurrency','test','free')).id; SELECT 'holding';`);
  await purchaseFirst.wait('holding');
  const switchAfter = worker('channel-switch-after-purchase');
  switchAfter.send(`${setChannel('waffo')} SELECT 'done';`);
  await blockedBy(switchAfter, purchaseFirst);
  await purchaseFirst.finish();
  await switchAfter.wait('done');
  await switchAfter.finish();
  assert.equal(ok(sql(`SELECT payment_channel FROM payment_orders WHERE user_id='${actor}';`)), 'stripe');
  // The next admission below recovers this frozen Stripe intent while the default is Waffo.
  const initialBalance = Number(ok(sql(`SELECT credits FROM profiles WHERE id='${actor}';`)));
  const order = ok(sql(`SET ROLE service_role;
    SELECT (pay_common_create_purchase('${actor}','membership_plan','${plan}',
      'yearly','acct_concurrency','test','free')).id;`));
  ok(sql(setChannel('stripe')));
  ok(sql(`SET ROLE service_role; SELECT pay_common_record_checkout('${order}','acct_concurrency','test',
    jsonb_build_object('id','cs_concurrency','object','checkout.session','livemode',false,'mode','subscription',
      'client_reference_id','${actor}','metadata',jsonb_build_object('orderId','${order}',
        'userId','${actor}','itemId','${plan}','itemType','membership_plan',
        'billingCycle','yearly','priceId','price_concurrency'),
      'amount_total',1999,'currency','usd','payment_status','paid','status','complete','invoice','in_concurrency'));`));
  const invoice = `SELECT row_to_json(r) FROM atomic_grant_subscription_invoice_credits(
    p_metadata=>jsonb_build_object('stripeSubscriptionStatus','active','stripeSubscriptionUserId','${actor}'),
    p_user_id=>'${actor}',p_membership_plan_id=>'${plan}',p_stripe_subscription_id=>'sub_concurrency',
    p_stripe_invoice_id=>'in_concurrency',p_source_order_id=>'${order}',p_amount_total=>1999,
    p_grant_period_key=>'annual:2026-10-05T00:00:00.000Z:01',p_billing_cycle=>'yearly',
    p_grant_type=>'annual_monthly_release',p_period_index=>1,p_total_periods=>12,
    p_period_start=>'2026-10-05T00:00:00Z',p_period_end=>'2027-10-05T00:00:00Z',
    p_credits_granted=>101,p_membership_level=>'pro',p_idempotency_key=>'concurrent-invoice') r;`;
  const annual = period => `SELECT row_to_json(r) FROM atomic_grant_annual_subscription_credits(
    p_user_id=>'${actor}',p_membership_plan_id=>'${plan}',p_stripe_subscription_id=>'sub_concurrency',
    p_stripe_invoice_id=>'in_concurrency',p_source_order_id=>'${order}',
    p_grant_period_key=>'annual:2026-10-05T00:00:00.000Z:0${period}',
    p_period_start=>'2026-${period === 1 ? '10' : '11'}-05T00:00:00Z',
    p_period_end=>'2026-${period === 1 ? '11' : '12'}-05T00:00:00Z',
    p_period_index=>${period},p_total_periods=>12,p_credits_granted=>101,
    p_idempotency_key=>'concurrent-cron-${period}',p_description=>'Concurrency fixture',
    p_source_type=>'stripe_invoice',p_source_id=>'in_concurrency',p_now=>'2026-11-05T00:00:00Z') r;`;
  const results = output => output.split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  const race = async (label, firstSql, secondSql, expectedGrants) => {
    const first = worker(`${label}-first`);
    first.send(`SET LOCAL ROLE service_role; ${firstSql} SELECT 'holding';`);
    await first.wait('holding');
    const second = worker(`${label}-second`);
    second.send(`SET LOCAL ROLE service_role; ${secondSql} SELECT 'done';`);
    await blockedBy(second, first);
    const firstOutput = await first.finish();
    await second.wait('done');
    const secondOutput = await second.finish();
    const rows = [...results(firstOutput), ...results(secondOutput)];
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.granted).length, expectedGrants);
    assert.equal(rows.filter(row => row.is_idempotent).length, 2 - expectedGrants);
  };
  try {
    await race('duplicate-invoice', invoice, invoice, 1);
    await race('invoice-before-cron-period01', invoice, annual(1), 0);
    await race('cron-before-invoice-period01', annual(1), invoice, 0);
    await race('duplicate-cron-period02', annual(2), annual(2), 1);
    // While the profile is locked, neither RPC may hold downstream order or
    // subscription locks. NOWAIT probes prove the actual database lock order.
    for (const [label, request] of [['invoice', invoice], ['cron', annual(2)]]) {
      const holder = worker(`${label}-profile`);
      holder.send(`SELECT id FROM profiles WHERE id='${actor}' FOR UPDATE; SELECT 'holding';`);
      await holder.wait('holding');
      const waiting = worker(`${label}-lock-order`);
      waiting.send(`SET LOCAL ROLE service_role; ${request} SELECT 'done';`);
      await blockedBy(waiting, holder);
      ok(sql(`BEGIN; SET LOCAL lock_timeout='1s';
        SELECT id FROM payment_orders WHERE id='${order}' FOR UPDATE NOWAIT;
        SELECT id FROM user_subscriptions WHERE user_id='${actor}' FOR UPDATE NOWAIT; ROLLBACK;`));
      await holder.finish();
      await waiting.wait('done');
      const rows = results(await waiting.finish());
      assert.equal(rows[0].is_idempotent, true);
    }
    const state = JSON.parse(ok(sql(`SELECT json_build_object(
      'balance',(SELECT credits FROM profiles WHERE id='${actor}'),
      'grants',(SELECT count(*) FROM subscription_credit_grants WHERE user_id='${actor}'),
      'ledger',(SELECT count(*) FROM credit_transactions WHERE user_id='${actor}'),
      'subscriptions',(SELECT count(*) FROM user_subscriptions WHERE user_id='${actor}'),
      'invoices',(SELECT count(*) FROM payment_provider_refs WHERE object_type='invoice' AND external_id='in_concurrency'),
      'fulfilled',(SELECT fulfilled_at IS NOT NULL FROM payment_orders WHERE id='${order}'));`)));
    assert.deepEqual(state, { balance: initialBalance + 202, grants: 2, ledger: 2,
      subscriptions: 1, invoices: 1, fulfilled: true });
    return 'PR-3 switch/purchase both orders; PR-2 real PostgreSQL concurrency: duplicate invoice/cron, invoice-cron period01 both orders, profile-first locks';
  } finally {
    // Also release blocked transactions after an assertion failure, before the
    // parent runner removes its isolated container and volume.
    for (const item of workers) if (item.child.exitCode === null) item.child.kill('SIGTERM');
    await Promise.all(workers.map(item => item.closed));
  }
}
