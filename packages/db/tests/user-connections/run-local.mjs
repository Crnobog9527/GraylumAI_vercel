/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only INTEGRATION-BASE B1 verification (user_connections and its three functions): builds the full chain without
// Vault (the migration must not need it), then installs the local Vault stand-in and checks grants, input refusals, closed
// accounts, set/replace/read/delete, that the credential lives only in Vault, account erasure, and repeatable application.
// Run: node packages/db/tests/user-connections/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const file = readdirSync(new URL('../../migrations/', import.meta.url)).find(f => /^\d{4}_user_connections\.sql$/.test(f));
assert.ok(file, 'the user_connections migration exists');
const migrationPath = `packages/db/migrations/${file}`;
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: file, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => {
  const e = await promise.then(() => null, error => error);
  assert.equal(e?.code, expected, e?.message);
  return e;
};
const profile = async (status = 'active', deleted = false) => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits,status,is_deleted) VALUES($1,0,$2,$3)', [id, status, deleted]);
  return id;
};
// Fake values only. CANARY marks text that must never appear outside Vault and the read function.
const CANARY = 'USERCONNCANARY';
const fake = tail => `pt-${CANARY}-fake-${tail}`;
const target = { appToken: 'bascnFakeAppToken01' };
const set = (id, secret, t = target, label = '测试表', provider = 'feishu_base') =>
  v('SELECT user_connection_set($1,$2,$3,$4,$5) v', [id, provider, secret, t, label]);
const secretOf = id => v("SELECT user_connection_secret($1,'feishu_base') v", [id]);
const remove = id => v("SELECT user_connection_delete($1,'feishu_base') v", [id]);
const FUNCTIONS = ['user_connection_set(uuid,text,text,jsonb,text)', 'user_connection_secret(uuid,text)',
  'user_connection_delete(uuid,text)', 'user_connection_failed(uuid,text,text)'];
const fail = (id, last4) => v("SELECT user_connection_failed($1,'feishu_base',$2) v", [id, last4]);

