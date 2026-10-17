/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PAY-DISPUTE-GUARD PR-D0 verification (credit sources) on the full file-built database.
// Synthetic profiles, orders and reservations only; no Auth, no provider, no network beyond the local container.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0275_pay_dispute_credit_sources.sql';
const MARK = ' -- PR-D0 credit sources';
// Later migrations that replace or hook 0275's functions (0285 refund hold): reapplied after 0275 so the
// end state is the full chain again.
const LATER = ['packages/db/migrations/0285_pay_refunded_pack_hold.sql'];
const reapply = async () => { for (const path of [migrationPath, ...LATER]) await c.query(read(path)); };
const HOOKED = ['atomic_pre_deduct(uuid,integer,text,uuid)', 'bill2_legacy_settle(uuid,uuid,integer,jsonb,jsonb)',
  'bill2_legacy_refund(uuid,uuid,text)', 'bill2_legacy_abort_settle(uuid,uuid,integer,jsonb,text,text)',
  'bill2_payg_compensate(bill2_runs,bill2_calls)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0275', checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
const catalog = () => v(fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;');
const hour = 3600000, iso = ms => new Date(Date.now() + ms).toISOString();

const profile = async credits => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,$2)', [id, credits]);
  return id;
};
const addCredits = (user, n) => c.query('UPDATE profiles SET credits=credits+$2 WHERE id=$1', [user, n]);
const pack = async (user, credits, key = 'pay-common:package:', at = iso(0)) => {
  const item = randomUUID(), order = randomUUID();
  await c.query('INSERT INTO credit_packages(id,name,credits_amount,price,bonus_credits) VALUES($1,$2,$3,10,0)', [item, 'Fixture ' + item, credits]);
  const snap = { version: 1, item_type: 'credit_package', item_id: item, item_updated_at: '2026-10-01T00:00:00Z',
    billing_cycle: 'one_time', currency: 'usd', unit: 'major', price: '10', discount: '0', tax_behavior: 'inclusive',
    credits, bonus_credits: 0 };
  await c.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
    payment_channel,merchant_namespace,payment_mode,purchase_request_id,purchase_payload_hash,purchase_snapshot,
    amount_total,currency,fulfilled_at,metadata) VALUES($1,$2,'credit_package',$3,'one_time','payment','completed','paid',
    'stripe','acct_fixture','test',gen_random_uuid(),repeat('a',64),$4,1000,'usd',$5,jsonb_build_object('grantedCredits',$6::int))`,
  [order, user, item, snap, at, credits]);
  await addCredits(user, credits);
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key,created_at)
    VALUES($1,$2,'purchase','grant',$3,$4,$5)`, [user, credits, order, key + order, at]);
  // Before 0275 (backfill rehearsal) the source table does not exist yet.
  const exists = await v("SELECT to_regclass('public.credit_package_sources') IS NOT NULL v");
  return { order, source: exists ? await v('SELECT id v FROM credit_package_sources WHERE order_id=$1', [order]) : null };
};
const period = async (user, credits, startMs, endMs, consumed = 0) => {
  const grant = randomUUID(), subscription = 'sub_' + randomUUID(), invoice = 'in_' + randomUUID();
  const start = iso(startMs), end = iso(endMs);
  await c.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES($1,'Local fixture','pro',true,true,500000000) ON CONFLICT(level) DO NOTHING`, [randomUUID()]);
  const plan = await v("SELECT id v FROM membership_plans WHERE level='pro'");
  await c.query(`INSERT INTO user_subscriptions(user_id,stripe_subscription_id,membership_plan_id,billing_cycle,
    current_period_start,current_period_end,status) VALUES($1,$2,$3,'monthly',$4,$5,'active')`,
  [user, subscription, plan, start, end]);
  await c.query(`INSERT INTO subscription_credit_grants(id,user_id,stripe_subscription_id,membership_plan_id,billing_cycle,
    grant_type,grant_period_key,period_start,period_end,total_periods,stripe_invoice_id,credits_granted,consumed_amount,idempotency_key)
    VALUES($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,$9,$10,$11)`,
  [grant, user, subscription, plan, 'invoice:' + invoice, start, end, invoice, credits, consumed, 'grant:' + invoice]);
  await addCredits(user, credits - consumed);
  return { grant, subscription };
};
const reserve = async (user, n, client = c) =>
  v("SELECT pre_deduct_id v FROM atomic_pre_deduct($1,$2,'fixture',gen_random_uuid())", [user, n], client);
const settle = (user, pre, actual) => c.query('SELECT * FROM bill2_legacy_settle($1,$2,$3)', [user, pre, actual]);
const refund = (user, pre) => c.query('SELECT * FROM bill2_legacy_refund($1,$2)', [user, pre]);
const abort = (user, pre, used) => c.query("SELECT * FROM bill2_legacy_abort_settle($1,$2,$3,'{}'::jsonb,'fixture-model')", [user, pre, used]);
const balance = user => v('SELECT credits v FROM profiles WHERE id=$1', [user]);
const packUsed = source => v('SELECT consumed_amount v FROM credit_package_sources WHERE id=$1', [source]);
const grantUsed = grant => v('SELECT consumed_amount v FROM subscription_credit_grants WHERE id=$1', [grant]);
const unattributed = user => v(`SELECT coalesce(sum(amount),0)::int v FROM credit_source_entries
  WHERE user_id=$1 AND source_kind='unattributed' AND applied`, [user]);
// Every source counter equals the applied movements recorded against it (packs start at 0).
const conserved = async user => {
  const bad = await v(`SELECT count(*)::int v FROM credit_package_sources s WHERE s.user_id=$1 AND s.consumed_amount<>
    coalesce((SELECT sum(amount) FROM credit_source_entries e WHERE e.source_kind='credit_package' AND e.source_id=s.id AND e.applied),0)`, [user]);
  assert.equal(bad, 0, 'pack counters match their applied entries');
  assert.equal(await v(`SELECT count(*)::int v FROM (SELECT pre_deduct_id FROM credit_source_entries WHERE user_id=$1
    AND pre_deduct_id IS NOT NULL GROUP BY pre_deduct_id,source_kind,source_id HAVING sum(amount)<0) x`, [user]), 0,
  'no reservation returns more to a source than it took');
};
const unhook = async () => {
  for (const fn of HOOKED) {
    const src = await v('SELECT pg_get_functiondef($1::regprocedure) v', ['public.' + fn]);
    const lines = src.split('\n');
    assert.equal(lines.filter(line => line.endsWith(MARK)).length, 1, fn);
    await c.query(lines.filter(line => !line.endsWith(MARK)).join('\n'));
  }
};

try {
  // Full chain applied 0275 once; a second run is a structural and data no-op.
  const after = await catalog();
  await reapply();
  assert.deepEqual(await catalog(), after);
  for (const fn of HOOKED) assert.equal(await v("SELECT (length(d)-length(replace(d,'PR-D0 credit sources','')))/20 v FROM pg_get_functiondef($1::regprocedure) d", ['public.' + fn]), 1, fn);
  report.checks.push('0275 reapplication after the full chain preserves the catalog; each of 5 functions hooked exactly once');

  // Packs from both grant paths become sources; unattributed credits are used first, then packs oldest first.
  const u1 = await profile(500);
  const a = await pack(u1, 1000, 'pay-common:package:', iso(-2 * hour));
  const b = await pack(u1, 300, 'method-package:', iso(-hour));
  assert.ok(a.source && b.source, 'both pack ledger keys create a source');
  let p = await reserve(u1, 600);
  assert.deepEqual([await balance(u1), await unattributed(u1), await packUsed(a.source), await packUsed(b.source)], [1200, 500, 100, 0]);
  await settle(u1, p, 400);
  assert.deepEqual([await balance(u1), await unattributed(u1), await packUsed(a.source)], [1400, 400, 0],
    'settle returns 200 last-taken first: pack A 100, then 100 unattributed');
  p = await reserve(u1, 100);
  await settle(u1, p, 250);
  assert.deepEqual([await balance(u1), await unattributed(u1), await packUsed(a.source)], [1150, 500, 150],
    'overrun of 150 uses the remaining 100 unattributed, then pack A');
  p = await reserve(u1, 1000);
  assert.deepEqual([await packUsed(a.source), await packUsed(b.source)], [1000, 150]);
  await refund(u1, p);
  assert.deepEqual([await balance(u1), await packUsed(a.source), await packUsed(b.source)], [1150, 150, 0], 'refund reverses its own attribution');
  p = await reserve(u1, 900);
  await abort(u1, p, 300);
  assert.deepEqual([await balance(u1), await packUsed(a.source), await packUsed(b.source)], [850, 450, 0], 'abort returns the unused 600 last-taken first');
  await conserved(u1);
  report.checks.push('pack sources (pay-common and method-package keys); reserve/settle/overrun/refund/abort attribute to unattributed first, then packs oldest first, and reverse last-taken first');

  // Cross-period: the current period is charged first (unchanged); the rest goes to an ended period's real remainder.
  const u2 = await profile(0);
  const ended = await period(u2, 1000, -60 * 24 * hour, -30 * 24 * hour, 200);
  const current = await period(u2, 100, -24 * hour, 24 * hour);
  const terminated = await period(u2, 500, -90 * 24 * hour, -61 * 24 * hour);
  await c.query('UPDATE user_subscriptions SET credit_release_terminated_at=now() WHERE stripe_subscription_id=$1', [terminated.subscription]);
  p = await reserve(u2, 300);
  assert.deepEqual([await grantUsed(current.grant), await grantUsed(ended.grant), await grantUsed(terminated.grant)], [100, 400, 0],
    'current period 100, ended period 200, quarantined terminated period untouched');
  await settle(u2, p, 150);
  assert.deepEqual([await grantUsed(current.grant), await grantUsed(ended.grant)], [100, 250], 'settle returns 150 to the ended period first');
  await refund(u2, await reserve(u2, 50));
  assert.deepEqual([await balance(u2), await grantUsed(current.grant), await grantUsed(ended.grant)], [1250, 100, 250]);
  // A reservation restored after its source was reversed leaves the credits unattributed (never resurrects the source).
  p = await reserve(u2, 100);
  assert.equal(await grantUsed(ended.grant), 350);
  await c.query("UPDATE subscription_credit_grants SET status='reversed' WHERE id=$1", [ended.grant]);
  await refund(u2, p);
  assert.deepEqual([await grantUsed(ended.grant), await v(`SELECT applied v FROM credit_source_entries WHERE pre_deduct_id=$1 AND amount<0`, [p])],
    [350, false], 'restore to a reversed period is recorded as not applied');
  report.checks.push('subscription cross-period consumption recorded on the ended period; terminated periods stay quarantined; reversed sources never resurrect');

  // Pack refund claim and failed-refund restoration follow the ledger rows.
  const u3 = await profile(0);
  const r = await pack(u3, 200);
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,source_order_id,idempotency_key)
    VALUES($1,-200,'deduction','refund_clawback','refund_clawback','stripe_refund',$2,'pay-common:refund:'||gen_random_uuid())`, [u3, r.order]);
  assert.equal(await v('SELECT status v FROM credit_package_sources WHERE id=$1', [r.source]), 'reversed');
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,source_order_id,idempotency_key)
    VALUES($1,200,'refund','adjustment','refund_failed_restore','stripe_refund',$2,'pay-common:refund-restore:'||gen_random_uuid())`, [u3, r.order]);
  assert.equal(await v('SELECT status v FROM credit_package_sources WHERE id=$1', [r.source]), 'granted');
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key)
    VALUES($1,200,'purchase','grant',$2,$3)`, [u3, r.order, 'pay-common:package:' + r.order + ':other']);
  assert.equal(await v('SELECT count(*)::int v FROM credit_package_sources WHERE order_id=$1', [r.order]), 1, 'other keys never create a source');
  // External (Link) refund of a pack ends the order without a clawback: the pack is held back, not consumed.
  const u6 = await profile(50);
  const ext = await pack(u6, 100);
  p = await reserve(u6, 20);
  await c.query("UPDATE payment_orders SET status='refunded',payment_status='refunded' WHERE id=$1", [ext.order]);
  // 0285: the held pack is out of the spendable balance, so only the 30 unattributed credits can be reserved.
  await assert.rejects(() => reserve(u6, 40), /PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED/);
  const p2 = await reserve(u6, 30);
  assert.deepEqual([await balance(u6), await packUsed(ext.source), await unattributed(u6)], [100, 0, 50],
    'after the external refund only the 30 unattributed credits are used; the pack stays held');
  assert.equal(await v("SELECT count(*)::int v FROM credit_source_entries WHERE pre_deduct_id=$1 AND NOT applied", [p2]), 0,
    'nothing beyond the unattributed balance is taken');
  await refund(u6, p2);
  assert.deepEqual([await packUsed(ext.source), await unattributed(u6)], [0, 20],
    'refund reverses the 30 attributed and the 10 unattributable credits separately');
  assert.equal(await v("SELECT coalesce(sum(amount),0)::int v FROM credit_source_entries WHERE pre_deduct_id=$1 AND NOT applied", [p2]), 0);
  report.checks.push('pack refund clawback reverses the source, failed-refund restoration re-grants it, unrelated keys are ignored;'
    + ' an externally refunded pack (no clawback) is held back and never consumed');

  // Compensation after settlement returns the other part to the pack it came from.
  const u4 = await profile(0);
  const k = await pack(u4, 100);
  p = await reserve(u4, 40);
  await settle(u4, p, 40);
  const call = randomUUID(), run = randomUUID();
  const runRow = { id: run, actor_id: u4, closed: true, outcome: 'confirmed_failure' };
  const callRow = { id: call, run_id: run, pre_deduct_id: p, settled_at: new Date().toISOString(), charged_delta: 40 };
  await c.query("ALTER TABLE credit_transactions DISABLE TRIGGER ALL");
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,bill2_call_id,idempotency_key)
    VALUES($1,0,'adjustment','spend','bill2_spend',$2,$3)`, [u4, call, 'fixture-spend:' + call]);
  // Synthetic run/call rows exist only as records: foreign-key triggers stay off for this one call.
  assert.equal(await v('SELECT bill2_payg_compensate(jsonb_populate_record(NULL::bill2_runs,$1),jsonb_populate_record(NULL::bill2_calls,$2)) v',
    [runRow, callRow]), 40);
  await c.query("ALTER TABLE credit_transactions ENABLE TRIGGER ALL");
  assert.deepEqual([await balance(u4), await packUsed(k.source)], [100, 0], 'compensation returns 40 to the pack');
  await conserved(u4);
  report.checks.push('PAYG confirmed-failure compensation returns the other part to its original pack');

  // Concurrency: two sessions reserve for the same user at once; the profile lock serialises attribution.
  const u5 = await profile(100);
  const q = await pack(u5, 100);
  const sessions = [new pg.Client(c.connectionParameters), new pg.Client(c.connectionParameters)];
  await Promise.all(sessions.map(s => s.connect()));
  try {
    await Promise.all(sessions.map(async s => { await s.query('BEGIN'); await reserve(u5, 80, s); await new Promise(t => setTimeout(t, 50)); await s.query('COMMIT'); }));
  } finally { await Promise.all(sessions.map(s => s.end())); }
  assert.deepEqual([await balance(u5), await unattributed(u5), await packUsed(q.source)], [40, 100, 60]);
  await conserved(u5);
  report.checks.push('concurrent reservations: 100 unattributed then 60 from the pack, no double attribution');

  // Balance results are identical with and without the hooks (same scenario on the predecessor functions).
  const scenario = async () => {
    const u = await profile(300); await pack(u, 500, 'pay-common:package:', iso(-hour)); await period(u, 200, -24 * hour, 24 * hour);
    const out = [];
    let x = await reserve(u, 600); await settle(u, x, 650); out.push(await balance(u));
    x = await reserve(u, 100); await refund(u, x); out.push(await balance(u));
    x = await reserve(u, 200); await abort(u, x, 50); out.push(await balance(u));
    out.push(await v("SELECT jsonb_agg(jsonb_build_array(operation_type,amount) ORDER BY created_at) v FROM billing_history WHERE user_id=$1", [u]));
    out.push(await eligibility());
    return out;
  };
  // Refund eligibility (pack and first-month subscription), fresh and after one settled use.
  const outcome = async (sql, args) => {
    try { const q = await v(sql, args); return ['ok', q.credits, q.netMinor ?? null, q.feeMinor ?? null]; }
    catch (error) { return ['refused', error.message]; }
  };
  // One settled use, with the spend row BILL2 writes alongside it.
  // The monthly fixture's period is not a canonical pre-deduct window (before and after 0275), so it records the spend row only.
  const use = async (user, reservation = true) => {
    if (reservation) await settle(user, await reserve(user, 10), 10);
    await c.query("INSERT INTO credit_transactions(user_id,amount,type,ledger_type) VALUES($1,-10,'deduction','spend')", [user]);
  };
  const eligibility = async () => {
    const out = [];
    for (const used of [false, true]) {
      const f = await v('SELECT refund_test.fixture() v');
      if (used) await use(f.user);
      out.push(await outcome('SELECT pay_common_package_refund_quote($1,$2,$3,$4,$5,$6) v',
        [f.actor, f.order, f.ticket, f.cash, 'confirmed', 'fixture:law']));
      const m = await v('SELECT monthly_test.fixture() v');
      if (used) await use(m.user, false);
      out.push(await outcome('SELECT pay_common_monthly_refund_approve($1,$2,$3,$4) v', [m.actor, m.order, m.terms, 'a'.repeat(64)]));
    }
    assert.equal(out[0][0], 'ok', JSON.stringify(out));
    assert.equal(out[2][0], 'refused', JSON.stringify(out));
    return out;
  };
  await c.query(read('packages/db/tests/package-refund/fixture.sql'));
  await c.query(read('packages/db/tests/monthly-refund/fixture.sql'));
  const hooked = await scenario();
  await unhook();
  const before = await scenario();
  assert.deepEqual(hooked, before, 'balances, billing history amounts and refund eligibility unchanged');
  // Recovery is the predecessor definitions; re-applying 0275 hooks them again without re-running the backfill.
  await reapply();
  assert.deepEqual(await catalog(), after);
  report.checks.push('same balances, per-step charges and pack/monthly refund eligibility (fresh: allowed; after use: refused) with and without the hooks; recovery = predecessor definitions, reapply restores the exact catalog');

  // Backfill on a database that predates 0275: provable sources tracked, others marked "source unknown".
  await unhook();
  await c.query('DROP TABLE credit_source_entries, credit_source_reviews, credit_package_sources');
  await c.query('DROP TRIGGER credit_package_source_track ON credit_transactions');
  // Before 0275 the 0285 refund-hold lines do not exist either.
  for (const fn of ['atomic_pre_deduct(uuid,integer,text,uuid)', 'bill2_payg_claim(uuid,uuid,integer,jsonb)']) {
    const src = await v('SELECT pg_get_functiondef($1::regprocedure) v', ['public.' + fn]);
    await c.query(src.split('\n').filter(line => !line.endsWith('-- PAY-REFUND-HOLD')).join('\n'));
  }
  const clean = await profile(0), clean2 = await profile(0), spent = await profile(0);
  const cleanPack = (await pack(clean, 100)).order;
  const cleanGrant = await period(clean2, 300, -60 * 24 * hour, -30 * 24 * hour, 100);
  const spentPack = (await pack(spent, 100, 'method-package:', iso(-hour))).order;
  await reserve(spent, 10);
  const adjusted = await profile(0);
  const adjustedPack = (await pack(adjusted, 100)).order;
  await c.query("SELECT * FROM atomic_apply_credit_ledger_entry($1::uuid,-5,'deduction','Synthetic admin deduction',$2)", [adjusted, 'test-admin:' + adjusted]);
  await reapply();
  const reviewed = async (kind, id) => v('SELECT count(*)::int v FROM credit_source_reviews WHERE source_kind=$1 AND source_id=$2', [kind, id]);
  const sourceOf = order => v('SELECT id v FROM credit_package_sources WHERE order_id=$1', [order]);
  assert.equal(await reviewed('credit_package', await sourceOf(cleanPack)), 0);
  assert.equal(await reviewed('subscription_grant', cleanGrant.grant), 0);
  assert.equal(await reviewed('credit_package', await sourceOf(spentPack)), 1, 'spent outside a period after the pack: source unknown');
  assert.equal(await reviewed('credit_package', await sourceOf(adjustedPack)), 1, 'an order-less deduction after the pack: source unknown');
  // A source unknown is never consumed and stays inside the unattributed balance.
  const before2 = await v('SELECT consumed_amount v FROM credit_package_sources WHERE order_id=$1', [spentPack]);
  await reserve(spent, 50);
  assert.equal(await v('SELECT consumed_amount v FROM credit_package_sources WHERE order_id=$1', [spentPack]), before2);
  assert.equal(await unattributed(spent), 50);
  report.checks.push('first-run backfill: existing packs become sources; provable sources tracked; spent-after sources marked unknown and never consumed');

  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const fn of ['credit_source_apply(uuid,uuid,integer,text)', 'credit_source_rows(uuid)', 'credit_package_source_track()']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, 'public.' + fn]), false, `${role} ${fn}`);
    }
    for (const table of ['credit_package_sources', 'credit_source_entries', 'credit_source_reviews']) {
      assert.equal(await v("SELECT has_table_privilege($1,$2,'insert') OR has_table_privilege($1,$2,'update') v", [role, 'public.' + table]), false);
      assert.equal(await v("SELECT has_table_privilege($1,$2,'select') v", [role, 'public.' + table]), role === 'service_role');
    }
  }
  report.checks.push('no client or service role can call the helpers or write the source tables; service_role reads only');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
