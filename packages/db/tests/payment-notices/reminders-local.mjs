/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
// Throwaway PostgreSQL only. Financial facts are fixtures (not provider/Stripe-clock acceptance).
// Run: node packages/db/tests/payment-notices/reminders-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { orderFixtures } from '../pay-founder/fixtures.mjs';
const db = await localDb(), c = db.client;
const report = { build: db.build, checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const digest = 'a'.repeat(64);
const service = async (client, sql, args = []) => {
  await client.query('SET ROLE service_role');
  try { return await v(sql, args, client); } finally { await client.query('RESET ROLE'); }
};
const claim = (id, d = digest, actor = null, client = c) =>
  service(client, "SELECT payment_notice_claim($1,$2,'pay-n2-v1',$3) v", [id, d, actor]);
const scan = (client = c) => service(client, 'SELECT payment_notice_scan(100) v');
const row = async id => (await c.query('SELECT * FROM payment_notices WHERE id=$1', [id])).rows[0];
const find = async (source, suffix = '') => (await c.query('SELECT * FROM payment_notices WHERE source_ref=$1 AND due_key LIKE $2',
  [source, `%${suffix}`])).rows[0];
const bypass = async (sql, args = []) => {
  await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role='replica'");
  try { const r = await c.query(sql, args); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
};
try {
  const fp = read('packages/db/tests/baseline/fingerprint.sql');
  const catalog = fp.slice(0, fp.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalog);
  await c.query(read('packages/db/migrations/0313_disable_card_renewal_notices.sql'));
  assert.deepEqual(await v(catalog), before);
  report.checks.push('0313 repeated after full chain leaves catalog identical');
  const candidateBodyAfterDisable = await v("SELECT pg_get_functiondef('payment_notice_candidates(uuid)'::regprocedure) v");
  assert.ok(candidateBodyAfterDisable.includes('PAY-NOTIFY card renewal disabled'));
  assert.ok(!candidateBodyAfterDisable.includes('card_renewal_upcoming'));
  report.checks.push('card renewal candidate path is removed while stored legacy kind remains supported');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await v("SELECT has_function_privilege($1,'payment_notice_scan(integer)','execute') v", [role]), role === 'service_role');
    for (const fn of ['payment_notice_candidates(uuid)', 'payment_notice_eligible(payment_notices)']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, fn]), false);
    }
  }
  report.checks.push('only service_role can scan; helpers not directly callable');
  const fx = await orderFixtures(c), day = 86400000, now = Date.now();
  const order = async (user, options = {}) => {
    const id = await fx.order(user, { start: now - 350 * day, end: now + 6 * day, ...options });
    await bypass("UPDATE payment_orders SET purchase_membership_level='gold',purchase_snapshot='{" +
      '"price":"496.00","discount":"0.00"' + "}'::jsonb WHERE id=$1", [id]);
    return id;
  };
  const walletUser = await fx.profile(), wallet = await order(walletUser);
  const ordinary = await order(await fx.profile(), { offer: 'standard' });
  const due = await order(await fx.profile(), { end: now - 3600000 });
  const grace = await order(await fx.profile(), { end: now - 5 * day - 3600000 });
  // endedAt today, independent of the host timezone/time of day.
  const ended = await order(await fx.profile(), { end: now - 7 * day - 1000 });
  const delayedUser = await fx.profile();
  const delayed = await order(delayedUser, { end: now - 8 * day - 2 * 3600000 });
  // Red/green on the same actual database: the previous 24h cutoff permanently missed this ending.
  const candidateBody = await v("SELECT pg_get_functiondef('payment_notice_candidates(uuid)'::regprocedure) v");
  const newCutoff = "AND (e.st->>'endedAt')::timestamptz>now()-interval '7 days'";
  assert.ok(candidateBody.includes(newCutoff));
  await c.query('BEGIN');
  try {
    await c.query(candidateBody.replace(newCutoff, "AND (e.st->>'endedAt')::timestamptz>now()-interval '24 hours'"));
    const oldRows = (await c.query('SELECT * FROM payment_notice_candidates($1)', [delayedUser])).rows;
    assert.throws(() => assert.ok(oldRows.some(x => x.source_ref === delayed)), /false == true|assert|falsy/i);
  } finally { await c.query('ROLLBACK'); }

  const mp = await order(await fx.profile(), { method: 'card' });
  const cn = await order(await fx.profile(), { method: 'card_cn' });
  const mpSub = (await rowOrder(mp)).subscription_id;
  const cnSub = (await rowOrder(cn)).subscription_id;
  async function rowOrder(id) { return (await c.query('SELECT * FROM payment_orders WHERE id=$1', [id])).rows[0]; }
  const mpFacts = await rowOrder(mp);
  const mpPeriod = await c.query('SELECT current_period_end FROM user_subscriptions WHERE id=$1', [mpSub]);
  const mpEnd = mpPeriod.rows[0].current_period_end;
  const legacyParams = await v(`SELECT jsonb_build_object('endDate',s.current_period_end,'amount',o.purchase_snapshot->>'price',
    'plan',o.purchase_membership_level,'managed',o.payment_method='card') v
    FROM user_subscriptions s JOIN payment_orders o ON o.subscription_id=s.id WHERE s.id=$1`, [mpSub]);
  const legacyDue = (await v("SELECT to_char($1::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US')||':-7d' v", [mpEnd]));
  const legacy = (await service(c, 'SELECT payment_notice_enqueue($1,$2,$3,$4,$5) v',
    [mpFacts.user_id, 'card_renewal_upcoming', mpSub, legacyDue, legacyParams])).id;
  await c.query("UPDATE payment_notices SET state='unknown',first_attempt_at=now(),payload_digest=$2,template_version='pay-n2-v1' WHERE id=$1",
    [legacy, digest]);
  const admin = await fx.profile();
  await bypass("UPDATE profiles SET role='admin' WHERE id=$1", [admin]);
  const initiallyScanned = await scan();
  assert.equal(initiallyScanned.includes(legacy), false);
  assert.ok((await find(wallet, '-7d')).id);
  assert.equal((await find(ordinary)).kind, 'wallet_plan_expiry');
  assert.ok(await find(due, '0d'));
  assert.ok(await find(grace, '+5d'));
  assert.equal((await find(ended)).kind, 'founder_ended');
  assert.equal((await find(delayed)).kind, 'founder_ended');
  report.checks.push('red/green: old 24h window misses a 26h-old ending; seven-day catch-up enqueues it');
  assert.equal(await v("SELECT count(*)::int v FROM payment_notices WHERE kind='card_renewal_upcoming' AND source_ref IN ($1,$2)", [mpSub, cnSub]), 1);
  assert.equal(await find(cnSub), undefined);
  assert.equal((await row(legacy)).state, 'unknown');
  const legacyList = await service(c, 'SELECT payment_notice_admin_list($1) v', [admin]);
  assert.ok(legacyList.some(n => n.id === legacy && n.kind === 'card_renewal_upcoming' && n.resendable));
  // A stale pre-migration cron scan can still hold this ID; its post-migration system claim must skip.
  assert.deepEqual(await claim(legacy, digest), { decision: 'skip', reason: 'scheduled_card_notice_disabled' });
  assert.equal((await claim(legacy, digest, admin)).decision, 'send');
  assert.ok((await scan()).includes(legacy) === false);
  report.checks.push('wallet/founder notices remain; card/card_cn do not enqueue; stale system claim skips; legacy card history stays visible and admin-resendable');

  const second = new c.constructor({ host: c.host, port: c.port, user: 'postgres', database: c.database });
  await second.connect();
  try {
    const beforeCount = await v('SELECT count(*)::int v FROM payment_notices');
    await Promise.all([scan(), scan(second)]);
    assert.equal(await v('SELECT count(*)::int v FROM payment_notices'), beforeCount);
    const id = (await find(wallet)).id;
    const claims = await Promise.all([claim(id), claim(id, digest, null, second)]);
    assert.deepEqual(claims.map(x => x.decision).sort(), ['busy', 'send']);
    await v("SELECT payment_notice_finish($1,1,'sent','test_provider') v", [id]);
    assert.equal((await claim(id)).decision, 'done');
  } finally { await second.end(); }
  report.checks.push('repeat/concurrent scans create no duplicate; two claimants dispatch only once');

  await order(walletUser, { offer: 'founder_renewal', start: now + 6 * day, end: now + 371 * day });
  // Before-send renewal: prepare a different existing record, then buy a later term.
  const renewUser = await fx.profile(), old = await order(renewUser);
  await scan(); const oldNotice = await find(old);
  await order(renewUser, { offer: 'founder_renewal', start: now + 6 * day, end: now + 371 * day });
  assert.equal((await claim(oldNotice.id)).decision, 'skip');
  await bypass("UPDATE user_subscriptions SET cancel_at_period_end='true' WHERE id=$1", [mpSub]);
  report.checks.push('renewed wallet term and canceled card renewal rechecked at claim and skipped');

  const frozenUser = await fx.profile(), frozen = await order(frozenUser);
  await scan(); const frozenNotice = await find(frozen);
  // The current upstream freeze hook is a stub; substitute it only in this throwaway fixture to
  // prove future D1 freezes are honored without implementing D1 or changing real payment state.
  await c.query(`CREATE OR REPLACE FUNCTION pay_founder_order_frozen(p_order uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT p_order='${frozen}'::uuid $$`);
  assert.equal((await claim(frozenNotice.id)).decision, 'skip');
  assert.equal((await v('SELECT pay_founder_status($1) v', [frozenUser])).state, 'frozen');
  const refundUser = await fx.profile(), refund = await order(refundUser);
  await scan(); const refundNotice = await find(refund);
  await fx.refund(refund);
  assert.equal((await claim(refundNotice.id)).decision, 'skip');
  report.checks.push('freeze and refund arriving between scan and send prevent delivery');

  const erasing = await fx.profile(), erasureOrder = await order(erasing);
  await scan(); const erasureNotice = await find(erasureOrder);
  await c.query("INSERT INTO account_erasure_requests(profile_id,request_id,executor_token,confirmed_at) VALUES($1,gen_random_uuid(),gen_random_uuid(),clock_timestamp()-interval '1 minute')", [erasing]);
  assert.equal((await claim(erasureNotice.id)).decision, 'skip');
  await c.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1", [erasing]);
  await c.query('SELECT account_erasure_prune_business($1,100)', [erasing]);
  assert.equal(await v('SELECT count(*)::int v FROM payment_notices WHERE user_id=$1', [erasing]), 0);
  await scan();
  assert.equal(await v('SELECT count(*)::int v FROM payment_notices WHERE user_id=$1', [erasing]), 0);
  report.checks.push('erasure before send skips; prune deletes; rescans cannot recreate notices');

  const unknown = (await find(due, '0d')).id;
  assert.equal((await claim(unknown)).decision, 'send');
  await v("SELECT payment_notice_finish($1,1,'unknown') v", [unknown]);
  await c.query("UPDATE payment_notices SET first_attempt_at=now()-interval '25 hours' WHERE id=$1", [unknown]);
  assert.deepEqual(await claim(unknown), { decision: 'manual', reason: 'unknown_expired' });
  const changed = (await find(ordinary)).id;
  assert.equal((await claim(changed)).decision, 'send');
  await v("SELECT payment_notice_finish($1,1,'unknown') v", [changed]);
  assert.deepEqual(await claim(changed, 'b'.repeat(64)), { decision: 'manual', reason: 'digest_mismatch' });
  report.checks.push('unknown after 24h and changed digest go manual without dispatch');

  // Restored Pro reads linked upgrade + existing entitlement facts, not cached profile level.
  const proUser = await fx.profile(), prior = await order(proUser, { method: 'card_cn', offer: 'standard' });
  const proSub = (await rowOrder(prior)).subscription_id;
  const proPlan = randomUUID();
  await bypass("INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes) VALUES($1,'Pro fixture','pro',false,false,0)", [proPlan]);
  await bypass("UPDATE user_subscriptions SET membership_plan_id=$2,cancel_at_period_end='true' WHERE id=$1", [proSub, proPlan]);
  await bypass("UPDATE payment_orders SET item_id=$2,purchase_membership_level='pro',merchant_namespace='notice-fixture' WHERE id=$1", [prior, proPlan]);
  await bypass("UPDATE user_subscriptions SET merchant_namespace='notice-fixture' WHERE id=$1", [proSub]);
  await bypass("INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)"
    + " VALUES('stripe','notice-fixture','test','payment',$1,$2)", [`pi_${randomUUID().replaceAll('-', '')}`, prior]);
  const upgrade = await order(proUser, { method: 'card_cn', offer: 'standard', start: now - day, end: now + 365 * day, refund: 'refunded' });
  await bypass("UPDATE payment_orders SET method_transition='upgrade',source_order_id=$2,method_prior_subscription=$3 WHERE id=$1", [upgrade, prior, proSub]);
  await c.query('SET ROLE service_role');
  const proFacts = await v('SELECT pay_common_membership_facts($1) v', [proUser]);
  assert.equal(proFacts.internal_membership.membership_level, 'pro');
  await scan();
  await c.query('RESET ROLE');
  assert.equal((await find(upgrade)).kind, 'restore_pro_expiry');
  report.checks.push('restored Pro requires refunded linked upgrade + authoritative active Pro; no synthetic restoration flag');

  // Dispute capability has a stable key, but cron must not process it.
  const dispute = await v("SELECT payment_notice_enqueue($1,'dispute_won_resubscribe',$2,'dp_fixture') v", [proUser, prior]);
  assert.equal((await v("SELECT payment_notice_enqueue($1,'dispute_won_resubscribe',$2,'dp_fixture') v", [proUser, prior])).id, dispute.id);
  assert.equal((await scan()).includes(dispute.id), false);
  assert.equal((await claim(dispute.id)).decision, 'send');
  await v("SELECT payment_notice_finish($1,1,'sent','dispute_test_provider') v", [dispute.id]);
  assert.equal((await claim(dispute.id)).decision, 'done');
  report.checks.push('dispute function key is idempotent; daily scan never triggers dispute delivery');

  await c.query("UPDATE payment_notices SET created_at=now()-interval '30 days'");
  const clean = await v('SELECT log_retention_cleanup(1) v');
  assert.equal(clean.paymentNotices, 1); assert.equal(clean.more, true);
  while ((await v('SELECT log_retention_cleanup(100) v')).more) { /* bounded drain */ }
  assert.equal(await v('SELECT count(*)::int v FROM payment_notices'), 0);
  report.checks.push('existing log cleanup drains notices within 30 days and preserves its accurate counters');
  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
