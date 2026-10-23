/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR plan §9 item 25 (0337, provisional) verification: Post for Me cleanup that stopped after 50
// failed attempts is listed for the admin page, can be re-queued once, and is claimed again by the workers afterwards.
// Run: node packages/db/tests/publish-monitor/stuck-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { fixtureSql } from './fixtures.mjs';

const migrationPath = 'packages/db/migrations/0337_publish_monitor_stuck_cleanup.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0337', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const j = x => JSON.stringify(x);
const member = async () => {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]);
  return { a, account: await v('SELECT pm_test.member($1,$2) v', [a, 'facebook']) };
};
const start = (a, acct) => svc('SELECT publish_monitor_connect_start($1,$2,$3) v', [a, acct, ['feeds']]);
const callback = (a, req, pid, ext) => svc('SELECT publish_monitor_connect_callback($1,$2,$3) v',
  [a, req, j([{ providerAccountId: pid, platform: 'facebook', externalId: ext }])]);
const confirm = (a, req, pid, ext) => svc('SELECT publish_monitor_connect_confirm($1,$2,$3,$4,$5) v',
  [a, req, pid, false, j({ providerAccountId: pid, platform: 'facebook', externalId: ext, status: 'connected' })]);
const conn = async pid => (await c.query('SELECT * FROM social_connections WHERE provider_account_id=$1', [pid])).rows[0];
const list = () => svc('SELECT publish_monitor_stuck_list(200) v');
const requeue = (kind, id) => svc('SELECT publish_monitor_stuck_requeue($1,$2) v', [kind, id]);

try {
  await c.query(fixtureSql);
  // The migration is part of the build; applying it again changes nothing.
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0337 reapplication preserves the complete catalog');

  for (const role of ['anon', 'authenticated']) {
    for (const fn of ['publish_monitor_stuck_list(integer)', 'publish_monitor_stuck_requeue(text,uuid)']) {
      assert.equal(await v('SELECT has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false, `${role} ${fn}`);
      assert.equal(await v('SELECT has_function_privilege(\'service_role\',$1,\'EXECUTE\') v', [fn]), true, fn);
    }
  }
  await c.query('SET ROLE service_role');
  await code(c.query('SELECT count(*) FROM social_connections'), '42501');
  await c.query('RESET ROLE');
  report.checks.push('only service_role may call the two functions; the tables stay closed to it');

  await code(svc('SELECT publish_monitor_stuck_list(0) v'), '22023');
  await code(requeue('other', randomUUID()), '22023');
  assert.deepEqual(await list(), { connections: [], requests: [] });
  report.checks.push('bad input is refused and an empty state lists nothing');

  // A deletion that failed 50 times, one that failed 49 times, and a takeover disconnect that failed 50 times.
  const u = await member(), w = await member(), t = await member();
  for (const [m, pid] of [[u, 'pfm_stuck_del'], [w, 'pfm_retrying'], [t, 'pfm_stuck_take']]) {
    const s = await start(m.a, m.account);
    await callback(m.a, s.requestId, pid, s.externalId);
    await confirm(m.a, s.requestId, pid, s.externalId);
  }
  for (const pid of ['pfm_stuck_del', 'pfm_retrying']) {
    await svc('SELECT publish_monitor_disconnect($1,$2) v', [(await conn(pid)).actor_id, (await conn(pid)).id]);
  }
  await c.query(`UPDATE social_connections SET deletion_attempts=50,deletion_error='PROVIDER_RETRY'
    WHERE provider_account_id='pfm_stuck_del'`);
  await c.query("UPDATE social_connections SET deletion_attempts=49 WHERE provider_account_id='pfm_retrying'");
  await c.query(`UPDATE social_connections SET status='quarantined',provider_disconnect_pending=true,deletion_attempts=50,
    deletion_error='PROVIDER_500' WHERE provider_account_id='pfm_stuck_take'`);
  // A connect attempt whose cleanup failed 50 times, and one that failed fewer times.
  const r1 = await start(u.a, u.account), r2 = await start(w.a, w.account);
  await c.query(`UPDATE social_connect_requests SET state='abandoned',cleanup_attempts=50,cleanup_error='PROVIDER_LIST_FAILED',
    candidate_provider_ids='{pfm_orphan_1}' WHERE id=$1`, [r1.requestId]);
  await c.query("UPDATE social_connect_requests SET state='abandoned',cleanup_attempts=3 WHERE id=$1", [r2.requestId]);

  const stuck = await list();
  assert.deepEqual(stuck.connections.map(x => [x.providerAccountId, x.kind, x.attempts, x.error]).sort(),
    [['pfm_stuck_del', 'deletion', 50, 'PROVIDER_RETRY'], ['pfm_stuck_take', 'takeover_disconnect', 50, 'PROVIDER_500']]);
  assert.deepEqual(stuck.requests.map(x => [x.id, x.state, x.attempts, x.error, x.providerAccountIds]),
    [[r1.requestId, 'abandoned', 50, 'PROVIDER_LIST_FAILED', ['pfm_orphan_1']]]);
  assert.ok(!JSON.stringify(stuck).includes(u.a) && !JSON.stringify(stuck).includes('external'), 'no user identity is listed');
  report.checks.push('records that reached 50 attempts are listed with their provider ids and error codes, no identity');

  // Workers skip them until re-queued; a re-queue gives a fresh allowance once and the worker claims it again.
  const claimed = async () => (await svc('SELECT publish_monitor_provider_work_claim(50,120) v')).map(x => x.connectionId);
  const delId = stuck.connections.find(x => x.providerAccountId === 'pfm_stuck_del').id;
  assert.ok(!(await claimed()).includes(delId), 'a stopped deletion is not claimed');
  await c.query('UPDATE social_connections SET lease_owner=NULL,lease_expires_at=NULL');
  assert.equal(await requeue('connection', delId), true);
  assert.equal(await requeue('connection', delId), false, 'a second click changes nothing');
  assert.deepEqual([(await conn('pfm_stuck_del')).deletion_attempts, (await conn('pfm_stuck_del')).deletion_error], [0, null]);
  assert.ok((await claimed()).includes(delId), 'the re-queued deletion is claimed again');
  assert.equal(await requeue('connection', (await conn('pfm_retrying')).id), false, 'a record still retrying is untouched');
  assert.equal((await conn('pfm_retrying')).deletion_attempts, 49);
  report.checks.push('re-queue resets only stopped records, once, and the worker claims the deletion again');

  assert.equal(await requeue('request', r1.requestId), true);
  const reqRow = (await c.query('SELECT * FROM social_connect_requests WHERE id=$1', [r1.requestId])).rows[0];
  assert.deepEqual([reqRow.cleanup_attempts, reqRow.cleanup_error], [0, null]);
  const picked = (await svc('SELECT publish_monitor_cleanup_claim(50,120) v')).map(x => x.requestId);
  assert.ok(picked.includes(r1.requestId), 'the re-queued attempt cleanup is claimed again');
  assert.equal(await requeue('request', r2.requestId), false);
  const after = await list();
  assert.deepEqual(after.connections.map(x => x.providerAccountId), ['pfm_stuck_take']);
  assert.deepEqual(after.requests, []);
  report.checks.push('a re-queued attempt cleanup is claimed again and leaves the list');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
