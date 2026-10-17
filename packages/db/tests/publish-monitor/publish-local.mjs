/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-5 (0274) verification: idempotency, targets, slots, credit hold and settlement,
// dispatch ownership checks, reconciliation, manual review and erasure. No provider is involved.
// Run: node packages/db/tests/publish-monitor/publish-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { localDb, read, root } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { fixtureSql } from './fixtures.mjs';

const migrationPath = 'packages/db/migrations/0274_publish_monitor_publish.sql';
const entry = ['publish_monitor_publish_claim(uuid,text,text,uuid,uuid,uuid[])', 'publish_monitor_publish_dispatch(uuid,uuid,jsonb)',
  'publish_monitor_publish_release(uuid,text)', 'publish_monitor_publish_unknown(uuid,text)',
  'publish_monitor_publish_record(uuid,text,jsonb)', 'publish_monitor_publish_webhook_result(text,text,boolean,text)',
  'publish_monitor_publish_reconcile_claim(integer,integer,boolean)', 'publish_monitor_publish_check_later(uuid,uuid,text)',
  'publish_monitor_publish_unlease(uuid,uuid)', 'publish_monitor_publish_manual_resolve(uuid,uuid,boolean,jsonb)',
  'publish_monitor_publish_job(uuid,uuid)', 'publish_monitor_publish_targets(uuid,uuid)',
  'publish_monitor_publish_check_info(uuid,uuid)'];
const internal = ['publish_monitor_publish_price()', 'publish_monitor_publish_credits(jsonb,integer)',
  'publish_monitor_quota_period()', 'publish_monitor_publish_view(social_publish_jobs)',
  'publish_monitor_publish_close(social_publish_jobs,integer,text,text)', 'publish_monitor_publish_lock(uuid)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0274', checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => {
  const error = await promise.then(() => null, e => e);
  assert.ok(error?.message?.includes(expected), `expected ${expected}, got ${error?.message}`);
};
const svc = async (sql, args = [], client = c) => {
  await client.query('SET ROLE service_role');
  try { return (await client.query(sql, args)).rows[0]?.v; } finally { await client.query('RESET ROLE'); }
};
const j = x => JSON.stringify(x);
const REF = 'a'.repeat(32);
const credits = a => v('SELECT credits v FROM profiles WHERE id=$1', [a]);
const quota = () => c.query('SELECT used,reserved,alerted_at FROM social_publish_quota_periods').then(r => r.rows[0]);
const job = id => c.query('SELECT * FROM social_publish_jobs WHERE id=$1', [id]).then(r => r.rows[0]);

// A member with one brand and accounts on several platforms; each account gets a publish-ready connection.
const extraAccountSql = `CREATE OR REPLACE FUNCTION pm_test.extra_account(a uuid,plat text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE src opc_accounts;ap artifact_projects;nid uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO src FROM opc_accounts WHERE actor_id=a LIMIT 1;
 SELECT * INTO ap FROM artifact_projects p WHERE p.id=src.project_id;
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 VALUES(nid,a,ap.module_id,ap.skill_id,'account-'||nid,'account title',0);
 INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id)
 VALUES(nid,a,plat,'pm-'||nid,src.source_version_id,src.business_id);
 RETURN nid;
END $$;`;
let seq = 0;
async function member(balance = 100, platforms = ['x', 'youtube']) {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,$2)', [a, balance]);
  const first = await v('SELECT pm_test.member($1,$2) v', [a, platforms[0]]);
  const business = await v('SELECT business_id v FROM opc_accounts WHERE project_id=$1', [first]);
  await c.query('INSERT INTO social_monitor_settings(actor_id,provider_ref) VALUES($1,$2)',
    [a, a.replace(/-/g, '')]);
  const connections = [];
  for (const [i, plat] of platforms.entries()) {
    const acct = i === 0 ? first : await v('SELECT pm_test.extra_account($1,$2) v', [a, plat]);
    seq += 1;
    connections.push({ platform: plat, provider: `pfm_pub_${seq}`, id: await v(`INSERT INTO social_connections(actor_id,
      business_id,account_project_id,role,source,platform,provider_account_id,status,consent_read,consent_publish,
      provider_can_publish) VALUES($1,$2,$3,'own','postforme',$4,$5,'connected',true,true,true) RETURNING id v`,
    [a, business, acct, plat, `pfm_pub_${seq}`]) });
  }
  return { a, business, ref: a.replace(/-/g, ''), connections };
}
const claim = (m, key, fp, ids, client = c) => svc('SELECT publish_monitor_publish_claim($1,$2,$3,$4,NULL,$5) v',
  [m.a, key, fp, m.business, ids], client);
