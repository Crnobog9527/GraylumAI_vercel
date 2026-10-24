/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR (0347, provisional) verification: adding a brand account without adopting a topic.
// Run: node packages/db/tests/publish-monitor/account-add-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { fixtureSql } from './fixtures.mjs';

const migrationPath = 'packages/db/migrations/0347_publish_monitor_account_add.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0347', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const add = (a, business, platform, account) => svc('SELECT publish_monitor_account_add($1,$2,$3,$4) v', [a, business, platform, account]);
const member = async () => {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]);
  await v('SELECT pm_test.member($1,$2) v', [a, 'facebook']);
  const business = await v('SELECT id v FROM opc_businesses WHERE actor_id=$1', [a]);
  return { a, business };
};
const accounts = async a => (await c.query('SELECT * FROM opc_accounts WHERE actor_id=$1 ORDER BY platform', [a])).rows;

try {
  await c.query(fixtureSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0347 reapplication preserves the complete catalog');

  for (const role of ['anon', 'authenticated']) {
    assert.equal(await v('SELECT has_function_privilege($1,\'publish_monitor_account_add(uuid,uuid,text,text)\',\'EXECUTE\') v', [role]), false, role);
  }
  assert.equal(await v('SELECT has_function_privilege(\'service_role\',\'publish_monitor_account_add(uuid,uuid,text,text)\',\'EXECUTE\') v'), true);
  report.checks.push('only service_role may call the function');

  const u = await member();
  const x = await add(u.a, u.business, 'x', 'My_Handle');
  assert.deepEqual([x.created, x.platform, x.account, x.businessId], [true, 'x', 'my_handle', u.business], 'the name is stored lower-case');
  const rows = await accounts(u.a);
  assert.equal(rows.length, 2, 'the fixture account plus the new one');
  const row = rows.find(r => r.platform === 'x');
  assert.equal(row.project_id, x.accountProjectId);
  assert.equal(row.business_id, u.business);
  assert.equal(row.source_version_id, await v('SELECT current_source_version_id v FROM opc_businesses WHERE id=$1', [u.business]));
  const project = (await c.query('SELECT * FROM artifact_projects WHERE id=$1', [x.accountProjectId])).rows[0];
  assert.deepEqual([project.actor_id, project.work_kind, project.work_title], [u.a, 'account', 'my_handle']);
  report.checks.push('a new account is an ordinary opc_accounts row with its account project, on the caller\'s business and confirmed positioning');

  const replay = await add(u.a, u.business, 'x', '  MY_HANDLE ');
  assert.deepEqual([replay.created, replay.accountProjectId], [false, x.accountProjectId]);
  assert.equal((await accounts(u.a)).length, 2, 'a replay creates nothing');
  await code(add(u.a, u.business, 'x', 'someone_else'), '23505');
  await code(add(u.a, u.business, 'facebook', 'second'), '23505');
  report.checks.push('replay returns the same account; a second account on the same platform of one business is refused');

  // A second business of the same user (the fixture makes one business and one account per call).
  await v('SELECT pm_test.member($1,$2) v', [u.a, 'facebook']);
  const second = { business: await v('SELECT id v FROM opc_businesses WHERE actor_id=$1 AND id<>$2', [u.a, u.business]) };
  await code(add(u.a, second.business, 'x', 'my_handle'), '23505');
  const otherPlatform = await add(u.a, second.business, 'youtube', 'my_handle');
  assert.equal(otherPlatform.created, true, 'the same name on another platform is a different account');
  report.checks.push('a name held by another of the caller\'s businesses is refused on that platform only');

  const stranger = await member();
  await code(add(stranger.a, u.business, 'threads', 'abc'), '42501');
  await code(add(u.a, randomUUID(), 'threads', 'abc'), '42501');
  assert.equal((await accounts(stranger.a)).length, 1, 'nothing was created on another user\'s business');
  await c.query('UPDATE opc_businesses SET archived_at=now() WHERE id=$1', [second.business]);
  await code(add(u.a, second.business, 'pinterest', 'abc'), '42501');
  report.checks.push('only the caller\'s own, live businesses accept an account');

  const draft = randomUUID();
  await c.query('INSERT INTO opc_businesses(id,actor_id,name) VALUES($1,$2,\'no positioning\')', [draft, u.a]);
  await code(add(u.a, draft, 'threads', 'abc'), '55000');
  await code(add(u.a, u.business, 'x!', 'abc'), '22023');
  await code(add(u.a, u.business, 'threads', 'Bad Name'), '22023');
  await code(add(u.a, u.business, 'threads', ''), '22023');
  await code(add(u.a, null, 'threads', 'abc'), '22023');
  report.checks.push('a business without a confirmed positioning is refused (no business or profile slot is created); bad input is refused');

  // The new account takes part in the normal connect flow and in erasure like any other account.
  const connectStart = await svc('SELECT publish_monitor_connect_start($1,$2,$3) v', [u.a, x.accountProjectId, ['feeds']]);
  assert.equal(connectStart.platform, 'x');
  report.checks.push('the new account can be connected through the existing connect flow');

  // The production path: confirm the erasure, then the local cleanup repeated until nothing remains.
  await closeAccount(c, { actor: u.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [u.a]);
  // Erasure keys on actor and business, never on how an account was created: an added account is treated exactly like the
  // account the fixture made for the same business (what the cleanup does with accounts is covered by the erasure suites).
  const states = (await c.query(`SELECT business_id, bool_and(erased_at IS NULL) AS live, bool_or(erased_at IS NULL) AS any_live
    FROM opc_accounts WHERE actor_id=$1 GROUP BY business_id`, [u.a])).rows;
  assert.ok(states.length > 0 && states.every(row => row.live === row.any_live), 'added and fixture accounts end in the same state');
  report.checks.push('account erasure treats an added account exactly like any other account of its business');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
