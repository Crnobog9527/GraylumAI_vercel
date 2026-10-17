/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PAY-DISPUTE-GUARD refund hold (0284) on the full file-built database: a credit pack refunded outside
// Graylum without a clawback (0247 "pack_review") is held out of the spendable balance until a person settles it.
// Synthetic profiles and orders only; no Auth, no provider, no network beyond the local container.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0284_pay_refunded_pack_hold.sql';
const MARK = 'PAY-REFUND-HOLD';
// Function -> marked lines 0284 adds to it.
const HOOKED = { 'atomic_pre_deduct(uuid,integer,text,uuid)': 1, 'bill2_payg_claim(uuid,uuid,integer,jsonb)': 1,
  'credit_source_apply(uuid,uuid,integer,text)': 2 };
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0284', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
const catalog = () => v(fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;');
const hour = 3600000, iso = ms => new Date(Date.now() + ms).toISOString();

const profile = async credits => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,$2)', [id, credits]);
  return id;
};
// A paid international-card credit pack, granted the way 0211 grants it ('method-package:'), with its payment and
// tax recorded so the real 0247 external-refund function accepts it.
const pack = async (user, credits, at = iso(0)) => {
  const item = randomUUID(), order = randomUUID(), payment = 'pi_' + order.replaceAll('-', '');
  await c.query('INSERT INTO credit_packages(id,name,credits_amount,price,bonus_credits) VALUES($1,$2,$3,10,0)', [item, 'Fixture ' + item, credits]);
  const snap = { version: 1, item_type: 'credit_package', item_id: item, item_updated_at: '2026-10-01T00:00:00Z',
    billing_cycle: 'one_time', currency: 'usd', unit: 'major', price: '10', discount: '0', tax_behavior: 'inclusive',
    credits, bonus_credits: 0 };
  await c.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,mode,status,payment_status,
    payment_channel,merchant_namespace,payment_mode,payment_method,purchase_request_id,purchase_payload_hash,purchase_snapshot,
    amount_total,currency,fulfilled_at,payment_amount_facts,metadata,routing_version,terms_version,terms_accepted_at,auto_renew,offer_kind,
    qualification_state,stripe_managed_payments) VALUES($1,$2,'credit_package',$3,'one_time','payment','completed','paid',
    'stripe','fixture','test','card',gen_random_uuid(),repeat('a',64),$4,1000,'usd',$5,
    jsonb_build_array(jsonb_build_object('kind','tax','amount','0.00','currency','usd','unit','major','evidence_ref',$6::text)),
    jsonb_build_object('grantedCredits',$7::int),1,'terms-v1',$5,false,'standard','sold',true)`, [order, user, item, snap, at, payment, credits]);
  await c.query(`INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,order_id)
    VALUES('stripe','fixture','test','payment',$1,$2)`, [payment, order]);
  await c.query('UPDATE profiles SET credits=credits+$2 WHERE id=$1', [user, credits]);
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,source_order_id,idempotency_key,created_at)
    VALUES($1,$2,'purchase','grant',$3,$4,$5)`, [user, credits, order, 'method-package:' + order, at]);
  return { order, payment, source: await v('SELECT id v FROM credit_package_sources WHERE order_id=$1', [order]) };
};
const externalRefund = (p, refund, amount = 1000) => v(`SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,$3,$4,'usd',now()) v`,
  [p.order, p.payment, refund, amount]);
const reserve = (user, n) => v("SELECT pre_deduct_id v FROM atomic_pre_deduct($1,$2,'fixture',gen_random_uuid())", [user, n]);
const refund = (user, pre) => c.query('SELECT * FROM bill2_legacy_refund($1,$2)', [user, pre]);
const balance = user => v('SELECT credits v FROM profiles WHERE id=$1', [user]);
const packUsed = source => v('SELECT consumed_amount v FROM credit_package_sources WHERE id=$1', [source]);
const blocked = user => assert.rejects(() => reserve(user, 1), /PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED/);
// The most a single reservation can take right now (largest n that atomic_pre_deduct accepts), restored after probing.
const spendable = async user => {
  let lo = 0, hi = await balance(user);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    await c.query('BEGIN');
    try { await reserve(user, mid); lo = mid; } catch { hi = mid - 1; }
    await c.query('ROLLBACK');
  }
  return lo;
};
const settle = (actor, order, decision) => v('SELECT pay_common_pack_refund_review_settle($1,$2,$3) v', [actor, order, decision]);
const admin = async () => {
  const id = await profile(0);
  await c.query("UPDATE profiles SET role='admin',status='active' WHERE id=$1", [id]);
  return id;
};

