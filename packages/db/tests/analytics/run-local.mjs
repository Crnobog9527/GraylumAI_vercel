/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only ANALYTICS 0286 verification: GA checkout ids stored only in the right shape for the buyer's own unpaid
// order, taken at most once (also under concurrency), withheld after a consent withdrawal, expired after 72 hours,
// grants, and account-erasure cleanup.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0286_analytics_purchase_report.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0286', checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const ok = (name) => report.checks.push(name);
const connect = async () => { const x = new pg.Client(c.connectionParameters); await x.connect(); return x; };
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  ok('reapplication after the full chain preserves the complete catalog');

  const fns = ['analytics_store_checkout_ids(uuid,uuid,text,text)', 'analytics_take_checkout_ids(uuid)',
    'analytics_withdraw_consent(uuid)', 'analytics_prune_checkout_ids()'];
  for (const f of fns) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
    assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true, f);
  }
  for (const t of ['analytics_checkout_ids', 'analytics_consent_withdrawals']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(await v('SELECT has_table_privilege($1,$2,$3) v', [role, t, p]), false, `${role} ${t} ${p}`);
      }
    }
    assert.equal(await v('SELECT relrowsecurity v FROM pg_class WHERE oid=$1::regclass', [t]), true);
  }
  for (const role of ['anon', 'authenticated']) {
    await c.query(`SET ROLE ${role}`);
    try { await code(c.query('SELECT analytics_take_checkout_ids($1)', [randomUUID()]), '42501'); }
    finally { await c.query('RESET ROLE'); }
  }
  ok('clients have no table or function access; service_role only through the four functions; RLS on');

  // Fixtures: the purchase contracts are covered by the pay-waffo suites; only order ownership and fulfilment matter.
  for (const { conname } of (await c.query("SELECT conname FROM pg_constraint WHERE conrelid='payment_orders'::regclass"
    + " AND contype='c'")).rows) await c.query(`ALTER TABLE public.payment_orders DROP CONSTRAINT ${JSON.stringify(conname)}`);
  const bypass = async work => {
    await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role='replica'");
    try { const result = await work(); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
  };
  const profile = async () => {
    const id = randomUUID();
    await c.query("INSERT INTO profiles(id,credits,role,email) VALUES($1,0,'user',$2)", [id, `${id.slice(0, 8)}@analytics.test`]);
    return id;
  };
  const order = (user, fulfilled = false) => bypass(async () => {
    const id = randomUUID();
    await c.query(`INSERT INTO payment_orders(id,user_id,item_type,item_id,billing_cycle,amount_total,currency,mode,status,
      payment_status,payment_channel,payment_mode,payment_method,fulfilled_at)
      VALUES($1,$2,'credit_package',$3,'one_time',1799,'usd','payment',$4,$5,'stripe','test','card',$6)`,
    [id, user, randomUUID(), fulfilled ? 'completed' : 'pending', fulfilled ? 'paid' : 'unpaid', fulfilled ? new Date() : null]);
    return id;
  });
  const store = (u, o, client = '123456789.1700000000', session = '1700000000') =>
    v('SELECT analytics_store_checkout_ids($1,$2,$3,$4) v', [u, o, client, session]);
  const take = (o, client = c) => v('SELECT analytics_take_checkout_ids($1) v', [o], client);
  const rows = u => v('SELECT count(*)::int v FROM analytics_checkout_ids WHERE user_id=$1', [u]);

  const buyer = await profile(), other = await profile();
  const unpaid = await order(buyer), paid = await order(buyer, true);
  for (const [client, session] of [['someone@example.com', '1'], ['1.2', 'abc'], ['1'.repeat(21) + '.1', '1'], ['1.1', '1'.repeat(21)],
    ['Alice.Smith', '1'], [null, '1']]) {
    assert.equal(await store(buyer, unpaid, client, session), false, `${client}/${session}`);
  }
  assert.equal(await store(other, unpaid), false, 'someone else\'s order');
  assert.equal(await store(buyer, paid), false, 'an already fulfilled order');
  assert.equal(await store(buyer, randomUUID()), false, 'an unknown order');
  assert.equal(await rows(buyer), 0);
  ok('refused without storing: malformed or forged ids, another user\'s order, fulfilled or unknown order');

  assert.equal(await store(buyer, unpaid), true);
  assert.equal(await store(buyer, unpaid, '987.654', '42'), true, 'a repeated checkout replaces the ids');
  assert.deepEqual(await take(unpaid), { clientId: '987.654', sessionId: '42' });
  assert.equal(await take(unpaid), null, 'a replay gets nothing');
  assert.equal(await rows(buyer), 0);
  ok('take returns the ids once and clears them; a replay gets nothing');

  // Concurrent deliveries of the same order (checkout.session.completed and invoice.paid): exactly one report.
  const raced = await order(buyer);
  await store(buyer, raced);
  const [one, two] = [await connect(), await connect()];
  try {
    const results = await Promise.all([take(raced, one), take(raced, two)]);
    assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results));
  } finally { await one.end(); await two.end(); }
  ok('two concurrent takes of one order: exactly one gets the ids');

  // Withdrawal: every id not yet taken goes, and ids written before the withdrawal are never returned.
  const a = await order(buyer), b = await order(buyer);
  await store(buyer, a); await store(buyer, b);
  await v('SELECT analytics_withdraw_consent($1) v', [buyer]);
  assert.equal(await rows(buyer), 0);
  assert.equal(await take(a), null);
  // A lost clean-up request: the row survives but predates the recorded withdrawal (backdated here), so it is withheld.
  await store(buyer, a);
  await c.query("UPDATE analytics_checkout_ids SET created_at=clock_timestamp()-interval '1 minute' WHERE order_id=$1", [a]);
  await c.query('UPDATE analytics_consent_withdrawals SET withdrawn_at=clock_timestamp() WHERE user_id=$1', [buyer]);
  assert.equal(await take(a), null, 'written before the withdrawal: not reported');
  assert.equal(await rows(buyer), 0, 'and cleared anyway');
  // Consent given again later: a new checkout is reported.
  await store(buyer, b);
  assert.deepEqual(await take(b), { clientId: '123456789.1700000000', sessionId: '1700000000' });
  ok('withdrawal clears pending ids; ids older than the last withdrawal are withheld; renewed consent reports again');

  // Withdrawal racing the payment: either not reported or reported once, and nothing is left.
  for (let i = 0; i < 5; i++) {
    const raceOrder = await order(other);
    await v('SELECT analytics_withdraw_consent($1) v', [randomUUID()]);
    await store(other, raceOrder);
    const [x, y] = [await connect(), await connect()];
    try {
      const [taken] = await Promise.all([take(raceOrder, x), v('SELECT analytics_withdraw_consent($1) v', [other], y)]);
      assert.ok(taken === null || taken.clientId === '123456789.1700000000');
    } finally { await x.end(); await y.end(); }
    assert.equal(await rows(other), 0);
  }
  ok('withdrawal racing a take: at most one report, both tables leave no pending id');

  const stale = await order(other), fresh = await order(other);
  await store(other, stale); await store(other, fresh);
  await c.query("UPDATE analytics_checkout_ids SET created_at=clock_timestamp()-interval '73 hours' WHERE order_id=$1", [stale]);
  assert.equal(await v('SELECT analytics_prune_checkout_ids() v'), 1);
  assert.equal(await take(stale), null);
  assert.ok(await take(fresh));
  ok('daily prune deletes ids older than 72 hours and keeps newer ones');

  // Account erasure: a closing account stores and reports nothing; both tables are pruned with the account.
  const leaving = await profile();
  const leavingOrder = await order(leaving), leavingOther = await order(leaving);
  await store(leaving, leavingOrder); await store(leaving, leavingOther);
  await v('SELECT analytics_withdraw_consent($1) v', [leaving]);
  await store(leaving, leavingOrder);
  const remaining = u => v('SELECT account_erasure_business_remaining($1)::int v', [u]);
  await v('SELECT account_erasure_confirm($1,$2) v', [leaving, randomUUID()]);
  const beforeErase = await remaining(leaving);
  assert.equal(await store(leaving, leavingOther), false, 'a closing account stores nothing');
  assert.equal(await v('SELECT analytics_take_checkout_ids($1) IS NULL v', [leavingOrder]), true, 'and is never reported');
  await store(buyer, await order(buyer));
  await v('SELECT account_erasure_prune_business($1,100) v', [leaving]);
  assert.equal(await v('SELECT count(*)::int v FROM analytics_consent_withdrawals WHERE user_id=$1', [leaving]), 0);
  assert.equal(await rows(leaving), 0);
  assert.ok(await remaining(leaving) < beforeErase, 'the withdrawal row was counted as remaining work and is gone');
  assert.equal(await rows(buyer), 1, 'other accounts are untouched');
  ok('erasure: closing accounts store and report nothing; both tables pruned with the account; others untouched');

  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  ok('account-open policy audit still returns zero rows');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
