/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-2c-1 (0265) verification: late callbacks, attempt cleanup, orphan sweep decisions,
// provider deletion and takeover-disconnect work, user disconnect, and erasure interplay.
// Run: node packages/db/tests/publish-monitor/cleanup-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { fixtureSql } from './fixtures.mjs';

const migrationPath = 'packages/db/migrations/0265_publish_monitor_provider_cleanup.sql';
const rpcs = ['publish_monitor_connect_callback(uuid,uuid,jsonb)', 'publish_monitor_cleanup_claim(integer,integer)',
  'publish_monitor_cleanup_classify(uuid,jsonb)', 'publish_monitor_cleanup_finish(uuid,boolean,text)',
  'publish_monitor_orphan_classify(jsonb)', 'publish_monitor_provider_work_claim(integer,integer)',
  'publish_monitor_provider_work_finish(uuid,text,text)', 'publish_monitor_disconnect(uuid,uuid)',
  'publish_monitor_provider_account_disconnected(text)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0265', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const j = x => JSON.stringify(x);
const member = async (plat = 'facebook') => {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]);
  return { a, account: await v('SELECT pm_test.member($1,$2) v', [a, plat]) };
};
const cand = (pid, ext, platform = 'facebook') => ({ providerAccountId: pid, platform, externalId: ext });
const start = (a, acct) => svc('SELECT publish_monitor_connect_start($1,$2,$3) v', [a, acct, ['feeds']]);
const callback = (a, req, cands) => svc('SELECT publish_monitor_connect_callback($1,$2,$3) v', [a, req, j(cands)]);
const confirm = (a, req, pid, ext) => svc('SELECT publish_monitor_connect_confirm($1,$2,$3,$4,$5) v',
  [a, req, pid, false, j({ providerAccountId: pid, platform: 'facebook', externalId: ext, status: 'connected' })]);
const claim = () => svc('SELECT publish_monitor_cleanup_claim(50,120) v');
const classify = (req, accounts) => svc('SELECT publish_monitor_cleanup_classify($1,$2) v', [req, j(accounts)]);
const finish = (req, done, err = null) => svc('SELECT publish_monitor_cleanup_finish($1,$2,$3) v', [req, done, err]);
const acc = (pid, ext) => ({ providerAccountId: pid, externalId: ext });
const work = () => svc('SELECT publish_monitor_provider_work_claim(50,120) v');
const workFinish = (id, outcome, err = null) => svc('SELECT publish_monitor_provider_work_finish($1,$2,$3) v', [id, outcome, err]);
const state = async id => (await c.query('SELECT * FROM social_connect_requests WHERE id=$1', [id])).rows[0];
const conn = async pid => (await c.query('SELECT * FROM social_connections WHERE provider_account_id=$1', [pid])).rows[0];
const connect = async (m, pid) => {
  const s = await start(m.a, m.account);
  await callback(m.a, s.requestId, [cand(pid, s.externalId)]);
  await confirm(m.a, s.requestId, pid, s.externalId);
  return s;
};