const observed = (m, overrides = {}) => Object.fromEntries(m.connections.map(x => [x.provider,
  overrides[x.provider] ?? { ownerRef: m.ref, connected: true }]));
const dispatch = (m, id, obs = observed(m)) => svc('SELECT publish_monitor_publish_dispatch($1,$2,$3) v', [m.a, id, j(obs)]);
const record = (id, post, results) => svc('SELECT publish_monitor_publish_record($1,$2,$3) v', [id, post, j(results)]);
const fp = ch => ch.repeat(64);

try {
  await c.query(fixtureSql);
  await c.query(extraAccountSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0274 runs twice with an unchanged catalog');

  for (const f of [...entry, ...internal]) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v('SELECT has_function_privilege($1,$2,$3) v', [role, f, 'EXECUTE']), false, `${role} ${f}`);
    }
    assert.equal(await v('SELECT has_function_privilege($1,$2,$3) v', ['service_role', f, 'EXECUTE']), entry.includes(f), f);
  }
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await v('SELECT has_table_privilege($1,$2,$3) v', [role, 'social_publish_quota_periods', p]), false);
    }
  }
  assert.deepEqual(await v("SELECT value v FROM system_settings WHERE key='publish_monitor_publish_price'"),
    { usdPerTarget: '0.01', multiplier: '6', creditsPerUsd: '100' });
  report.checks.push('only entry points are callable by service_role; the counter table has no direct access; price preset');

  const u = await member();
  const ids = u.connections.map(x => x.id);
  await code(claim(u, 'key-unconf-01', fp('a'), ids), 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED');
  // The period anchor is the subscription renewal date, not the calendar month.
  await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_publish_quota',
    jsonb_build_object('limit',10,'periodAnchor',to_char((now() AT TIME ZONE 'UTC')-interval '40 days','YYYY-MM-DD"T"HH24:MI:SS"Z"')))`);
  assert.equal(await credits(u.a), 100);
  report.checks.push('without the plan limit and renewal anchor nothing can be claimed and nothing is held');

  const first = await claim(u, 'key-first-01', fp('a'), ids);
  assert.equal(first.state, 'claimed');
  assert.equal(first.holdCredits, 12);
  assert.equal(await credits(u.a), 88);
  assert.deepEqual([(await quota()).used, (await quota()).reserved], [0, 2]);
  const period = await c.query('SELECT period_start,period_end FROM social_publish_quota_periods').then(r => r.rows[0]);
  assert.ok(period.period_start <= new Date() && period.period_end > new Date());
  assert.ok(new Date() - period.period_start < 32 * 86400e3 && new Date() - period.period_start >= 9 * 86400e3,
    'period starts at the last monthly renewal, not the first of the month');
  const again = await claim(u, 'key-first-01', fp('a'), ids);
  assert.deepEqual([again.id, again.replayed], [first.id, true]);
  assert.equal(await credits(u.a), 88, 'a replay holds nothing more');
  await code(claim(u, 'key-first-01', fp('b'), ids), 'PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH');
  const other = await member();
  const theirs = await claim(other, 'key-first-01', fp('a'), other.connections.map(x => x.id));
  assert.notEqual(theirs.id, first.id);
  await code(svc('SELECT publish_monitor_publish_job($1,$2) v', [other.a, first.id]), 'PUBLISH_MONITOR_JOB_NOT_FOUND');
  report.checks.push('claim holds 6 credits per target and reserves slots; same key and content replays the caller\'s own '
    + 'job; other content is refused; another user with the same key gets their own job and cannot read the first');

  await code(claim(u, 'key-foreign-1', fp('c'), [other.connections[0].id]), 'PUBLISH_MONITOR_TARGET_INVALID');
  await code(claim(u, 'key-dup-0001', fp('c'), [ids[0], ids[0]]), 'PUBLISH_MONITOR_INPUT_INVALID');
  await c.query('UPDATE social_connections SET consent_publish=false WHERE id=$1', [ids[1]]);
  await code(claim(u, 'key-noconsent', fp('c'), [ids[1]]), 'PUBLISH_MONITOR_TARGET_INVALID');
  await c.query('UPDATE social_connections SET consent_publish=true WHERE id=$1', [ids[1]]);
  const poor = await member(5);
  await code(claim(poor, 'key-poor-0001', fp('a'), [poor.connections[0].id]), 'PUBLISH_MONITOR_INSUFFICIENT_CREDITS');
  assert.equal(await v('SELECT count(*)::int v FROM social_publish_jobs WHERE actor_id=$1', [poor.a]), 0);
  report.checks.push('another user\'s or another brand\'s connection, duplicates, missing publish consent and a short balance '
    + 'are refused before anything is held');

  const sent = await dispatch(u, first.id);
  assert.equal(sent.dispatch, true);
  assert.equal(sent.state, 'dispatching');
  assert.equal((await dispatch(u, first.id)).dispatch, false, 'a dispatching job is never dispatched again');
  await code(svc('SELECT publish_monitor_publish_release($1,$2) v', [first.id, 'bad code']), 'PUBLISH_MONITOR_INPUT_INVALID');
  let after = await record(first.id, 'sp_first', { [ids[0]]: { status: 'published', url: 'https://x.com/s/1' } });
  assert.equal(after.state, 'unknown');
  assert.equal(await credits(u.a), 88, 'nothing settles while a target is still pending');
  await code(record(first.id, 'sp_first', { [ids[0]]: { status: 'failed' } }), 'PUBLISH_MONITOR_RESULT_CONFLICT');
  await code(record(first.id, 'sp_other', {}), 'PUBLISH_MONITOR_RESULT_CONFLICT');
  after = await record(first.id, 'sp_first', { [ids[1]]: { status: 'failed' } });
  assert.equal(after.state, 'completed');
  assert.equal(after.chargedCredits, 6);
  assert.equal(await credits(u.a), 94, 'only the successful platform is charged');
  assert.deepEqual([(await quota()).used, (await quota()).reserved], [1, 2], 'failed slot released, other user still holds 2');
  assert.equal((await record(first.id, 'sp_first', { [ids[1]]: { status: 'failed' } })).state, 'completed');
  assert.equal(await credits(u.a), 94, 'the same result twice settles once');
  assert.equal(await v("SELECT count(*)::int v FROM billing_history WHERE user_id=$1 AND operation_type='settle'", [u.a]), 1);
  report.checks.push('partial success: settles once for the published platform only (6 credits), releases the failed slot; '
    + 'contradicting or repeated results change nothing');

  // A definite refusal releases; an unknown result keeps everything and cannot be released.
  const rejected = await claim(u, 'key-reject-01', fp('d'), [ids[0]]);
  await dispatch(u, rejected.id);
  assert.equal((await svc('SELECT publish_monitor_publish_release($1,$2) v',
    [rejected.id, 'PUBLISH_MONITOR_PROVIDER_REJECTED_400'])).state, 'failed');
  assert.equal(await credits(u.a), 94);
  const lost = await claim(u, 'key-lost-0001', fp('e'), ids);
  await dispatch(u, lost.id);
  assert.equal((await svc('SELECT publish_monitor_publish_unknown($1,$2) v', [lost.id, 'PUBLISH_MONITOR_RESULT_UNKNOWN'])).state,
    'unknown');
  await code(svc('SELECT publish_monitor_publish_release($1,$2) v', [lost.id, 'PUBLISH_MONITOR_CLAIM_EXPIRED']),
    'PUBLISH_MONITOR_STATE_CONFLICT');
  assert.equal(await credits(u.a), 82, 'an unknown result keeps its hold');
  report.checks.push('a definite 4xx releases hold and slots; an unknown result keeps them and cannot be released');

  // Reconcile: expired claims are released; unknown jobs back off and stop for a person after 24 hours.
  const stale = await claim(u, 'key-stale-001', fp('f'), [ids[1]]);
  await c.query("UPDATE social_publish_jobs SET claim_expires_at=now()-interval '1 second' WHERE id=$1", [stale.id]);
  await code(svc('SELECT publish_monitor_publish_dispatch($1,$2,$3) v', [u.a, stale.id, '[]']), 'PUBLISH_MONITOR_INPUT_INVALID');
  await c.query("UPDATE social_publish_jobs SET next_check_at=now()-interval '1 second' WHERE id=$1", [lost.id]);
  const releaseOnly = await svc('SELECT publish_monitor_publish_reconcile_claim(50,120,true) v');
  assert.deepEqual(releaseOnly.filter(x => [stale.id, lost.id].includes(x.jobId)).map(x => x.action), ['release'],
    'without a provider key only expired claims are handed out');
  await svc('SELECT publish_monitor_publish_unlease($1,$2) v', [stale.id, releaseOnly.find(x => x.jobId === stale.id).lease]);
  const items = await svc('SELECT publish_monitor_publish_reconcile_claim(50,120) v');
  const mine = Object.fromEntries(items.filter(x => [stale.id, lost.id].includes(x.jobId)).map(x => [x.jobId, x]));
  assert.equal(mine[stale.id].action, 'release');
  assert.equal(mine[lost.id].action, 'check');
  assert.equal(mine[lost.id].externalId, lost.id);
  assert.equal((await svc('SELECT publish_monitor_publish_reconcile_claim(50,120) v')).filter(x => x.jobId === lost.id).length, 0,
    'a leased job is not handed out twice');
  await svc('SELECT publish_monitor_publish_release($1,$2) v', [stale.id, 'PUBLISH_MONITOR_CLAIM_EXPIRED']);
  assert.equal((await job(stale.id)).state, 'released');
  const later = await svc('SELECT publish_monitor_publish_check_later($1,$2,$3) v', [lost.id, mine[lost.id].lease,
    'PUBLISH_MONITOR_NOT_FOUND_YET']);
  assert.equal(later.manualReview, false);
  await c.query("UPDATE social_publish_jobs SET dispatched_at=now()-interval '25 hours',next_check_at=now()-interval '1 second' WHERE id=$1",
    [lost.id]);
  const late = (await svc('SELECT publish_monitor_publish_reconcile_claim(50,120) v')).find(x => x.jobId === lost.id);
  assert.equal((await svc('SELECT publish_monitor_publish_check_later($1,$2,$3) v', [lost.id, late.lease,
    'PUBLISH_MONITOR_NOT_FOUND_YET'])).manualReview, true);
  assert.equal((await svc('SELECT publish_monitor_publish_reconcile_claim(50,120) v')).filter(x => x.jobId === lost.id).length, 0);
  assert.equal(await credits(u.a), 82, 'not finding the post never releases the hold');
  const admin = randomUUID();
  await c.query("INSERT INTO profiles(id,credits,role) VALUES($1,0,'admin')", [admin]);
  await code(svc('SELECT publish_monitor_publish_manual_resolve($1,$2,true,NULL) v', [u.a, lost.id]),
    'PUBLISH_MONITOR_ADMIN_REQUIRED');
  assert.equal((await svc('SELECT publish_monitor_publish_manual_resolve($1,$2,true,NULL) v', [admin, lost.id])).state, 'failed');
  assert.equal(await credits(u.a), 94);
  report.checks.push('expired claims are released, leased once; unknown jobs back off, wait for a person after 24 hours and '
    + 'keep their hold until an admin records "not sent"');

  // Dispatch re-checks the provider owner: another owner's reference quarantines the connection; no post is sent.
  const taken = await claim(u, 'key-taken-001', fp('1'), ids);
  const res = await dispatch(u, taken.id, observed(u, { [u.connections[1].provider]: { ownerRef: REF, connected: true } }));
  assert.deepEqual([res.dispatch, res.state, res.errorCode], [false, 'released', 'PUBLISH_MONITOR_ACCOUNT_OWNER_CHANGED']);
  assert.deepEqual(await c.query('SELECT status,provider_disconnect_pending FROM social_connections WHERE id=$1', [ids[1]])
    .then(r => r.rows[0]), { status: 'quarantined', provider_disconnect_pending: true });
  assert.equal(await credits(u.a), 94);
  const gone = await claim(u, 'key-gone-0001', fp('2'), [ids[0]]);
  const res2 = await dispatch(u, gone.id, observed(u, { [u.connections[0].provider]: { ownerRef: null, connected: false } }));
  assert.deepEqual([res2.dispatch, res2.errorCode], [false, 'PUBLISH_MONITOR_TARGET_CHANGED']);
  assert.equal((await c.query('SELECT status FROM social_connections WHERE id=$1', [ids[0]])).rows[0].status, 'connected');
  report.checks.push('dispatch: an account carrying another owner\'s reference is quarantined and queued for disconnect; a '
    + 'deleted account just stops the job; both release hold and slots');

  // Webhook results take the same idempotent path.
  const hook = await claim(other, 'key-hook-0001', fp('3'), [other.connections[0].id]);
  await dispatch(other, hook.id);
  await record(hook.id, 'sp_hook', {});
  assert.equal(await svc('SELECT publish_monitor_publish_webhook_result($1,$2,true,$3) v', ['sp_hook', 'pfm_nobody', 'https://a.b/c']),
    false);
  assert.equal(await svc('SELECT publish_monitor_publish_webhook_result($1,$2,true,$3) v',
    ['sp_hook', other.connections[0].provider, 'https://x.com/s/2']), true);
  assert.equal(await svc('SELECT publish_monitor_publish_webhook_result($1,$2,true,$3) v',
    ['sp_hook', other.connections[0].provider, 'https://x.com/s/2']), false);
  assert.equal((await job(hook.id)).state, 'completed');
  report.checks.push('a webhook result settles through the same path; unknown accounts and repeats change nothing');

  // Plan §9 item 8: with one slot left, two different jobs submitted at the same moment: only one gets it.
  const { Client } = createRequire(`${root}/package.json`)('pg');
  const q = await quota();
  await c.query(`UPDATE system_settings SET value=jsonb_set(value,'{limit}',to_jsonb($1::int)) WHERE key='publish_monitor_publish_quota'`,
    [q.used + q.reserved + 1]);
  const a1 = await member(), a2 = await member();
  const conns = await Promise.all([0, 1].map(async () => {
    const x = new Client({ host: c.host, port: c.port, user: c.user, database: c.database });
    await x.connect();
    return x;
  }));
  const raced = await Promise.allSettled([claim(a1, 'key-race-0001', fp('4'), [a1.connections[0].id], conns[0]),
    claim(a2, 'key-race-0002', fp('4'), [a2.connections[0].id], conns[1])]);
  await Promise.all(conns.map(x => x.end()));
  assert.equal(raced.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(String(raced.find(x => x.status === 'rejected').reason.message), /PUBLISH_MONITOR_QUOTA_EXHAUSTED/);
  assert.ok((await quota()).alerted_at, 'the 80% alert is raised once');
  report.checks.push('two concurrent jobs with one slot left: exactly one is claimed; the 80% alert is raised');

  // Same user, same key, submitted at the same moment: the profile lock taken first serializes them, so the second
  // sees the first's row and gets the same job back (no unique-constraint error). A claim racing a settlement of the
  // same user takes profile then quota on both sides, so neither deadlocks.
  await c.query(`UPDATE system_settings SET value=jsonb_set(value,'{limit}','100000') WHERE key='publish_monitor_publish_quota'`);
  const same = await member(1000);
  const settling = await claim(same, 'key-settle-01', fp('8'), [same.connections[0].id]);
  await dispatch(same, settling.id);
  const pair = await Promise.all([0, 1, 2].map(async () => {
    const x = new Client({ host: c.host, port: c.port, user: c.user, database: c.database });
    await x.connect();
    return x;
  }));
  const twins = await Promise.allSettled([
    claim(same, 'key-twin-0001', fp('9'), same.connections.map(x => x.id), pair[0]),
    claim(same, 'key-twin-0001', fp('9'), same.connections.map(x => x.id), pair[1]),
    svc('SELECT publish_monitor_publish_record($1,$2,$3) v', [settling.id, 'sp_settle',
      j({ [same.connections[0].id]: { status: 'published' } })], pair[2])]);
  await Promise.all(pair.map(x => x.end()));
  assert.deepEqual(twins.map(x => x.status), ['fulfilled', 'fulfilled', 'fulfilled'], String(twins.map(x => x.reason)));
  assert.equal(twins[0].value.id, twins[1].value.id);
  assert.deepEqual([twins[0].value.replayed, twins[1].value.replayed].sort(), [false, true]);
  assert.equal(await v('SELECT count(*)::int v FROM social_publish_jobs WHERE actor_id=$1', [same.a]), 2);
  assert.equal(await credits(same.a), 1000 - 6 - 12, 'one settled job and one held job');
  report.checks.push('concurrent first submissions with the same key get the same job; a claim racing a settlement of the '
    + 'same user completes without deadlock');

  // Five definite refusals within an hour pause new submissions for that user.
  const r = await member(1000, ['x']);
  for (let i = 0; i < 5; i++) {
    await c.query(`UPDATE system_settings SET value=jsonb_set(value,'{limit}','1000') WHERE key='publish_monitor_publish_quota'`);
    const x = await claim(r, `key-rej-000${i}`, fp(String(i)), [r.connections[0].id]);
    await dispatch(r, x.id);
    await svc('SELECT publish_monitor_publish_release($1,$2) v', [x.id, 'PUBLISH_MONITOR_PROVIDER_REJECTED_422']);
  }
  await code(claim(r, 'key-rej-0009', fp('9'), [r.connections[0].id]), 'PUBLISH_MONITOR_TOO_MANY_REJECTIONS');
  report.checks.push('repeated definite refusals pause the user\'s new submissions');

  // Disconnecting a connection with an open publish: only disconnect at the provider, the hold stays until the result,
  // then the job settles normally and the deletion proceeds (plan §4.1, #990 convention: targets carry connectionId).
  const d = await member(12);
  const dj = await claim(d, 'key-disc-0001', fp('6'), d.connections.map(x => x.id));
  assert.equal(await credits(d.a), 0, 'the whole balance can be held, never more');
  await dispatch(d, dj.id);
  await svc('SELECT publish_monitor_publish_unknown($1,$2) v', [dj.id, 'PUBLISH_MONITOR_RESULT_UNKNOWN']);
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [d.a, d.connections[0].id]);
  const work = async pid => (await svc('SELECT publish_monitor_provider_work_claim(50,120) v')).find(x => x.providerAccountId === pid);
  assert.equal((await work(d.connections[0].provider)).action, 'disconnect', 'an open publish holds the provider deletion');
  assert.equal(await credits(d.a), 0, 'disconnecting keeps the hold');
  await record(dj.id, 'sp_disc', { [d.connections[0].id]: { status: 'published' }, [d.connections[1].id]: { status: 'failed' } });
  assert.equal(await credits(d.a), 6, 'settled for the one published platform; the rest returned');
  assert.equal((await job(dj.id)).state, 'completed');
  await c.query('UPDATE social_connections SET lease_owner=NULL,lease_expires_at=NULL WHERE provider_account_id=$1',
    [d.connections[0].provider]);
  assert.equal((await work(d.connections[0].provider)).action, 'delete', 'once settled the deletion goes ahead');
  // A claimed (never sent) job whose connection was disconnected is released at dispatch, not sent.
  const d2 = await member(100, ['x']);
  const cj = await claim(d2, 'key-disc-0002', fp('7'), [d2.connections[0].id]);
  await svc('SELECT publish_monitor_disconnect($1,$2) v', [d2.a, d2.connections[0].id]);
  assert.deepEqual([(await dispatch(d2, cj.id)).dispatch, await credits(d2.a)], [false, 100]);
  report.checks.push('disconnect with an open publish keeps the hold and delays provider deletion until settled; a claimed '
    + 'job on a disconnected account is released; holds never exceed the balance');

  // Erasure: an open job keeps only its check fields, still settles afterwards, and then disappears.
  const e = await member();
  const open = await claim(e, 'key-erase-001', fp('5'), e.connections.map(x => x.id));
  await dispatch(e, open.id);
  await svc('SELECT publish_monitor_publish_unknown($1,$2) v', [open.id, 'PUBLISH_MONITOR_RESULT_UNKNOWN']);
  await closeAccount(c, { actor: e.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [e.a]);
  const kept = await job(open.id);
  assert.deepEqual([kept.state, kept.business_id, kept.work_item_id], ['unknown', null, null]);
  await record(open.id, 'sp_erase', { [e.connections[0].id]: { status: 'published' }, [e.connections[1].id]: { status: 'published' } });
  assert.equal(await job(open.id), undefined, 'a settled job of an erased user is removed');
  assert.equal(await v("SELECT count(*)::int v FROM billing_history WHERE user_id=$1 AND operation_type='settle'", [e.a]), 1);
  assert.equal(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [e.a])) >= 0, true);
  report.checks.push('erasure keeps an open job without brand links; it still settles from provider results, then is deleted');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
