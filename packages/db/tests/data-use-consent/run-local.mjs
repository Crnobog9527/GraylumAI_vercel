/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only AGENT-CORE R10 (D5) verification: consent, revocation, team filter and erasure revocation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0212_data_use_consent.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0212', checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const profile = async () => { const a = randomUUID(); await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]); return a; };
const set = (a, granted, version = 'd5-v1', client = c) =>
  v('SELECT data_use_consent_set($1,$2,$3) v', [a, granted, version], client);
const state = a => v('SELECT data_use_consent_state($1) v', [a]);
const readable = async ids => (await c.query('SELECT x FROM data_use_team_readable($1::uuid[]) x', [ids])).rows.map(r => r.x).sort();
const rows = async a => (await c.query('SELECT version,revoked_at IS NOT NULL revoked,revoke_reason FROM data_use_consents'
  + ' WHERE profile_id=$1 ORDER BY granted_at,id', [a])).rows;
const close = a => v('SELECT account_erasure_confirm($1,$2) v', [a, randomUUID()]);
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0212 reapplication after the full chain preserves the complete catalog');

  const functions = ['data_use_team_allowed(uuid)', 'data_use_team_readable(uuid[])', 'data_use_consent_state(uuid)',
    'data_use_consent_set(uuid,boolean,text)', 'data_use_consent_expire()'];
  for (const role of ['anon', 'authenticated']) {
    for (const f of [...functions, 'data_use_consent_erasure_revoke()', 'data_use_consent_guard()']) {
      assert.equal(await v('SELECT has_function_privilege($1,$2,\'execute\') v', [role, f]), false, `${role} ${f}`);
    }
  }
  for (const f of functions) assert.equal(await v('SELECT has_function_privilege(\'service_role\',$1,\'execute\') v', [f]), true);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await v('SELECT has_table_privilege($1,\'data_use_consents\',$2) v', [role, p]), false, `${role} ${p}`);
    }
  }
  assert.equal(await v("SELECT relrowsecurity v FROM pg_class WHERE oid='data_use_consents'::regclass"), true);
  report.checks.push('clients have no table or function access; service_role only via dedicated RPCs; RLS on');

  const [yes, no, later] = [await profile(), await profile(), await profile()];
  assert.deepEqual(await state(no), { purpose: 'team_improvement', currentVersion: 'd5-v1', granted: false,
    version: null, grantedAt: null, revokedAt: null });
  assert.deepEqual(await readable([yes, no, later]), []);
  report.checks.push('default is not participating; nobody is readable before an explicit grant');

  await code(set(yes, true, 'd5-v0'), 'PT409');
  assert.deepEqual(await rows(yes), []);
  assert.equal((await set(yes, true)).granted, true);
  assert.equal((await set(yes, true)).granted, true);
  assert.equal((await rows(yes)).length, 1, 'repeat grant is idempotent');
  assert.deepEqual(await readable([yes, no, later, null]), [yes].sort());
  assert.equal(await v('SELECT data_use_team_allowed($1) v', [no]), false);
  report.checks.push('allow: current-version grant is readable; deny: stale version rejected and non-consenting user filtered');

  const revoked = await set(yes, false);
  assert.equal(revoked.granted, false);
  assert.ok(revoked.revokedAt);
  assert.deepEqual(await readable([yes]), []);
  await set(yes, false);
  assert.deepEqual(await rows(yes), [{ version: 'd5-v1', revoked: true, revoke_reason: 'user' }]);
  assert.equal((await set(yes, true)).granted, true);
  assert.equal((await rows(yes)).length, 2, 're-grant after revoke is a new audited grant');
  report.checks.push('revoke takes effect immediately, is idempotent, keeps an audit row; re-grant adds a new row');

  // A consent recorded under an older purpose/wording no longer counts until the user agrees again.
  await c.query("INSERT INTO data_use_consents(profile_id,purpose,version) VALUES($1,'team_improvement','d5-v0')", [later]);
  assert.deepEqual(await readable([later]), []);
  assert.equal((await state(later)).granted, false);
  assert.equal((await set(later, true)).granted, true);
  assert.deepEqual((await rows(later)).map(r => r.revoke_reason), ['superseded', null]);
  report.checks.push('older version grant is filtered and superseded by the new grant');

  await code(c.query("UPDATE data_use_consents SET version='d5-v9' WHERE profile_id=$1", [yes]), '42501');
  await code(c.query('UPDATE data_use_consents SET revoked_at=clock_timestamp(),revoke_reason=\'user\''
    + ' WHERE profile_id=$1 AND revoked_at IS NOT NULL', [yes]), '42501');
  await code(c.query('DELETE FROM data_use_consents WHERE profile_id=$1', [yes]), '42501');
  report.checks.push('audit rows are immutable apart from one revocation and cannot be deleted early');

  assert.equal((await close(yes)).created, true);
  assert.deepEqual(await readable([yes, later]), [later]);
  assert.equal((await rows(yes)).at(-1).revoke_reason, 'account_erasure');
  await code(set(yes, true), '42501');
  assert.equal((await set(yes, false)).granted, false);
  const closedNoConsent = await profile();
  await close(closedNoConsent);
  assert.deepEqual(await rows(closedNoConsent), []);
  report.checks.push('account erasure revokes in the closing transaction; closed account cannot grant again');

  // Two-connection races on the profile row lock, both orders.
  for (const closeFirst of [true, false]) {
    const a = await profile();
    if (!closeFirst) await set(a, true);
    const one = new pg.Client(c.connectionParameters), two = new pg.Client(c.connectionParameters);
    await one.connect(); await two.connect();
    try {
      await one.query("BEGIN; SET LOCAL statement_timeout='10s'");
      if (closeFirst) await one.query('SELECT account_erasure_confirm($1,$2)', [a, randomUUID()]);
      else await one.query('SELECT data_use_consent_set($1,true,\'d5-v1\')', [a]);
      const pid = (await one.query('SELECT pg_backend_pid() p')).rows[0].p;
      const second = closeFirst ? set(a, true, 'd5-v1', two).then(() => null, e => e)
        : two.query('SELECT account_erasure_confirm($1,$2)', [a, randomUUID()]).then(() => null, e => e);
      let waited = false;
      for (let i = 0; i < 300 && !waited; i++) {
        waited = (await c.query("SELECT bool_or($1=ANY(pg_blocking_pids(pid))) w FROM pg_stat_activity WHERE pid<>$1 AND state='active'",
          [pid])).rows[0].w === true;
        if (!waited) await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(waited, true, 'second writer waits on the profile lock');
      await one.query('COMMIT');
      const error = await second;
      if (closeFirst) assert.equal(error?.code, '42501');
      else assert.equal(error, null);
      assert.deepEqual(await readable([a]), []);
      assert.ok((await rows(a)).every(r => r.revoked));
    } finally { await one.query('ROLLBACK'); await one.end(); await two.end(); }
  }
  report.checks.push('grant vs erasure races serialize in both orders and never leave an active consent');

  const grants = await profile();
  const clients = await Promise.all([0, 1, 2, 3].map(async () => { const x = new pg.Client(c.connectionParameters); await x.connect(); return x; }));
  try {
    const results = await Promise.allSettled(clients.map(x => set(grants, true, 'd5-v1', x)));
    assert.ok(results.every(r => r.status === 'fulfilled'));
  } finally { await Promise.all(clients.map(x => x.end())); }
  assert.equal((await rows(grants)).length, 1);
  report.checks.push('four concurrent grants leave exactly one active consent');

  const old = await profile();
  await c.query("INSERT INTO data_use_consents(profile_id,purpose,version,granted_at,revoked_at,revoke_reason)"
    + " VALUES($1,'team_improvement','d5-v1',now()-interval '3 years',now()-interval '366 days','user'),"
    + " ($1,'team_improvement','d5-v1',now()-interval '2 years',now()-interval '300 days','account_erasure')", [old]);
  await c.query('SET ROLE service_role');
  try { assert.equal(await v('SELECT data_use_consent_expire() v'), 1); } finally { await c.query('RESET ROLE'); }
  assert.deepEqual((await rows(old)).map(r => r.revoke_reason), ['account_erasure']);
  assert.equal((await rows(grants)).length, 1, 'active consents are never expired');
  report.checks.push('audit retention: removed only one year after revocation; active and recent rows kept');

  // Users' own reads are untouched: no RLS policy and no pre-existing function consults consent.
  assert.equal(await v("SELECT count(*)::int v FROM pg_policies WHERE coalesce(qual,'')||coalesce(with_check,'') ~ 'data_use'"), 0);
  assert.deepEqual((await c.query("SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace"
    + " AND p.prosrc ~ 'data_use_' ORDER BY 1")).rows.map(r => r.proname), ['data_use_consent_erasure_revoke',
    'data_use_consent_expire', 'data_use_consent_set', 'data_use_consent_state', 'data_use_team_allowed', 'data_use_team_readable']);
  report.checks.push('own-data reads unaffected: no RLS policy or existing function depends on consent');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit still returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
