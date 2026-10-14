/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-2b-1 (0246) verification: connect attempt lifecycle, ownership, erasure.
// Run: node packages/db/tests/publish-monitor/connect-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';

const migrationPath = 'packages/db/migrations/0246_publish_monitor_connect.sql';
const rpcs = ['publish_monitor_connect_start(uuid,uuid,text[])', 'publish_monitor_connect_callback(uuid,uuid,jsonb)',
  'publish_monitor_connect_confirm(uuid,uuid,text,boolean,jsonb)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0246', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const svc = async (sql, args) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const start = (a, acct, perms = ['feeds']) => svc('SELECT publish_monitor_connect_start($1,$2,$3) v', [a, acct, perms]);
const callback = (a, req, cands) => svc('SELECT publish_monitor_connect_callback($1,$2,$3) v', [a, req, JSON.stringify(cands)]);
// current = the provider facts the server re-read just before confirming; defaults to "unchanged since callback".
const confirm = (a, req, pid, track = true, current) => svc('SELECT publish_monitor_connect_confirm($1,$2,$3,$4,$5) v',
  [a, req, pid, track, JSON.stringify(current ?? { providerAccountId: pid, platform: 'facebook', externalId: '$REQ', status: 'connected' })]);
const ext = async req => v('SELECT external_id v FROM social_connect_requests WHERE id=$1', [req]);
const confirmLive = async (a, req, pid, track = true) => confirm(a, req, pid, track,
  { providerAccountId: pid, platform: 'facebook', externalId: await ext(req), status: 'connected' });
const fixtureSql = `CREATE SCHEMA IF NOT EXISTS pm_test;
CREATE OR REPLACE FUNCTION pm_test.member(a uuid,plat text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE sk uuid:=gen_random_uuid();m uuid:=gen_random_uuid();rev uuid:=gen_random_uuid();p uuid:=gen_random_uuid();
 r uuid:=gen_random_uuid();v uuid:=gen_random_uuid();ac uuid:=gen_random_uuid();bus uuid:=gen_random_uuid();
BEGIN
 INSERT INTO skills(id,skill_key,content_kind) VALUES(sk,'pm-'||sk,'directory');
 INSERT INTO modules(id,title,skill_id,active) VALUES(m,'PM fixture',sk,true);
 INSERT INTO skill_revisions(id,skill_id,version,content,content_hash,published_by) VALUES(rev,sk,1,'fixture',repeat('a',64),a);
 INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
 VALUES(rev,sk,gen_random_uuid(),'{}',repeat('b',64),repeat('a',64),0,a);
 INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
 VALUES(p,a,m,sk,'source-'||p,'source title',1),(ac,a,m,sk,'account-'||ac,'account title',0);
 INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
 VALUES(r,p,rev,repeat('b',64),'{}',repeat('c',64),repeat('d',64),'published','{}');
 INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) VALUES(v,p,r,1,'{}',repeat('e',64),'[]');
 INSERT INTO opc_businesses(id,actor_id,name,current_source_version_id) VALUES(bus,a,'business',v);
 INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id) VALUES(ac,a,plat,'pm-'||ac,v,bus);
 RETURN ac;
END $$;`;
const member = async (plat = 'facebook') => {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]);
  return { a, account: await v('SELECT pm_test.member($1,$2) v', [a, plat]) };
};
const cand = (pid, ext, platform = 'facebook') => ({ providerAccountId: pid, platform, externalId: ext });