try {
  await c.query(fixtureSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0265 reapplication preserves the complete catalog');

  for (const f of rpcs) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
    assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true, f);
    assert.match(await v('SELECT array_to_string(proconfig,\',\') v FROM pg_proc WHERE oid=$1::regprocedure', [f]),
      /search_path=public, ?pg_temp/);
  }
  report.checks.push('nine RPCs for service_role only; fixed search_path; clients have no access');

  // Item 24: a late callback of attempt A, arriving with B's cookie, does not consume B.
  const u = await member(), other = await member();
  const a1 = await start(u.a, u.account);
  const b1 = await start(u.a, u.account);
  await code(callback(u.a, b1.requestId, [cand('pfm_a_only', a1.externalId)]), 'PT409');
  assert.equal((await state(b1.requestId)).state, 'awaiting_callback', 'the newer attempt stays usable');
  const cb = await callback(u.a, b1.requestId, [cand('pfm_b_1', b1.externalId)]);
  assert.deepEqual(cb.newAccounts, ['pfm_b_1']);
  report.checks.push('a late callback carrying none of this attempt\'s accounts is refused without consuming it');

  // Cleanup: expired open attempts become abandoned; settled attempts are claimed once under a lease.
  await c.query("UPDATE social_connect_requests SET confirm_expires_at=now()-interval '1 second' WHERE id=$1", [b1.requestId]);
  const claimed = await claim();
  const ids = claimed.map(r => r.requestId);
  assert.ok(ids.includes(a1.requestId) && ids.includes(b1.requestId));
  assert.equal((await state(b1.requestId)).state, 'abandoned');
  assert.deepEqual(claimed.find(r => r.requestId === b1.requestId).candidateIds, ['pfm_b_1']);
  assert.deepEqual(await claim(), [], 'a leased attempt is not claimed twice');
  report.checks.push('expired attempts are abandoned and claimed once under a lease');

  // Classify: only accounts carrying this attempt's external_id are acted on; own bound accounts are kept; another
  // user's bound account is a proven takeover (quarantined and queued for disconnect).
  const owned = await member();
  await connect(owned, 'pfm_owned');
  await connect(u, 'pfm_u_kept');
  const verdicts = await classify(b1.requestId, [acc('pfm_b_1', b1.externalId), acc('pfm_other_ext', a1.externalId),
    acc('pfm_owned', b1.externalId), acc('pfm_u_kept', b1.externalId)]);
  assert.deepEqual(verdicts.map(x => x.action), ['delete', 'skip', 'takeover', 'keep']);
  const taken = await conn('pfm_owned');
  assert.deepEqual([taken.status, taken.provider_disconnect_pending, taken.actor_id], ['quarantined', true, owned.a]);
  assert.equal((await conn('pfm_u_kept')).status, 'connected');
  await finish(b1.requestId, true);
  await code(classify(b1.requestId, []), 'PT409');
  await finish(a1.requestId, false, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual([(await state(a1.requestId)).cleaned_at, (await state(a1.requestId)).cleanup_error],
    [null, 'PROVIDER_UNAVAILABLE']);
  report.checks.push('cleanup acts only on accounts carrying the attempt\'s external_id: new ones deleted, own kept, '
    + 'another user\'s quarantined and queued for disconnect; unfinished cleanup is retried');

  // Orphan sweep decisions: bound accounts, unknown formats and unsettled attempts are never deleted.
  const open = await start(other.a, other.account);
  const orphan = await svc('SELECT publish_monitor_orphan_classify($1) v', [j([acc('pfm_u_kept', 'x'),
    acc('pfm_dash', null), acc('pfm_weird', 'Owner-Test'), acc('pfm_open', open.externalId),
    acc('pfm_unsettled', a1.externalId), acc('pfm_settled', b1.externalId), acc('pfm_gone_user', 'f'.repeat(32) + '.' + 'e'.repeat(32))])]);
  assert.deepEqual(orphan, { delete: ['pfm_settled', 'pfm_gone_user'], unknownFormat: ['pfm_dash', 'pfm_weird'] });
  report.checks.push('orphan sweep deletes only unbound accounts in Graylum\'s own format whose attempt is settled or unknown; '
    + 'other formats are only reported');

  // Provider work: takeover disconnect carries the original owner's reference; deletion rows are removed on success.
  const jobs = await work();
  const takeoverJob = jobs.find(x => x.providerAccountId === 'pfm_owned');
  assert.equal(takeoverJob.action, 'disconnect');
  assert.equal(takeoverJob.ownerRef, await v('SELECT provider_ref v FROM social_monitor_settings WHERE actor_id=$1', [owned.a]));
  assert.deepEqual(await work(), [], 'leased work is not claimed twice');
  await workFinish(takeoverJob.connectionId, 'retry', 'PROVIDER_UNAVAILABLE');
  assert.equal((await conn('pfm_owned')).deletion_error, 'PROVIDER_UNAVAILABLE');
  await workFinish(takeoverJob.connectionId, 'owner_back');
  assert.deepEqual([(await conn('pfm_owned')).provider_disconnect_pending, (await conn('pfm_owned')).status], [false, 'quarantined']);
  report.checks.push('takeover disconnect is claimed under a lease with the owner reference and cleared when settled');

  // User disconnect: posts and snapshots go now; the row becomes an identity-free deletion record; others refused.
  const keptConn = await conn('pfm_u_kept');
  const post = await v(`INSERT INTO social_posts(actor_id,connection_id,source,platform_post_id,posted_at)
    VALUES($1,$2,'postforme','p1',now()) RETURNING id v`, [u.a, keptConn.id]);
  await c.query(`INSERT INTO social_metric_snapshots(actor_id,connection_id,post_id,captured_on,source,metrics)
    VALUES($1,$2,$3,current_date,'postforme','{}')`, [u.a, keptConn.id, post]);
  await code(svc('SELECT publish_monitor_disconnect($1,$2) v', [other.a, keptConn.id]), 'P0002');
  assert.deepEqual(await svc('SELECT publish_monitor_disconnect($1,$2) v', [u.a, keptConn.id]),
    { connectionId: keptConn.id, providerCleanup: true });
  const del = await conn('pfm_u_kept');
  assert.deepEqual([del.status, del.business_id, del.account_project_id, del.consent_read, del.provider_can_publish],
    ['deleting', null, null, false, false]);
  assert.equal(await v('SELECT count(*)::int v FROM social_posts WHERE connection_id=$1', [keptConn.id]), 0);
  await code(svc('SELECT publish_monitor_disconnect($1,$2) v', [u.a, keptConn.id]), 'P0002');
  const delJob = (await svc('SELECT publish_monitor_provider_work_claim(50,120) v'))
    .find(x => x.providerAccountId === 'pfm_u_kept');
  assert.equal(delJob.action, 'delete');
  await workFinish(delJob.connectionId, 'gone');
  assert.equal(await conn('pfm_u_kept'), undefined, 'a confirmed provider deletion removes the record');
  report.checks.push('a user disconnects only their own connection: data removed now, identity-free record until the '
    + 'provider deletion is confirmed');

  // Webhook: a provider-side disconnect asks the owner to re-authorise; unknown accounts are ignored.
  await connect(other, 'pfm_hook');
  assert.equal(await svc('SELECT publish_monitor_provider_account_disconnected($1) v', ['pfm_hook']), true);
  assert.equal((await conn('pfm_hook')).status, 'reauth_required');
  assert.equal(await svc('SELECT publish_monitor_provider_account_disconnected($1) v', ['pfm_nobody']), false);
  report.checks.push('a provider-side disconnect moves only that connection to re-authorisation');

  // Erasure still completes; settled attempt records are purged after 30 days.
  await closeAccount(c, { actor: u.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [u.a]);
  assert.equal(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [u.a])), 0);
  await c.query("UPDATE social_connect_requests SET cleaned_at=now()-interval '31 days' WHERE id=$1", [b1.requestId]);
  await finish(a1.requestId, true);
  assert.equal(await state(b1.requestId), undefined);
  report.checks.push('erasure completes with the new columns; settled attempts are purged after 30 days');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
