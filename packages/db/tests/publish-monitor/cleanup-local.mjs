/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-2c-1 (0265) verification: late callbacks, attempt cleanup, orphan sweep decisions,
// provider deletion and takeover-disconnect work, user disconnect, and erasure interplay.
// Run: node packages/db/tests/publish-monitor/cleanup-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { fixtureSql, laterRedefinitions } from './fixtures.mjs';

const migrationPath = 'packages/db/migrations/0265_publish_monitor_provider_cleanup.sql';
const rpcs = ['publish_monitor_connect_callback(uuid,uuid,jsonb)', 'publish_monitor_cleanup_claim(integer,integer)',
  'publish_monitor_cleanup_classify(uuid,uuid,jsonb)', 'publish_monitor_cleanup_finish(uuid,uuid,boolean,text)',
  'publish_monitor_orphan_classify(jsonb)', 'publish_monitor_provider_work_claim(integer,integer)',
  'publish_monitor_provider_work_finish(uuid,uuid,text,text)', 'publish_monitor_disconnect(uuid,uuid)',
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
const claim = async () => {
  const items = await svc('SELECT publish_monitor_cleanup_claim(50,120) v');
  for (const item of items) leases.set(item.requestId, item.lease);
  return items;
};
// Classification needs the current cleanup lease; attempts the test settles without a daily claim get one here.
const classify = async (req, accounts, lease = leases.get(req)) => {
  if (!lease) {
    lease = randomUUID();
    await c.query('UPDATE social_connect_requests SET cleanup_lease=$2 WHERE id=$1', [req, lease]);
    leases.set(req, lease);
  }
  return svc('SELECT publish_monitor_cleanup_classify($1,$2,$3) v', [req, lease, j(accounts)]);
};
// Cleanup results must carry the lease of the claim that handed the attempt out; the latest one is remembered here.
const leases = new Map();
const finish = (req, done, err = null, lease = leases.get(req)) =>
  svc('SELECT publish_monitor_cleanup_finish($1,$2,$3,$4) v', [req, lease ?? randomUUID(), done, err]);
const acc = (pid, ext) => ({ providerAccountId: pid, externalId: ext });
const work = () => svc('SELECT publish_monitor_provider_work_claim(50,120) v');
// job: a claimed item ({ connectionId, lease }); only the current claim's lease may report its outcome.
const workFinish = (job, outcome, err = null) => svc('SELECT publish_monitor_provider_work_finish($1,$2,$3,$4) v',
  [job.connectionId, job.lease, outcome, err]);
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
  for (const path of [migrationPath, ...laterRedefinitions('0265')]) await c.query(read(path));
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
  assert.equal((await state(b1.requestId)).cleanup_attempts, 0, 'claiming alone does not use up a retry');
  report.checks.push('expired attempts are abandoned and claimed once under a lease');

  // Classify: only accounts carrying this attempt's external_id are acted on; own bound accounts are kept; another
  // user's bound account is a proven takeover (quarantined and queued for disconnect).
  const owned = await member();
  await connect(owned, 'pfm_owned');
  await connect(u, 'pfm_u_kept');
  await code(classify(b1.requestId, [], randomUUID()), 'PT409');
  const verdicts = await classify(b1.requestId, [acc('pfm_b_1', b1.externalId), acc('pfm_other_ext', a1.externalId),
    acc('pfm_owned', b1.externalId), acc('pfm_u_kept', b1.externalId)]);
  assert.deepEqual(verdicts.map(x => x.action), ['delete', 'skip', 'takeover', 'keep']);
  const taken = await conn('pfm_owned');
  assert.deepEqual([taken.status, taken.provider_disconnect_pending, taken.actor_id], ['quarantined', true, owned.a]);
  assert.equal((await conn('pfm_u_kept')).status, 'connected');
  // A result from an older claim is ignored; only the current lease can settle the attempt.
  await finish(b1.requestId, true, null, randomUUID());
  assert.equal((await state(b1.requestId)).cleaned_at, null, 'stale cleanup result ignored');
  await finish(b1.requestId, true);
  // A settled abandoned attempt is checked again daily for 30 days (its consent link never expires): not right away,
  // but after a day; an attempt older than 30 days is not.
  assert.equal((await claim()).some(r => r.requestId === b1.requestId), false);
  await c.query("UPDATE social_connect_requests SET cleaned_at=now()-interval '21 hours',cleanup_lease_until=NULL WHERE id=$1",
    [b1.requestId]);
  assert.equal((await claim()).some(r => r.requestId === b1.requestId), true);
  await finish(b1.requestId, true);
  await finish(a1.requestId, false, 'PROVIDER_UNAVAILABLE');
  assert.deepEqual([(await state(a1.requestId)).cleaned_at, (await state(a1.requestId)).cleanup_error],
    [null, 'PROVIDER_UNAVAILABLE']);
  report.checks.push('cleanup acts only on accounts carrying the attempt\'s external_id: new ones deleted, own kept, '
    + 'another user\'s quarantined and queued for disconnect; unfinished cleanup is retried');

  // Orphan sweep decisions: bound accounts, unknown formats and unsettled attempts are never deleted.
  const open = await start(other.a, other.account);
  const uRef = await v('SELECT provider_ref v FROM social_monitor_settings WHERE actor_id=$1', [u.a]);
  const orphan = await svc('SELECT publish_monitor_orphan_classify($1) v', [j([acc('pfm_u_kept', `${uRef}.${'0'.repeat(32)}`),
    acc('pfm_dash', null), acc('pfm_weird', 'Owner-Test'), acc('pfm_open', open.externalId),
    acc('pfm_unsettled', a1.externalId), acc('pfm_settled', b1.externalId), acc('pfm_gone_user', 'f'.repeat(32) + '.' + 'e'.repeat(32)),
    acc('pfm_lookalike', 'abcdefghijklmnop.qrstuvwxyzabcdef')])]);
  assert.deepEqual(orphan, { delete: ['pfm_settled', 'pfm_gone_user'],
    unknownFormat: ['pfm_dash', 'pfm_weird', 'pfm_lookalike'], takenOver: [] });
  // A bound account whose provider record now carries another user's reference (callback and webhook missed) is
  // quarantined and queued for disconnect by the sweep; the same user's own reference changes nothing.
  const sweepVictim = await member();
  await connect(sweepVictim, 'pfm_sweep_victim');
  const victimRef = await v('SELECT provider_ref v FROM social_monitor_settings WHERE actor_id=$1', [sweepVictim.a]);
  const sameUser = await svc('SELECT publish_monitor_orphan_classify($1) v',
    [j([acc('pfm_sweep_victim', `${victimRef}.${'0'.repeat(32)}`)])]);
  assert.deepEqual(sameUser.takenOver, []);
  // A live bound account whose reference is missing or not Graylum's format cannot be its owner's: fails closed.
  const nullRef = await member();
  await connect(nullRef, 'pfm_null_ref');
  assert.deepEqual((await svc('SELECT publish_monitor_orphan_classify($1) v',
    [j([{ providerAccountId: 'pfm_null_ref', externalId: null, status: 'connected' }])])).takenOver, ['pfm_null_ref']);
  const swept = await svc('SELECT publish_monitor_orphan_classify($1) v',
    [j([acc('pfm_sweep_victim', `${'9'.repeat(32)}.${'0'.repeat(32)}`)])]);
  assert.deepEqual(swept.takenOver, ['pfm_sweep_victim']);
  const victimConn = await conn('pfm_sweep_victim');
  assert.deepEqual([victimConn.status, victimConn.provider_disconnect_pending], ['quarantined', true]);
  // An attempt that exhausted its cleanup retries no longer shields its accounts from the sweep.
  await c.query('UPDATE social_connect_requests SET cleanup_attempts=50 WHERE id=$1', [a1.requestId]);
  assert.deepEqual((await svc('SELECT publish_monitor_orphan_classify($1) v', [j([acc('pfm_unsettled', a1.externalId)])])).delete,
    ['pfm_unsettled']);
  await c.query('UPDATE social_connect_requests SET cleanup_attempts=1 WHERE id=$1', [a1.requestId]);
  report.checks.push('orphan sweep deletes only unbound accounts in Graylum\'s own format whose attempt is settled or unknown; '
    + 'other formats are only reported');

  // Provider work: takeover disconnect carries the original owner's reference; deletion rows are removed on success.
  const jobs = await work();
  const takeoverJob = jobs.find(x => x.providerAccountId === 'pfm_owned');
  assert.deepEqual([takeoverJob.action, takeoverJob.takeoverPending], ['disconnect', true]);
  assert.equal(takeoverJob.ownerRef, await v('SELECT provider_ref v FROM social_monitor_settings WHERE actor_id=$1', [owned.a]));
  assert.deepEqual(await work(), [], 'leased work is not claimed twice');
  assert.equal((await conn('pfm_owned')).deletion_attempts, 0, 'claiming alone does not use up a retry');
  await workFinish(takeoverJob, 'retry', 'PROVIDER_UNAVAILABLE');
  assert.deepEqual([(await conn('pfm_owned')).deletion_error, (await conn('pfm_owned')).deletion_attempts],
    ['PROVIDER_UNAVAILABLE', 1]);
  await workFinish(takeoverJob, 'owner_back');
  assert.equal((await conn('pfm_owned')).provider_disconnect_pending, true, 'a result after the lease was released is ignored');
  await workFinish((await work()).find(x => x.providerAccountId === 'pfm_owned'), 'owner_back');
  assert.deepEqual([(await conn('pfm_owned')).provider_disconnect_pending, (await conn('pfm_owned')).status,
    (await conn('pfm_owned')).deletion_attempts], [false, 'quarantined', 0], 'a settled takeover resets its retry count');
  // Taken over again later with the webhook missed: the sweep starts a new episode on the quarantined row, unless the
  // account is merely disconnected.
  const again = acc('pfm_owned', `${'8'.repeat(32)}.${'0'.repeat(32)}`);
  assert.deepEqual((await svc('SELECT publish_monitor_orphan_classify($1) v', [j([{ ...again, status: 'disconnected' }])]))
    .takenOver, []);
  assert.deepEqual((await svc('SELECT publish_monitor_orphan_classify($1) v', [j([{ ...again, status: 'connected' }])]))
    .takenOver, ['pfm_owned']);
  assert.equal((await conn('pfm_owned')).provider_disconnect_pending, true);
  await workFinish((await work()).find(x => x.providerAccountId === 'pfm_owned'), 'disconnected');
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
  assert.equal(del.owner_ref, await v('SELECT provider_ref v FROM social_monitor_settings WHERE actor_id=$1', [u.a]),
    'the deletion record keeps the owner reference the worker must find on the provider account');
  assert.equal(await v('SELECT count(*)::int v FROM social_posts WHERE connection_id=$1', [keptConn.id]), 0);
  await code(svc('SELECT publish_monitor_disconnect($1,$2) v', [u.a, keptConn.id]), 'P0002');
  const delJob = (await svc('SELECT publish_monitor_provider_work_claim(50,120) v'))
    .find(x => x.providerAccountId === 'pfm_u_kept');
  assert.deepEqual([delJob.action, delJob.deleting, delJob.ownerRef], ['delete', true, del.owner_ref]);
  await workFinish(delJob, 'gone');
  assert.equal(await conn('pfm_u_kept'), undefined, 'a confirmed provider deletion removes the record');
  report.checks.push('a user disconnects only their own connection: data removed now, identity-free record with the owner '
    + 'reference until the provider deletion is confirmed');

  // Unresolved publishes: the deletion only clears tokens (once) and waits; afterwards it deletes. A changed owner ends
  // only our record.
  await connect(other, 'pfm_pub');
  const pub = await conn('pfm_pub');
  await c.query(`INSERT INTO social_publish_jobs(actor_id,business_id,idempotency_key,request_fingerprint,targets,state)
    VALUES($1,$2,'pub-open-key-01',repeat('a',64),$3,'dispatching')`,
  [other.a, pub.business_id, j([{ connectionId: pub.id, platform: 'facebook' }])]);
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [other.a, pub.id]);
  const hold = (await work()).find(x => x.providerAccountId === 'pfm_pub');
  assert.deepEqual([hold.action, hold.deleting], ['disconnect', true]);
  // Even "account gone" does not end a record that unresolved publishes still need.
  await workFinish(hold, 'gone');
  assert.equal((await conn('pfm_pub')).provider_tokens_cleared, true, 'held, not deleted');
  assert.equal((await work()).find(x => x.providerAccountId === 'pfm_pub'), undefined, 'cleared tokens wait for results');
  // A new takeover queued on the held record is still claimed and disconnected while publishes are unresolved.
  await c.query('UPDATE social_connections SET provider_disconnect_pending=true WHERE provider_account_id=$1', ['pfm_pub']);
  const heldTake = (await work()).find(x => x.providerAccountId === 'pfm_pub');
  assert.deepEqual([heldTake.action, heldTake.takeoverPending], ['disconnect', true]);
  await workFinish(heldTake, 'disconnected');
  assert.deepEqual([(await conn('pfm_pub')).provider_disconnect_pending, (await conn('pfm_pub')).status], [false, 'deleting']);
  await c.query("UPDATE social_publish_jobs SET state='completed' WHERE idempotency_key='pub-open-key-01'");
  const afterJob = (await work()).find(x => x.providerAccountId === 'pfm_pub');
  assert.equal(afterJob.action, 'delete');
  await workFinish(afterJob, 'owner_changed');
  assert.equal(await conn('pfm_pub'), undefined, 'a changed owner ends only our record');
  report.checks.push('with unresolved publishes a deletion only clears tokens and waits; a changed owner ends only our record');

  // A deletion record whose owner reference was lost (entered deletion before 0265, settings already erased): its job
  // names only its own provider account ID, and ending it removes only that record; other users' rows are untouched.
  const lost = await member(), bystander = await member();
  await connect(lost, 'pfm_lost_owner');
  await connect(bystander, 'pfm_bystander');
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [lost.a, (await conn('pfm_lost_owner')).id]);
  await c.query('UPDATE social_connections SET owner_ref=NULL WHERE provider_account_id=$1', ['pfm_lost_owner']);
  const others = (await c.query("SELECT id,status,updated_at FROM social_connections WHERE provider_account_id<>'pfm_lost_owner'"
    + ' ORDER BY id')).rows;
  const lostJob = (await work()).find(x => x.providerAccountId === 'pfm_lost_owner');
  assert.deepEqual([lostJob.action, lostJob.deleting, lostJob.ownerRef], ['delete', true, null]);
  await workFinish(lostJob, 'deleted');
  assert.equal(await conn('pfm_lost_owner'), undefined);
  const after = (await c.query("SELECT id,status,updated_at FROM social_connections WHERE provider_account_id<>'pfm_lost_owner'"
    + ' ORDER BY id')).rows;
  assert.deepEqual(after.map(r => r.id), others.map(r => r.id), 'no other connection record removed');
  assert.equal((await conn('pfm_bystander')).status, 'connected');
  report.checks.push('a deletion record with a lost owner reference deletes only its own provider account and record');

  // Webhook: a provider-side disconnect asks the owner to re-authorise; unknown accounts are ignored.
  await connect(other, 'pfm_hook');
  assert.equal(await svc('SELECT publish_monitor_provider_account_disconnected($1) v', ['pfm_hook']), true);
  assert.equal((await conn('pfm_hook')).status, 'reauth_required');
  assert.equal(await svc('SELECT publish_monitor_provider_account_disconnected($1) v', ['pfm_nobody']), false);
  report.checks.push('a provider-side disconnect moves only that connection to re-authorisation');

  // An account overwritten after its owner's record began deleting is queued for disconnect, not skipped.
  const lateOwner = await member();
  await connect(lateOwner, 'pfm_late_take');
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [lateOwner.a, (await conn('pfm_late_take')).id]);
  const taker = await start(u.a, u.account);
  await c.query("UPDATE social_connect_requests SET state='abandoned' WHERE id=$1", [taker.requestId]);
  const lateVerdict = await classify(taker.requestId, [acc('pfm_late_take', taker.externalId)]);
  assert.deepEqual(lateVerdict.map(x => x.action), ['takeover']);
  assert.deepEqual([(await conn('pfm_late_take')).status, (await conn('pfm_late_take')).provider_disconnect_pending],
    ['deleting', true]);
  // A worker that claimed the deletion before the takeover was queued reports a stale result: the record is kept.
  await workFinish({ connectionId: (await conn('pfm_late_take')).id, lease: randomUUID() }, 'owner_changed');
  assert.equal((await conn('pfm_late_take')).provider_disconnect_pending, true, 'kept for the queued disconnect');
  // A repeated takeover while a worker holds the lease invalidates that lease too, so its result cannot clear the
  // newly queued disconnect.
  const leased = (await work()).find(x => x.providerAccountId === 'pfm_late_take');
  const taker2 = await start(u.a, u.account);
  await c.query("UPDATE social_connect_requests SET state='abandoned' WHERE id=$1", [taker2.requestId]);
  await classify(taker2.requestId, [acc('pfm_late_take', taker2.externalId)]);
  await workFinish(leased, 'owner_changed');
  assert.equal((await conn('pfm_late_take')).provider_disconnect_pending, true, 'stale lease result ignored');
  // A callback that proves a takeover of a deleting record queues the disconnect too.
  const lateOwner2 = await member();
  await connect(lateOwner2, 'pfm_late_cb');
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [lateOwner2.a, (await conn('pfm_late_cb')).id]);
  const cbTaker = await member();
  const cbAttempt = await start(cbTaker.a, cbTaker.account);
  await callback(cbTaker.a, cbAttempt.requestId, [cand('pfm_late_cb', cbAttempt.externalId)]);
  assert.deepEqual([(await conn('pfm_late_cb')).status, (await conn('pfm_late_cb')).provider_disconnect_pending],
    ['deleting', true]);
  report.checks.push('an account taken over after deletion began is queued for disconnect before its record ends');

  // Erasure still completes, but an attempt whose provider cleanup is not finished (or finished under 30 days ago)
  // stays, detached from the brand, so the cleanup keeps its external_id; settled attempts are purged after 30 days.
  const late = await start(u.a, u.account);
  await c.query("UPDATE social_connect_requests SET state='abandoned' WHERE id=$1", [late.requestId]);
  await closeAccount(c, { actor: u.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [u.a]);
  assert.equal(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [u.a])), 0);
  const kept = await state(late.requestId);
  assert.deepEqual([kept.state, kept.business_id, kept.target_account_project_id, kept.cleaned_at],
    ['abandoned', null, null, null], 'an erased user\'s unsettled attempt keeps its cleanup record');
  // The 30-day purge (counted from when the attempt was made) runs on every daily claim, even with no new work.
  await c.query("UPDATE social_connect_requests SET created_at=now()-interval '31 days' WHERE id=$1", [b1.requestId]);
  await claim();
  assert.equal(await state(b1.requestId), undefined);
  report.checks.push('erasure completes while unsettled attempts keep their cleanup record; the 30-day purge runs daily');
  // Erasure of a quarantined connection whose takeover disconnect exhausted its retries starts a fresh deletion.
  const quar = await member();
  await connect(quar, 'pfm_erase_quar');
  await c.query(`UPDATE social_connections SET status='quarantined',provider_disconnect_pending=true,deletion_attempts=50,
    deletion_error='PROVIDER_RETRY' WHERE provider_account_id='pfm_erase_quar'`);
  await closeAccount(c, { actor: quar.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [quar.a]);
  const erasing = await conn('pfm_erase_quar');
  assert.deepEqual([erasing.status, erasing.deletion_attempts, erasing.deletion_error], ['deleting', 0, null],
    'erasure does not inherit an exhausted takeover retry count');
  assert.ok((await work()).some(x => x.providerAccountId === 'pfm_erase_quar'), 'the erasure deletion is claimable');
  report.checks.push('erasure resets the retry count of a quarantined connection so its provider deletion is claimed');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