try {
  await c.query(fixtureSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0246 reapplication preserves the complete catalog');

  for (const f of [...rpcs, 'publish_monitor_random_hex()']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
    assert.match(await v('SELECT array_to_string(proconfig,\',\') v FROM pg_proc WHERE oid=$1::regprocedure', [f]),
      /search_path=public, ?pg_temp/);
  }
  for (const f of rpcs) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true);
  assert.equal(await v("SELECT has_function_privilege('service_role','publish_monitor_random_hex()','execute') v"), false);
  report.checks.push('three RPCs for service_role only; fixed search_path; clients have no access');

  const u = await member(), other = await member();
  const s1 = await start(u.a, u.account);
  const ref = s1.externalId.split('.')[0];
  assert.match(s1.externalId, /^[0-9a-f]{32}\.[0-9a-f]{32}$/);
  assert.equal(s1.platform, 'facebook');
  assert.ok(!s1.externalId.includes(u.a.replaceAll('-', '')), 'provider reference is not the user ID');
  const s2 = await start(u.a, u.account);
  assert.equal(s2.externalId.split('.')[0], ref, 'same user keeps one provider reference');
  assert.notEqual(s2.externalId, s1.externalId, 'each attempt has its own suffix');
  assert.equal(await v('SELECT state v FROM social_connect_requests WHERE id=$1', [s1.requestId]), 'abandoned');
  assert.notEqual((await start(other.a, other.account)).externalId.split('.')[0], ref);
  await code(start(u.a, other.account), 'P0002');
  await code(start(u.a, u.account, ['posts']), '22023');
  report.checks.push('attempts use a random per-user reference plus a per-attempt suffix; a new attempt abandons the old; '
    + 'another user\'s brand account cannot be targeted');

  await code(callback(u.a, s1.requestId, []), 'PT409');
  const victim = await member();
  const vs = await start(victim.a, victim.account);
  await callback(victim.a, vs.requestId, [cand('pfm_victim', vs.externalId)]);
  await confirmLive(victim.a, vs.requestId, 'pfm_victim');
  const cb = await callback(u.a, s2.requestId, [cand('pfm_new_1', s2.externalId), cand('pfm_new_2', s2.externalId),
    cand('pfm_stale', s1.externalId), cand('pfm_wrong_platform', s2.externalId, 'x'), cand('pfm_victim', vs.externalId)]);
  assert.deepEqual([cb.newAccounts, cb.quarantined, cb.ignored],
    [['pfm_new_1', 'pfm_new_2'], [], ['pfm_stale', 'pfm_wrong_platform', 'pfm_victim']]);
  assert.equal(await v("SELECT status v FROM social_connections WHERE provider_account_id='pfm_victim'"), 'connected',
    'an account whose provider record still belongs to its owner is untouched');
  await code(callback(u.a, s2.requestId, [cand('pfm_new_1', s2.externalId)]), 'PT409');
  report.checks.push('callback only considers accounts carrying this attempt\'s exact external_id and platform; '
    + 'stale, foreign and replayed callbacks change nothing');

  await code(confirmLive(u.a, s2.requestId, 'pfm_victim'), 'PT409');
  await code(confirmLive(other.a, s2.requestId, 'pfm_new_1'), 'PT409');
  // Taken over between callback and confirm: the provider now shows another attempt's value, or a disconnected account.
  await code(confirm(u.a, s2.requestId, 'pfm_new_1', false,
    { providerAccountId: 'pfm_new_1', platform: 'facebook', externalId: vs.externalId, status: 'connected' }), 'PT409');
  await code(confirm(u.a, s2.requestId, 'pfm_new_1', false,
    { providerAccountId: 'pfm_new_1', platform: 'facebook', externalId: s2.externalId, status: 'disconnected' }), 'PT409');
  const done = await confirmLive(u.a, s2.requestId, 'pfm_new_1', false);
  assert.deepEqual(done.unselected, ['pfm_new_2']);
  const row = (await c.query('SELECT * FROM social_connections WHERE id=$1', [done.connectionId])).rows[0];
  assert.deepEqual([row.actor_id, row.account_project_id, row.platform, row.status, row.consent_read, row.consent_auto_track,
    row.consent_publish, row.provider_can_publish], [u.a, u.account, 'facebook', 'connected', true, false, false, false]);
  await code(confirmLive(u.a, s2.requestId, 'pfm_new_2'), 'PT409');
  report.checks.push('confirm binds only a candidate of the actor\'s own attempt to its target account; read-only consent; '
    + 'unselected accounts are returned for provider cleanup; no double confirm');

  // Proven takeover: the victim's account now carries u's attempt value at the provider.
  const s3 = await start(u.a, u.account, ['feeds', 'posts']);
  const cb3 = await callback(u.a, s3.requestId, [cand('pfm_victim', s3.externalId), cand('pfm_new_1', s3.externalId)]);
  assert.deepEqual([cb3.quarantined, cb3.ownExisting], [['pfm_victim'], ['pfm_new_1']]);
  assert.equal(await v("SELECT status v FROM social_connections WHERE provider_account_id='pfm_victim'"), 'quarantined');
  await code(confirmLive(u.a, s3.requestId, 'pfm_victim'), 'PT409');
  const upgraded = await confirmLive(u.a, s3.requestId, 'pfm_new_1', true);
  assert.equal(upgraded.connectionId, done.connectionId);
  assert.deepEqual((await c.query('SELECT consent_publish,provider_can_publish,consent_auto_track FROM social_connections'
    + ' WHERE id=$1', [done.connectionId])).rows[0], { consent_publish: true, provider_can_publish: true, consent_auto_track: true });
  assert.equal(await v("SELECT actor_id v FROM social_connections WHERE provider_account_id='pfm_victim'"), victim.a,
    'another user\'s account is never rebound');
  // A later read-only re-authorization drops the provider capability but keeps the user's publishing consent.
  const s6 = await start(u.a, u.account);
  await callback(u.a, s6.requestId, [cand('pfm_new_1', s6.externalId)]);
  await confirmLive(u.a, s6.requestId, 'pfm_new_1', true);
  assert.deepEqual((await c.query('SELECT consent_publish,provider_can_publish FROM social_connections WHERE id=$1',
    [done.connectionId])).rows[0], { consent_publish: true, provider_can_publish: false });
  report.checks.push('a proven takeover quarantines the other user\'s connection without binding it; publishing upgrade '
    + 'changes only the target connection; read-only re-authorization drops provider publish capability');

  await c.query("UPDATE social_connect_requests SET expires_at=now()-interval '1 second' WHERE actor_id=$1"
    + " AND state='awaiting_callback'", [u.a]);
  const s4 = await start(u.a, u.account);
  await c.query("UPDATE social_connect_requests SET expires_at=now()-interval '1 second' WHERE id=$1", [s4.requestId]);
  await code(callback(u.a, s4.requestId, []), 'PT409');
  report.checks.push('expired attempts cannot be consumed');

  const s5 = await start(u.a, u.account);
  await closeAccount(c, { actor: u.a });
  await code(start(u.a, u.account), '42501');
  await code(callback(u.a, s5.requestId, []), '42501');
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [u.a]);
  assert.equal(await v('SELECT count(*)::int v FROM social_monitor_settings WHERE actor_id=$1', [u.a]), 0,
    'the provider reference is erased with the settings row');
  assert.equal(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [u.a])), 0);
  const kept = (await c.query("SELECT state,business_id,target_account_project_id FROM social_connect_requests WHERE id=$1",
    [s5.requestId])).rows[0];
  assert.deepEqual(kept, { state: 'awaiting_callback', business_id: null, target_account_project_id: null });
  assert.equal(await v("SELECT status v FROM social_connections WHERE id=$1", [done.connectionId]), 'deleting');
  report.checks.push('closed accounts cannot start or record attempts; erasure removes the provider reference and keeps '
    + 'only unbound records needed for provider cleanup');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
