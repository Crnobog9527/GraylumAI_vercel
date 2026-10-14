/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PAYWALL opening grant 500 verification (migration 0230) on the full file-built database.
// Synthetic profiles and digests only; no Auth, no network beyond the local container.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0230_opening_grant_500.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0230', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
const catalog = () => v(catalogSql);
// The 0151 definition of the helper is the recovery target: re-running it restores the 100 grant.
const old0151 = read('packages/db/migrations/0151_opening_grant_identity_digests.sql');
const restore0151 = old0151.slice(old0151.indexOf('CREATE OR REPLACE FUNCTION public.opening_grant_remember('),
  old0151.indexOf('CREATE OR REPLACE FUNCTION public.opening_grant_claim('));
const profile = async () => { const id = randomUUID(); await c.query('INSERT INTO profiles(id) VALUES($1)', [id]); return id; };
const identity = () => JSON.stringify([{ kind: 'email', key_version: 'test-v1', digest: randomBytes(32).toString('hex') }]);
const claim = async (id, digests, client = c) => {
  await client.query('BEGIN; SET LOCAL ROLE service_role');
  try {
    const granted = (await client.query('SELECT opening_grant_claim($1,$2) AS r', [id, digests])).rows[0].r.granted;
    await client.query('COMMIT');
    return granted;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
};
const balance = id => v('SELECT credits v FROM profiles WHERE id=$1', [id]);
const decisions = async id => (await c.query("SELECT amount FROM credit_transactions WHERE user_id=$1"
  + " AND idempotency_key='opening_grant:'||$1::text ORDER BY created_at", [id])).rows.map(r => r.amount);
const signature = () => v("SELECT jsonb_agg(jsonb_build_object('fn',p.oid::regprocedure::text,'ret',pg_get_function_result(p.oid),"
  + "'definer',p.prosecdef,'acl',coalesce(p.proacl::text,''),'config',p.proconfig) ORDER BY p.oid::regprocedure::text) v"
  + " FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('opening_grant_remember','opening_grant_claim')");

try {
  // Full chain already applied 0230 once; a second run must leave the complete catalog unchanged.
  const after = await catalog(), shape = await signature();
  await c.query(read(migrationPath));
  assert.deepEqual(await catalog(), after);
  report.checks.push('0230 reapplication after the full chain preserves the complete catalog');

  // Existing accounts: granted (100) or denied before 0230 are neither topped up nor changed.
  await c.query(restore0151);
  assert.notDeepEqual(await catalog(), after, '0151 helper differs from 0230 only by the amount');
  assert.deepEqual(await signature(), shape, 'same signature, return type, definer flag and privileges');
  const oldDigests = identity();
  const [legacy, legacyDenied, untouched] = [await profile(), await profile(), await profile()];
  assert.equal(await claim(legacy, oldDigests), true);
  assert.equal(await claim(legacyDenied, oldDigests), false);
  await c.query("SELECT * FROM atomic_apply_credit_ledger_entry($1::uuid,50,'purchase','Synthetic purchase','test-purchase:'||$1::text)", [untouched]);
  const ledgerBefore = await v('SELECT jsonb_agg(t ORDER BY t.id) v FROM credit_transactions t');
  const profilesBefore = await v('SELECT jsonb_agg(jsonb_build_object(\'id\',id,\'credits\',credits) ORDER BY id) v FROM profiles');
  await c.query(read(migrationPath));
  assert.deepEqual(await catalog(), after, 'recovery to 0151 then reapplying 0230 returns the exact catalog');
  assert.deepEqual(await v('SELECT jsonb_agg(t ORDER BY t.id) v FROM credit_transactions t'), ledgerBefore, 'migration writes no ledger row');
  assert.deepEqual(await v('SELECT jsonb_agg(jsonb_build_object(\'id\',id,\'credits\',credits) ORDER BY id) v FROM profiles'),
    profilesBefore, 'migration changes no balance');
  assert.equal(await claim(legacy, oldDigests), false);
  assert.equal(await claim(legacyDenied, oldDigests), false);
  assert.deepEqual([await balance(legacy), await balance(legacyDenied), await balance(untouched)], [100, 0, 50]);
  assert.deepEqual(await decisions(legacy), [100]);
  assert.deepEqual(await decisions(legacyDenied), [0]);
  // An account that bought credits but never claimed is still a new decision: it gets the grant once.
  assert.equal(await claim(untouched, identity()), true);
  assert.equal(await balance(untouched), 550);
  report.checks.push('existing granted (100) and denied (0) accounts keep balance and single decision after 0230 and re-claim;'
    + ' migration writes no rows; recovery = re-run the 0151 helper, reapply returns the exact catalog with the same signature/ACL');

  // New account: 500 once; repeat claims and the same identity on a new profile do not grant again.
  const digests = identity();
  const fresh = await profile();
  assert.equal(await claim(fresh, digests), true);
  assert.equal(await balance(fresh), 500);
  assert.equal(await claim(fresh, digests), false);
  assert.equal(await claim(fresh, identity()), false, 'changed identity on the same profile');
  assert.equal(await balance(fresh), 500);
  assert.deepEqual(await decisions(fresh), [500]);
  const row = (await c.query("SELECT amount,type,balance_before::int,balance_after::int FROM credit_transactions"
    + " WHERE idempotency_key='opening_grant:'||$1::text", [fresh])).rows[0];
  assert.deepEqual(row, { amount: 500, type: 'addition', balance_before: 0, balance_after: 500 });
  const sameIdentity = await profile();
  assert.equal(await claim(sameIdentity, digests), false);
  assert.equal(await balance(sameIdentity), 0);
  assert.deepEqual(await decisions(sameIdentity), [0]);
  report.checks.push('new profile gets exactly 500 once; repeat claim, changed identity and same identity on another profile get nothing');

  // Concurrency: same identity on two new profiles, and the same profile twice, each grant exactly once.
  for (const sameProfile of [false, true]) {
    const shared = identity();
    const ids = sameProfile ? [await profile()] : [await profile(), await profile()];
    const sessions = [new pg.Client(c.connectionParameters), new pg.Client(c.connectionParameters)];
    await Promise.all(sessions.map(s => s.connect()));
    try {
      const results = await Promise.all(sessions.map((s, i) => claim(ids[i % ids.length], shared, s)));
      assert.equal(results.filter(Boolean).length, 1, sameProfile ? 'same profile' : 'same identity');
    } finally { await Promise.all(sessions.map(s => s.end())); }
    const balances = await Promise.all(ids.map(balance));
    assert.equal(balances.reduce((a, b) => a + b, 0), 500);
    for (const id of ids) assert.equal((await decisions(id)).length, 1);
  }
  report.checks.push('concurrent claims (same identity on two profiles; same profile twice) issue exactly one 500 grant');

  for (const role of ['anon', 'authenticated']) {
    for (const fn of ['opening_grant_claim(uuid,jsonb)', 'opening_grant_remember(uuid,jsonb,boolean)']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, fn]), false, `${role} ${fn}`);
    }
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','opening_grant_claim(uuid,jsonb)','execute') v"), true);
  assert.equal(await v("SELECT has_function_privilege('service_role','opening_grant_remember(uuid,jsonb,boolean)','execute') v"), false);
  report.checks.push('clients cannot call either function; service_role only through opening_grant_claim');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
