/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only ANALYTICS 0287 verification: profiles.signup_attribution written once through the service function,
// shape re-checked, clients cannot write it, account erasure clears it and refuses a refill, admin aggregates.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0287_analytics_signup_attribution.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0287', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const ok = (name) => report.checks.push(name);
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  ok('reapplication after the full chain preserves the complete catalog');

  for (const f of ['analytics_record_signup_attribution(uuid,jsonb)', 'analytics_signup_source_report(integer)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
    assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true, f);
  }
  for (const role of ['anon', 'authenticated']) {
    for (const p of ['UPDATE', 'INSERT']) {
      assert.equal(await v("SELECT has_column_privilege($1,'profiles','signup_attribution',$2) v", [role, p]), false, `${role} ${p}`);
    }
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','account_erasure_local_cleanup(uuid,boolean)','execute') v"),
    (await v("SELECT has_function_privilege('service_role','account_erasure_auth_begin(uuid,uuid)','execute') v")),
    'the local cleanup keeps the executor grants it had (same as its sibling)');
  ok('clients cannot call the functions or write the column; erasure function grants unchanged');

  const profile = async (createdDaysAgo = 0) => {
    const id = randomUUID();
    await c.query(`INSERT INTO profiles(id,credits,role,email,created_at) VALUES($1,0,'user',$2,now()-make_interval(days=>$3))`,
      [id, `${id.slice(0, 8)}@attribution.test`, createdDaysAgo]);
    return id;
  };
  const seen = new Date(Date.now() - 86400000).toISOString();
  const record = (u, attr) => v('SELECT analytics_record_signup_attribution($1,$2) v', [u, JSON.stringify(attr)]);
  const stored = u => v('SELECT signup_attribution v FROM profiles WHERE id=$1', [u]);

  const fresh = await profile();
  for (const bad of [{ utm_source: 'youtube' }, { first_seen_at: seen, email: 'a@b.c' }, { first_seen_at: 'yesterday' },
    { first_seen_at: seen, landing_path: '/verify-email?email=a@b.c' }, { first_seen_at: seen, referrer_host: 'https://x.com/a' },
    { first_seen_at: seen, utm_source: 'Alice Smith' }, { first_seen_at: seen, utm_term: 'x'.repeat(65) }]) {
    assert.equal(await record(fresh, bad), false, JSON.stringify(bad));
  }
  assert.equal(await stored(fresh), null);
  await code(c.query("UPDATE profiles SET signup_attribution='{\"ip\":\"1.2.3.4\"}' WHERE id=$1", [fresh]), '23514');
  ok('malformed or personal fields are refused by the function and by the column check');

  const attr = { utm_source: 'youtube', referrer_host: 'chatgpt.com', landing_path: '/positioning/[draftId]', first_seen_at: seen };
  assert.equal(await record(fresh, attr), true);
  assert.equal(await record(fresh, { first_seen_at: seen, utm_source: 'reddit' }), false, 'written once');
  assert.deepEqual(await stored(fresh), attr);
  const old = await profile(40);
  assert.equal(await record(old, attr), false, 'an account older than 30 days is not attributed later');
  ok('written once for a new account; later attempts and old accounts change nothing');

  const other = await profile();
  await record(other, { first_seen_at: seen, referrer_host: 'perplexity.ai' });
  const plain = await profile();
  const rows = await v('SELECT analytics_signup_source_report(30) v');
  const by = Object.fromEntries(rows.map(r => [r.source, r]));
  assert.equal(by.youtube.signups, 1);
  assert.equal(by['perplexity.ai'].signups, 1);
  assert.ok(by.unknown.signups >= 1);
  assert.equal(JSON.stringify(rows).includes(fresh), false, 'aggregates carry no account id');
  await code(c.query('SELECT analytics_signup_source_report(0)'), 'P0001');
  assert.ok(plain);
  ok('admin report: per-source sign-ups and paying accounts, aggregates only');

  // Account erasure: the local cleanup clears it with the other personal fields; a refill is refused afterwards.
  const closing = await profile();
  await v('SELECT account_erasure_confirm($1,$2) v', [closing, randomUUID()]);
  assert.equal(await record(closing, attr), false, 'a closing account is never attributed');
  await v('SELECT account_erasure_confirm($1,$2) v', [fresh, randomUUID()]);
  await v('SELECT account_erasure_local_cleanup($1,true) v', [fresh]);
  assert.equal(await v('SELECT profile_scrubbed_at IS NOT NULL v FROM account_erasure_requests WHERE profile_id=$1', [fresh]), true);
  assert.equal(await stored(fresh), null, 'cleared by the local cleanup');
  await code(c.query("UPDATE profiles SET signup_attribution=$2 WHERE id=$1", [fresh, JSON.stringify(attr)]), '42501');
  assert.deepEqual(await stored(other), { first_seen_at: seen, referrer_host: 'perplexity.ai' }, 'other accounts untouched');
  ok('erasure clears the first source and the identity guard refuses a refill; other accounts untouched');

  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  ok('account-open policy audit still returns zero rows');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