try {
  const [a, b] = [await profile(), await profile()];

  for (const role of ['anon', 'authenticated']) {
    for (const f of FUNCTIONS) assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await v("SELECT has_table_privilege($1,'public.user_connections',$2) v", [role, p]), false, `${role} ${p}`);
    }
  }
  for (const f of FUNCTIONS) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true, f);
  assert.equal(await v("SELECT has_table_privilege('service_role','public.user_connections','SELECT') v"), true);
  for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
    assert.equal(await v("SELECT has_table_privilege('service_role','public.user_connections',$1) v", [p]), false, p);
  }
  assert.equal(await v("SELECT relrowsecurity v FROM pg_class WHERE oid='public.user_connections'::regclass"), true);
  report.checks.push('service role: execute the four functions and read rows only; anon/authenticated: nothing; RLS on');

  await c.query('SET ROLE service_role');
  const missing = await code(set(a, fake('a1b2')), '55000');
  assert.match(missing.message, /CONNECTION_VAULT_MISSING/);
  assert.equal(await secretOf(a), null);
  await c.query('RESET ROLE');
  assert.equal(await v('SELECT count(*)::int v FROM user_connections'), 0);
  report.checks.push('without Vault the writer refuses (no clear-text fallback) and nothing is stored');

  await c.query(read('packages/db/tests/platform-secrets/vault_stub.sql'));
  await c.query('SET ROLE service_role');
  for (const args of [[a, 'short'], [a, `${fake('a1')} b2`], [a, `${fake('a1')}\nb2`], [a, 'x'.repeat(1025)], [a, null],
    [null, fake('a1b2')], [a, fake('a1b2'), '[]'], [a, fake('a1b2'), { big: 'x'.repeat(2100) }], [a, fake('a1b2'), target, ''],
    [a, fake('a1b2'), target, '名'.repeat(201)], [a, fake('a1b2'), target, '表', 'notion']]) {
    const e = await code(set(...args), '23514');
    assert.ok(!e.message.includes(CANARY) && !(e.detail ?? '').includes(CANARY));
  }
  report.checks.push('invalid provider, credential, target or label refused without echoing the credential');

  await c.query('RESET ROLE');
  const suspended = await profile('suspended'), deleted = await profile('active', true);
  await c.query('SET ROLE service_role');
  for (const id of [suspended, deleted, randomUUID()]) assert.match((await code(set(id, fake('a1b2')), 'PT403')).message, /CONNECTION_ACCOUNT_CLOSED/);
  report.checks.push('suspended, deleted and unknown profiles refused');

  const first = await set(a, fake('a1b2'));
  assert.deepEqual(first, { provider: 'feishu_base', last4: 'a1b2', target, label: '测试表' });
  assert.equal(await secretOf(a), fake('a1b2'));
  assert.equal(await secretOf(b), null, 'another user has nothing');
  const row1 = (await c.query("SELECT * FROM user_connections WHERE profile_id=$1", [a])).rows[0];
  assert.equal(row1.last4, 'a1b2');
  assert.equal(await fail(a, 'zzzz'), false, 'another credential is not marked');
  assert.equal(await fail(a, 'a1b2'), true);
  assert.equal(await fail(a, 'a1b2'), false, 'marking twice changes nothing');
  assert.ok((await c.query("SELECT failed_at FROM user_connections WHERE profile_id=$1", [a])).rows[0].failed_at);
  const t2 = { appToken: 'bascnFakeAppToken02' };
  await set(a, fake('c3d4'), t2, null);
  const row2 = (await c.query("SELECT * FROM user_connections WHERE profile_id=$1", [a])).rows[0];
  assert.equal(row2.vault_secret_id, row1.vault_secret_id, 'reconnecting replaces the secret in place');
  assert.deepEqual([row2.last4, row2.target, row2.label, row2.failed_at], ['c3d4', t2, null, null]);
  assert.equal(await secretOf(a), fake('c3d4'));
  await set(b, fake('e5f6'));
  assert.equal(await secretOf(b), fake('e5f6'));
  report.checks.push('set, mark failed (only that credential), replace in place (clears failed_at), read back; each user only their own');

  await c.query('RESET ROLE');
  for (const table of ['user_connections', 'application_logs', 'user_activity_logs']) {
    assert.equal(await v(`SELECT count(*)::int v FROM ${table} t WHERE strpos(t::text,$1)>0`, [CANARY]), 0, table);
  }
  assert.equal(await v('SELECT count(*)::int v FROM vault.secrets WHERE strpos(secret,$1)>0', [CANARY]), 0, 'Vault holds ciphertext');
  assert.equal(await v("SELECT count(*)::int v FROM vault.secrets WHERE name LIKE 'graylum.user.%'"), 2);
  report.checks.push('the credential is nowhere outside Vault ciphertext; one Vault entry per connection');

  await c.query('SET ROLE service_role');
  assert.equal(await remove(b), true);
  assert.equal(await remove(b), false, 'disconnecting twice is a no-op');
  assert.equal(await secretOf(b), null);
  await c.query('RESET ROLE');
  assert.equal(await v("SELECT count(*)::int v FROM vault.secrets WHERE name=$1", [`graylum.user.${b}.feishu_base`]), 0);
  report.checks.push('disconnect deletes the row and its Vault entry');

  const remaining = async id => Number(await v('SELECT account_erasure_local_remaining($1) v', [id]));
  const withRow = await remaining(a);
  await c.query('SET ROLE service_role');
  await remove(a);
  await c.query('RESET ROLE');
  assert.equal(withRow - await remaining(a), 1, 'a connection is one remaining item');
  await c.query('SET ROLE service_role');
  await set(a, fake('g7h8'));
  await c.query('RESET ROLE');
  await c.query('SELECT account_erasure_confirm($1,$2)', [a, randomUUID()]);
  await c.query('SET ROLE service_role');
  assert.match((await code(set(a, fake('i9j0')), 'PT403')).message, /CONNECTION_ACCOUNT_CLOSED/, 'no new connection after erasure starts');
  await c.query('RESET ROLE');
  await c.query('SELECT account_erasure_local_cleanup($1,true)', [a]);
  assert.equal(await v('SELECT count(*)::int v FROM user_connections WHERE profile_id=$1', [a]), 0);
  assert.equal(await v("SELECT count(*)::int v FROM vault.secrets WHERE name LIKE $1", [`graylum.user.${a}.%`]), 0);
  report.checks.push('erasure: counted as remaining, refused after the request, rows and Vault entries deleted by local cleanup');

  const audit = (await c.query(read('packages/db/tests/erasure-coverage-audit.sql'))).rows;
  assert.deepEqual(audit, [], JSON.stringify(audit));
  report.checks.push('erasure coverage audit: 0 rows');

  await c.query('SET ROLE service_role');
  await set(b, fake('k1l2'));
  await c.query('RESET ROLE');
  await c.query(read(migrationPath));
  await c.query('SET ROLE service_role');
  assert.equal(await secretOf(b), fake('k1l2'));
  await c.query('RESET ROLE');
  assert.equal(await v("SELECT has_table_privilege('authenticated','public.user_connections','SELECT') v"), false);
  report.checks.push('reapplying the migration with data present changes nothing');

  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