try {
  // An externally refunded pack's unused credits are held; credits from other sources stay spendable.
  const ops = await admin();
  const u1 = await profile(50);
  const held = await pack(u1, 100, iso(-2 * hour));
  const other = await pack(u1, 200, iso(-hour));
  assert.equal(await spendable(u1), 350);
  assert.equal((await externalRefund(held, 're_hold_1')).state, 'pack_review');
  assert.deepEqual([await balance(u1), await spendable(u1)], [350, 250], 'the refunded pack (100) is held out of the balance');
  let p = await reserve(u1, 250);
  assert.deepEqual([await balance(u1), await packUsed(held.source), await packUsed(other.source)], [100, 0, 200],
    'the 50 unattributed credits and the other pack are used; the refunded pack is untouched');
  await blocked(u1);
  await refund(u1, p);
  assert.deepEqual([await balance(u1), await spendable(u1), await packUsed(other.source)], [350, 250, 0]);
  report.checks.push('refunded pack held: a reservation beyond the other credits is refused the existing way; other sources stay usable');

  // Repeated refund events (same refund replayed, a later refund on the ended order) change nothing.
  assert.equal((await externalRefund(held, 're_hold_1')).duplicate, true);
  assert.equal((await externalRefund(held, 're_hold_2', 10)).state, 'refunded');
  assert.deepEqual([await balance(u1), await spendable(u1), await packUsed(held.source)], [350, 250, 0]);
  report.checks.push('replayed and later refund events keep exactly one hold of the same size');

  // Settlement by a person. "kept": Graylum keeps the loss and the credits become ordinary balance.
  await assert.rejects(() => settle(u1, held.order, 'kept'), /PAY_PACK_REVIEW_ADMIN_REQUIRED/);
  await assert.rejects(() => settle(ops, other.order, 'kept'), /PAY_PACK_REVIEW_NOT_HELD/, 'only a held pack can be settled');
  await assert.rejects(() => settle(ops, held.order, 'maybe'), /PAY_PACK_REVIEW_DECISION/);
  const kept = await settle(ops, held.order, 'kept');
  assert.deepEqual([kept.decision, kept.duplicate, kept.creditsTakenBack], ['kept', false, 0]);
  assert.deepEqual([await balance(u1), await spendable(u1)], [350, 350], 'after "kept" the whole balance is spendable');
  assert.equal((await settle(ops, held.order, 'kept')).duplicate, true, 'repeating the same decision is a no-op');
  await assert.rejects(() => settle(ops, held.order, 'clawback'), /PAY_PACK_REVIEW_CONFLICT/, 'a decision is never changed');
  assert.equal((await externalRefund(held, 're_hold_1')).duplicate, true);
  assert.deepEqual([await balance(u1), await spendable(u1)], [350, 350], 'a replayed refund does not re-hold a settled pack');
  // The kept credits are ordinary balance, never consumed from or restored to the refunded pack.
  p = await reserve(u1, 350);
  assert.deepEqual([await packUsed(held.source), await packUsed(other.source)], [0, 200]);
  await refund(u1, p);
  report.checks.push('"kept" releases the hold once (idempotent, never changed, not re-held by refund replays)');

  // "clawback": the pack's unused credits are taken back once, never below zero; the rest stays spendable.
  const u2 = await profile(30);
  const back = await pack(u2, 100);
  await externalRefund(back, 're_back');
  assert.equal(await spendable(u2), 30);
  const taken = await settle(ops, back.order, 'clawback');
  assert.deepEqual([taken.creditsTakenBack, taken.creditsShortfall, await balance(u2), await spendable(u2)], [100, 0, 30, 30]);
  assert.equal((await settle(ops, back.order, 'clawback')).duplicate, true);
  assert.deepEqual([await balance(u2), await v('SELECT status v FROM credit_package_sources WHERE id=$1', [back.source])], [30, 'reversed']);
  assert.equal(await v(`SELECT count(*)::int v FROM credit_transactions WHERE source_order_id=$1 AND ledger_type='refund_clawback'`,
    [back.order]), 1, 'one clawback row');
  const u3 = await profile(0);
  const short = await pack(u3, 100);
  await externalRefund(short, 're_short');
  await c.query('UPDATE profiles SET credits=40 WHERE id=$1', [u3]);
  const partial = await settle(ops, short.order, 'clawback');
  assert.deepEqual([partial.creditsTakenBack, partial.creditsShortfall, await balance(u3)], [40, 60, 0], 'never below zero');
  assert.deepEqual((await v(`SELECT jsonb_agg(jsonb_build_array(amount,metadata->'creditsShortfall')) v FROM credit_transactions
    WHERE source_order_id=$1 AND ledger_type='refund_clawback'`, [short.order])), [[-40, 60]], 'the shortfall is on record');
  report.checks.push('"clawback" takes the unused pack credits back once, capped at the balance, shortfall recorded; other credits stay spendable');

  // A reservation that took pack credits before the refund and comes back afterwards returns them into the hold;
  // after a clawback they are taken back on return (never below zero), so nothing escapes the settlement.
  const u5 = await profile(0);
  const inflight = await pack(u5, 100);
  p = await reserve(u5, 30);
  await externalRefund(inflight, 're_inflight');
  assert.deepEqual([await balance(u5), await spendable(u5)], [70, 0]);
  await refund(u5, p);
  assert.deepEqual([await balance(u5), await packUsed(inflight.source), await spendable(u5)], [100, 0, 0],
    'returned credits go back into the held pack');
  const u6 = await profile(0);
  const late = await pack(u6, 100);
  p = await reserve(u6, 30);
  await externalRefund(late, 're_late');
  assert.equal((await settle(ops, late.order, 'clawback')).creditsTakenBack, 70);
  assert.equal(await balance(u6), 0);
  await refund(u6, p);
  assert.equal(await balance(u6), 0, 'credits returned after the clawback are taken back too');
  assert.deepEqual(await v(`SELECT jsonb_agg(amount ORDER BY created_at) v FROM credit_transactions WHERE source_order_id=$1
    AND ledger_type='refund_clawback'`, [late.order]), [-70, -30]);
  // The take-back is written after the caller's own ledger row: a PAYG confirmed-failure compensation records the
  // credits it restores, then the clawback takes them back, and the last row matches the balance.
  const u7 = await profile(0);
  const comp = await pack(u7, 100);
  p = await reserve(u7, 30);
  await c.query('SELECT * FROM bill2_legacy_settle($1,$2,$3)', [u7, p, 30]);
  await externalRefund(comp, 're_comp');
  assert.equal((await settle(ops, comp.order, 'clawback')).creditsTakenBack, 70);
  const call = randomUUID(), run = randomUUID();
  const runRow = { id: run, actor_id: u7, closed: true, outcome: 'confirmed_failure' };
  const callRow = { id: call, run_id: run, pre_deduct_id: p, settled_at: new Date().toISOString(), charged_delta: 30 };
  // Synthetic run/call rows exist only as records: credit_transactions triggers stay off for this one call (as in run-local.mjs).
  await c.query('ALTER TABLE credit_transactions DISABLE TRIGGER ALL');
  await c.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,bill2_call_id,idempotency_key)
    VALUES($1,0,'adjustment','spend','bill2_spend',$2,$3)`, [u7, call, 'fixture-spend:' + call]);
  assert.equal(await v('SELECT bill2_payg_compensate(jsonb_populate_record(NULL::bill2_runs,$1),jsonb_populate_record(NULL::bill2_calls,$2)) v',
    [runRow, callRow]), 30);
  await c.query('ALTER TABLE credit_transactions ENABLE TRIGGER ALL');
  // The take-back row is written last and stamped later than the caller's rows (which share now()).
  const tx = (await c.query(`SELECT amount,ledger_type,balance_before,balance_after,created_at FROM credit_transactions WHERE user_id=$1
    AND amount<>0 AND (bill2_call_id=$2 OR ledger_type='refund_clawback' AND metadata ? 'creditsReturned')`, [u7, call])).rows;
  const restored = tx.find(r => r.amount === 30), takeBack = tx.find(r => r.amount === -30);
  assert.ok(restored && takeBack, JSON.stringify(tx));
  assert.deepEqual([restored.balance_after, takeBack.balance_before, takeBack.balance_after, await balance(u7)].map(Number), [30, 30, 0, 0],
    'compensation restores 0 -> 30, then the take-back 30 -> 0: the ledger chain ends at the balance');
  assert.ok(takeBack.created_at > restored.created_at, 'the take-back comes after the compensation row');
  report.checks.push('reservations returned after the refund stay in the hold; after a clawback they are taken back at commit, after the caller\'s own ledger row (PAYG compensation)');

  // The legacy Stripe refund (0041 via 0185) already claws the whole pack back without an order-linked ledger row:
  // such a pack is not held again and cannot be clawed back a second time; other credits stay spendable.
  const u8 = await profile(40);
  const legacy = await pack(u8, 100);
  const r = await v(`SELECT to_jsonb(x) v FROM atomic_reconcile_stripe_refund($1,$2,'charge.refunded','re_legacy','succeeded',1000,'usd',
    NULL,NULL,NULL,NULL,NULL,now(),true,false) x`, [legacy.order, 'stripe-refund:' + legacy.order]);
  assert.deepEqual([r.order_status, r.clawback_amount, await balance(u8)], ['refunded', 100, 40], JSON.stringify(r));
  assert.equal(await spendable(u8), 40, 'an already clawed-back pack is not held again');
  await assert.rejects(() => settle(ops, legacy.order, 'clawback'), /PAY_PACK_REVIEW_NOT_HELD/);
  assert.equal(await balance(u8), 40);
  await c.query(read(migrationPath));
  assert.equal(await v('SELECT status v FROM credit_package_sources WHERE id=$1', [legacy.source]), 'reversed',
    'rerunning 0284 marks such a source reversed');
  report.checks.push('a pack already clawed back by the legacy Stripe refund is not held, cannot be clawed back twice, and its source is marked reversed');

  // Concurrency (two connections, each in its own transaction, both orders): the profile lock serialises the refund,
  // the settlement, reservations and returns, and every order ends in the same consistent state.
  const race = async (first, second) => {
    const sessions = [new pg.Client(c.connectionParameters), new pg.Client(c.connectionParameters)];
    await Promise.all(sessions.map(x => x.connect()));
    try {
      const run = async (x, work, delay) => {
        await new Promise(t => setTimeout(t, delay));
        await x.query('BEGIN');
        try { await work(x); await new Promise(t => setTimeout(t, 80)); await x.query('COMMIT'); return 'ok'; }
        catch (error) { await x.query('ROLLBACK'); return error.message; }
      };
      return await Promise.all([run(sessions[0], first, 0), run(sessions[1], second, 20)]);
    } finally { await Promise.all(sessions.map(x => x.end())); }
  };
  const on = x => ({
    reserve: (user, n) => x.query("SELECT * FROM atomic_pre_deduct($1,$2,'fixture',gen_random_uuid())", [user, n]),
    refundEvent: (pk, id) => x.query(`SELECT pay_stripe_mp_record_external_refund($1,'fixture',$2,$3,1000,'usd',now())`, [pk.order, pk.payment, id]),
    restore: (user, pre) => x.query('SELECT * FROM bill2_legacy_refund($1,$2)', [user, pre]),
    settle: order => x.query("SELECT pay_common_pack_refund_review_settle($1,$2,'clawback')", [ops, order]),
  });
  const holdOf = user => v('SELECT credit_package_refund_hold($1) v', [user]);
  for (const reserveFirst of [true, false]) {
    // A reservation races the external refund: it either went first (and the hold is the pack's remainder) or it is
    // refused because the pack's credits are already held.
    const u = await profile(50), pk = await pack(u, 100), tag = 're_race_a_' + reserveFirst;
    const reserveWork = x => on(x).reserve(u, 120), refundWork = x => on(x).refundEvent(pk, tag);
    const [a, b] = reserveFirst ? await race(reserveWork, refundWork) : await race(refundWork, reserveWork);
    const reserved = reserveFirst ? a : b;
    assert.equal(reserveFirst ? b : a, 'ok');
    const [bal, used, hold] = [await balance(u), await packUsed(pk.source), await holdOf(u)];
    // The first transaction holds its locks for 80 ms, so the order is the one requested.
    assert.equal(reserved === 'ok', reserveFirst, reserved);
    if (reserved === 'ok') assert.deepEqual([bal, used, hold], [30, 70, 30], 'reservation first: 50 unattributed + 70 pack');
    else {
      assert.match(reserved, /PRE_DEDUCT_TERMINATED_GRANT_REMAINDER_QUARANTINED/);
      assert.deepEqual([bal, used, hold], [150, 0, 100], 'refund first: the reservation needed held credits');
    }
    assert.equal(await spendable(u), bal - hold);
  }
  for (const restoreFirst of [true, false]) {
    // A reservation's return races the clawback: either way all 100 pack credits are taken back exactly once.
    const u = await profile(0), pk = await pack(u, 100);
    const pre = await reserve(u, 30);
    await externalRefund(pk, 're_race_b_' + restoreFirst);
    const restoreWork = x => on(x).restore(u, pre), settleWork = x => on(x).settle(pk.order);
    const results = restoreFirst ? await race(restoreWork, settleWork) : await race(settleWork, restoreWork);
    assert.deepEqual(results, ['ok', 'ok']);
    const taken = await v(`SELECT coalesce(sum(amount),0)::int v FROM credit_transactions WHERE source_order_id=$1
      AND ledger_type='refund_clawback'`, [pk.order]);
    // Return first: one clawback of all 100; clawback first: 70 now, the returned 30 at the return's commit.
    assert.deepEqual(await v(`SELECT jsonb_agg(amount ORDER BY created_at) v FROM credit_transactions WHERE source_order_id=$1
      AND ledger_type='refund_clawback'`, [pk.order]), restoreFirst ? [-100] : [-70, -30]);
    const src = (await c.query('SELECT status,refund_review,refund_clawback_due FROM credit_package_sources WHERE id=$1', [pk.source])).rows[0];
    assert.deepEqual([await balance(u), taken, await holdOf(u), src.status, src.refund_review, src.refund_clawback_due],
      [0, -100, 0, 'reversed', 'clawback', 0], restoreFirst ? 'return first' : 'clawback first');
  }
  report.checks.push('two-connection races (both orders): reservation vs external refund, reservation return vs clawback end consistent');

  // A pack whose remainder cannot be proven (0275 "source unknown") is alert-only: never held, never clawed back
  // from the balance (PAY-DISPUTE-GUARD 4.3: never take other sources' credits); "kept" can still close the review.
  const u4 = await profile(20);
  const unknown = await pack(u4, 100);
  await c.query(`INSERT INTO credit_source_reviews(source_kind,source_id,reason) VALUES('credit_package',$1,'pre_attribution_consumption')`,
    [unknown.source]);
  await externalRefund(unknown, 're_unknown');
  assert.equal(await spendable(u4), 120, 'a source-unknown refunded pack is not held');
  await assert.rejects(() => settle(ops, unknown.order, 'clawback'), /PAY_PACK_REVIEW_SOURCE_UNKNOWN/);
  assert.equal(await balance(u4), 120);
  assert.equal((await settle(ops, unknown.order, 'kept')).decision, 'kept');
  assert.equal(await spendable(u4), 120);
  report.checks.push('a source-unknown refunded pack is alert-only: not held, clawback refused (nothing taken), "kept" allowed');

  // Privileges: only the service role may settle; nobody calls the hold helper directly.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await v("SELECT has_function_privilege($1,'public.credit_package_refund_hold(uuid)','execute') v", [role]), false, role);
    assert.equal(await v("SELECT has_function_privilege($1,'public.credit_package_refund_held(uuid)','execute') v", [role]), false, role);
    assert.equal(await v("SELECT has_function_privilege($1,'public.credit_package_refund_late_clawback(uuid,uuid,integer)','execute') v",
      [role]), false, role);
    assert.equal(await v("SELECT has_function_privilege($1,'public.pay_common_pack_refund_review_settle(uuid,uuid,text)','execute') v",
      [role]), role === 'service_role', role);
  }
  report.checks.push('settlement is service-role only; the hold and late-clawback helpers are not callable by any client role');

  // Reapplying 0284 after the full chain is a structural no-op; each hooked function carries the marker once.
  const after = await catalog();
  await c.query(read(migrationPath));
  assert.deepEqual(await catalog(), after);
  for (const [fn, lines] of Object.entries(HOOKED)) {
    const src = await v('SELECT pg_get_functiondef($1::regprocedure) v', ['public.' + fn]);
    assert.equal(src.split(MARK).length - 1, lines, fn);
  }
  report.checks.push('0284 reapplication after the full chain preserves the catalog; both reservation paths and the restore path hooked exactly once');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
