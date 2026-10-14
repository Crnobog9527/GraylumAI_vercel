/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-1 (0240) verification: privileges, entitlements, settings RPC,
// table constraints and account-erasure wiring. Run: node packages/db/tests/publish-monitor/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { laterRedefinitions } from './fixtures.mjs';

const migrationPath = 'packages/db/migrations/0240_publish_monitor_foundation.sql';
const tables = ['social_monitor_settings', 'social_connections', 'social_posts', 'social_metric_snapshots',
  'social_review_runs', 'social_connect_requests', 'social_publish_jobs'];
const rpcs = ['publish_monitor_settings(uuid)', 'publish_monitor_set_auto_review(uuid,boolean)',
  'publish_monitor_connections(uuid)'];
const internal = ['publish_monitor_actor(uuid)', 'publish_monitor_erasure_retained(text,jsonb)',
  'publish_monitor_erasure_scrub(uuid)', 'publish_monitor_erasure_remaining(uuid)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0240', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const asService = async run => {
  await c.query('SET ROLE service_role');
  try { return await run(); } finally { await c.query('RESET ROLE'); }
};
const count = (t, a) => v(`SELECT count(*)::int v FROM ${t} WHERE actor_id=$1`, [a]);
// A user with a real brand and platform account; all constraints and triggers stay on. No positioning draft:
// drafts are covered by the content-erasure suites and are outside this migration.
const fixtureSql = `CREATE SCHEMA IF NOT EXISTS pm_test;
CREATE OR REPLACE FUNCTION pm_test.member(a uuid) RETURNS void LANGUAGE plpgsql AS $$
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
 INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
 VALUES(v,p,r,1,'{}',repeat('e',64),'[]');
 INSERT INTO opc_businesses(id,actor_id,name,current_source_version_id) VALUES(bus,a,'business',v);
 INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id)
 VALUES(ac,a,'x','pm-'||ac,v,bus);
END $$;`;
const member = async () => {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]);
  await c.query('SELECT pm_test.member($1)', [a]);
  const business = await v('SELECT id v FROM opc_businesses WHERE actor_id=$1', [a]);
  const account = await v('SELECT project_id v FROM opc_accounts WHERE actor_id=$1', [a]);
  return { a, business, account };
};
const connect = (m, fields) => v(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,
  provider_account_id,profile_ref,status,consent_read) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id v`,
[m.a, m.business, fields.account ?? null, fields.role ?? 'own', fields.source ?? 'postforme', fields.platform ?? 'x',
  fields.provider ?? null, fields.ref ?? null, fields.status ?? 'connected']);

try {
  await c.query(fixtureSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  // Later migrations redefine some 0240 functions; reapplying the chain in order must converge.
  for (const path of [migrationPath, ...laterRedefinitions('0240')]) await c.query(read(path));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0240 reapplication after the full chain preserves the complete catalog');

  for (const t of tables) {
    assert.equal(await v("SELECT relrowsecurity v FROM pg_class WHERE oid=$1::regclass", [t]), true, t);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(await v('SELECT has_table_privilege($1,$2,$3) v', [role, t, p]), false, `${role} ${p} ${t}`);
      }
    }
  }
  for (const role of ['anon', 'authenticated']) {
    for (const f of [...rpcs, ...internal]) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
  }
  for (const f of rpcs) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true);
  for (const f of internal) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), false);
  report.checks.push('RLS on; no client or service_role table access; service_role only via the three RPCs');

  // Seeded plans carry the item-51 values; then prove the migration fills rows that predate it.
  await c.query(read('packages/db/seeds/staging_non_secret_baseline.sql'));
  const cols = ['allow_publish', 'own_data_window_days', 'allow_benchmark_monitor', 'allow_weekly_auto_review'];
  await c.query(cols.map(x => `ALTER TABLE membership_plans ALTER COLUMN ${x} DROP NOT NULL;`).join('')
    + `UPDATE membership_plans SET ${cols.map(x => `${x}=NULL`).join(',')};`);
  for (const path of [migrationPath, ...laterRedefinitions('0240')]) await c.query(read(path));
  assert.equal(await v(`SELECT count(*)::int v FROM information_schema.columns WHERE table_name='membership_plans'
    AND column_name=ANY($1) AND is_nullable='NO'`, [cols]), 4);
  const plans = (await c.query(`SELECT level,allow_publish,own_data_window_days,allow_benchmark_monitor,
    allow_weekly_auto_review FROM membership_plans WHERE level IN ('free','pro','gold') ORDER BY level`)).rows;
  assert.equal(plans.length, 3);
  for (const p of plans) {
    assert.deepEqual([p.allow_publish, p.own_data_window_days, p.allow_benchmark_monitor, p.allow_weekly_auto_review],
      { free: [false, 0, false, false], pro: [true, 30, false, false], gold: [true, 90, true, true] }[p.level], p.level);
  }
  await code(c.query("UPDATE membership_plans SET own_data_window_days=-1 WHERE level='pro'"), '23514');
  assert.match(await v("SELECT pg_get_functiondef('public.pay_common_save_catalog(text,uuid,jsonb,jsonb,text,text,text)'"
    + "::regprocedure) v"), /'allow_publish','own_data_window_days','allow_benchmark_monitor','allow_weekly_auto_review'/);
  report.checks.push('entitlement defaults match Master Plan item 51; bounds checked; admin catalog allow-list extended');

  const user = await member();
  const fresh = await asService(() => v('SELECT publish_monitor_settings($1) v', [user.a]));
  assert.deepEqual(fresh, { autoReviewEnabled: true, autoReviewEnabledAt: null });
  const off = await asService(() => v('SELECT publish_monitor_set_auto_review($1,false) v', [user.a]));
  assert.equal(off.autoReviewEnabled, false);
  await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '30 days' WHERE actor_id=$1", [user.a]);
  const on = await asService(() => v('SELECT publish_monitor_set_auto_review($1,true) v', [user.a]));
  assert.ok(new Date(on.autoReviewEnabledAt) > new Date(Date.now() - 60_000), 'turning on again restarts the wait');
  const again = await asService(() => v('SELECT publish_monitor_set_auto_review($1,true) v', [user.a]));
  assert.equal(again.autoReviewEnabledAt, on.autoReviewEnabledAt, 'repeat on keeps the start time');
  report.checks.push('automatic review defaults on, can be turned off, re-enabling restarts the seven-day wait');

  const own = await connect(user, { account: user.account, provider: 'pfm_own_1' });
  await code(connect(user, { account: user.account, provider: 'pfm_own_2' }), '23505');
  await code(connect(user, { role: 'benchmark', source: 'postforme', provider: 'pfm_b', ref: 'x' }), '23514');
  await code(connect(user, { role: 'own', source: 'postforme' }), '23514');
  const bench = await connect(user, { role: 'benchmark', source: 'tikhub', platform: 'douyin', ref: 'https://example.test/u1' });
  await code(connect(user, { role: 'benchmark', source: 'tikhub', platform: 'douyin', ref: 'https://example.test/u1' }), '23505');
  const post = await v(`INSERT INTO social_posts(actor_id,connection_id,source,platform_post_id,title_excerpt)
    VALUES($1,$2,'postforme','p1','title') RETURNING id v`, [user.a, own]);
  await code(c.query(`INSERT INTO social_posts(actor_id,connection_id,source,platform_post_id)
    VALUES($1,$2,'postforme','p1')`, [user.a, own]), '23505');
  await c.query(`INSERT INTO social_metric_snapshots(actor_id,connection_id,post_id,captured_on,source,metrics,missing_fields)
    VALUES($1,$2,$3,current_date,'postforme','{"likes":3}','{views}')`, [user.a, own, post]);
  await code(c.query(`INSERT INTO social_metric_snapshots(actor_id,connection_id,post_id,captured_on,source,metrics)
    VALUES($1,$2,$3,current_date,'postforme','{}')`, [user.a, own, post]), '23505');
  const listed = await asService(() => v('SELECT publish_monitor_connections($1) v', [user.a]));
  assert.deepEqual(listed.map(x => [x.role, x.postCount]).sort(), [['benchmark', 0], ['own', 1]]);
  assert.ok(listed.every(x => !('providerAccountId' in x) && !('refreshCursor' in x)));
  report.checks.push('one effective connection per brand account; provider ID unique; benchmark only via TikHub; '
    + 'posts and daily snapshots unique; overview hides server-only identifiers');

  const other = await member();
  await code(c.query(`INSERT INTO social_posts(actor_id,connection_id,source,platform_post_id)
    VALUES($1,$2,'postforme','x1')`, [other.a, own]), '23503');
  // An own connection can only name the actor's own account of the same brand.
  await code(c.query(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,
    provider_account_id,status) VALUES($1,$2,$3,'own','postforme','x','pfm_cross','connected')`,
  [user.a, user.business, other.account]), '23503');
  await code(c.query(`INSERT INTO social_connect_requests(actor_id,business_id,target_account_project_id,platform,permissions,
    external_id,state,expires_at) VALUES($1,$2,$3,'x','{feeds}',$4,'awaiting_callback',now()+interval '10 minutes')`,
  [user.a, user.business, other.account, 'c'.repeat(16) + '.' + 'd'.repeat(16)]), '23503');
  // ...and only the brand account of the same platform (fixture account platform is 'x').
  // 'disconnected' is outside the one-effective-connection index, so only the platform key can reject it.
  await code(connect(user, { account: user.account, platform: 'youtube', provider: 'pfm_wrong_platform',
    status: 'disconnected' }), '23503');
  await code(c.query(`INSERT INTO social_connect_requests(actor_id,business_id,target_account_project_id,platform,permissions,
    external_id,state,expires_at) VALUES($1,$2,$3,'youtube','{feeds}',$4,'awaiting_callback',now()+interval '10 minutes')`,
  [user.a, user.business, user.account, 'e'.repeat(16) + '.' + 'f'.repeat(16)]), '23503');
  // A snapshot of a post must use that post's own connection.
  await code(c.query(`INSERT INTO social_metric_snapshots(actor_id,connection_id,post_id,captured_on,source,metrics)
    VALUES($1,$2,$3,current_date-1,'tikhub','{}')`, [user.a, bench, post]), '23503');
  const otherConn = await connect(other, { account: other.account, provider: 'pfm_other' });
  await c.query(`INSERT INTO social_publish_jobs(actor_id,business_id,idempotency_key,request_fingerprint,targets,state)
    VALUES($1,$2,'same-key-0001',repeat('a',64),'[{"platform":"x"}]','completed'),
    ($3,$4,'same-key-0001',repeat('b',64),'[{"platform":"x"}]','completed')`, [user.a, user.business, other.a, other.business]);
  report.checks.push('rows cannot point at another user\'s connection or account; snapshots stay on their post\'s '
    + 'connection; idempotency keys are scoped per user');

  // Account erasure: provider-mirroring rows stay as identity-free deletion records, everything else goes.
  await c.query(`INSERT INTO social_review_runs(actor_id,period_start,status,runtime_request_id,finished_at)
    VALUES($1,current_date,'completed',gen_random_uuid(),now())`, [user.a]);
  await c.query(`INSERT INTO social_connect_requests(actor_id,business_id,target_account_project_id,platform,permissions,
    external_id,state,expires_at) VALUES($1,$2,$3,'x','{feeds}',$4,'awaiting_callback',now()+interval '10 minutes')`,
  [user.a, user.business, user.account, 'a'.repeat(16) + '.' + 'b'.repeat(16)]);
  await c.query(`INSERT INTO social_publish_jobs(actor_id,business_id,idempotency_key,request_fingerprint,targets,state)
    VALUES($1,$2,'unknown-key-01',repeat('c',64),'[{"platform":"x"}]','unknown'),
    ($1,$2,'claimed-key-01',repeat('d',64),'[{"platform":"x"}]','claimed')`, [user.a, user.business]);
  await closeAccount(c, { actor: user.a });
  await code(asService(() => v('SELECT publish_monitor_set_auto_review($1,false) v', [user.a])), '42501');
  assert.ok(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [user.a])) > 0);
  // The production path: content scrub, then business pruning, repeated until nothing local remains.
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [user.a]);
  assert.equal(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [user.a])), 0);
  for (const t of ['social_monitor_settings', 'social_posts', 'social_metric_snapshots', 'social_review_runs']) {
    assert.equal(await count(t, user.a), 0, t);
  }
  assert.equal(await v('SELECT count(*)::int v FROM social_connections WHERE id=$1', [bench]), 0);
  const kept = (await c.query('SELECT * FROM social_connections WHERE id=$1', [own])).rows[0];
  assert.equal(kept.status, 'deleting');
  assert.deepEqual([kept.business_id, kept.account_project_id, kept.display_hint, kept.profile_ref, kept.consent_read],
    [null, null, null, null, false]);
  assert.equal(kept.provider_account_id, 'pfm_own_1', 'provider ID stays reserved until provider cleanup');
  assert.equal(await v("SELECT count(*)::int v FROM social_publish_jobs WHERE actor_id=$1 AND state='completed'", [user.a]), 0);
  assert.equal(await v("SELECT business_id IS NULL v FROM social_publish_jobs WHERE actor_id=$1 AND state='unknown'", [user.a]), true);
  // A claimed job holds frozen credits and slots: kept (without brand links) until publishing releases them.
  assert.equal(await v("SELECT business_id IS NULL AND work_item_id IS NULL v FROM social_publish_jobs"
    + " WHERE actor_id=$1 AND state='claimed'", [user.a]), true);
  assert.equal(await v('SELECT business_id IS NULL AND target_account_project_id IS NULL v FROM social_connect_requests'
    + ' WHERE actor_id=$1', [user.a]), true);
  // Brand rows must prune exactly as they do for a user who never used publish-monitor (control).
  const control = await member();
  await closeAccount(c, { actor: control.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [control.a]);
  for (const t of ['opc_accounts', 'opc_businesses']) {
    assert.equal(await count(t, user.a), await count(t, control.a), `${t} prunes like a non-user`);
  }
  assert.equal(await v(`SELECT count(*)::int v FROM social_connections s JOIN opc_accounts o ON o.project_id=s.account_project_id
    WHERE o.actor_id=$1`, [user.a]), 0, 'no retained row references brand rows');
  report.checks.push('erasure prunes posts, snapshots, settings, reviews, finished jobs and TikHub rows; provider-mirroring '
    + 'rows remain only as unbound deletion records; local remaining count reaches zero; brand rows prune exactly as for a non-user');

  assert.equal(await count('social_connections', other.a), 1);
  assert.equal(await count('social_publish_jobs', other.a), 1);
  assert.equal(await v('SELECT count(*)::int v FROM social_connections WHERE id=$1', [otherConn]), 1);
  report.checks.push('another user\'s rows are untouched');

  assert.match(await v("SELECT pg_get_functiondef('public.account_erasure_business_remaining(uuid)'::regprocedure) v"),
    /publish_monitor_erasure_remaining/);
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('business remaining includes publish-monitor rows; account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
