/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR PR-4a (0288) verification: own Xiaohongshu/Douyin connections, Gold benchmark accounts
// with a per-brand cap, the daily TikHub claim, writing a read, and erasure.
// Run: node packages/db/tests/publish-monitor/tikhub-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { closeAccount } from '../erasure-b2a/cases.mjs';
import { fixtureSql } from './fixtures.mjs';

const MIGRATION = 'packages/db/migrations/0288_publish_monitor_tikhub.sql';
const rpcs = ['publish_monitor_tikhub_connect(uuid,uuid,text,text,boolean)',
  'publish_monitor_benchmark_add(uuid,uuid,text,text,text,integer)', 'publish_monitor_tikhub_claim(integer,integer)',
  'publish_monitor_tikhub_write(uuid,uuid,uuid,jsonb,jsonb,text)'];
const internal = ['publish_monitor_tikhub_own_platform(text)', 'publish_monitor_tikhub_item(social_connections)'];
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0288', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => assert.equal((await promise.then(() => null, e => e))?.code, expected);
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const j = x => JSON.stringify(x);
const XHS = '61b46d790000000010008153';
const member = async (plat = 'xiaohongshu') => {
  const a = randomUUID();
  await c.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [a]);
  const account = await v('SELECT pm_test.member($1,$2) v', [a, plat]);
  return { a, account, business: await v('SELECT business_id v FROM opc_accounts WHERE project_id=$1', [account]) };
};
const connect = (m, plat, ref, track = true) => svc('SELECT publish_monitor_tikhub_connect($1,$2,$3,$4,$5) v',
  [m.a, m.account, plat, ref, track]);
const bench = (m, plat, ref, max = 2) => svc('SELECT publish_monitor_benchmark_add($1,$2,$3,$4,$5,$6) v',
  [m.a, m.business, plat, ref, null, max]);
const claimAll = () => svc('SELECT publish_monitor_tikhub_claim(200,120) v');
const write = (k, profile, posts) => svc('SELECT publish_monitor_tikhub_write($1,$2,$3,$4,$5,$6) v',
  [k.connectionId, k.lease, k.refreshId, profile === null ? null : j(profile), j(posts), 'tikhub:test']);
const finish = (k, outcome) => svc('SELECT publish_monitor_refresh_finish($1,$2,$3,$4,$5) v',
  [k.connectionId, k.lease, k.refreshId, outcome, null]);
const row = id => c.query('SELECT * FROM social_connections WHERE id=$1', [id]).then(r => r.rows[0]);

try {
  await c.query(fixtureSql);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(MIGRATION));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('reapplication preserves the complete catalog');
  for (const f of [...rpcs, ...internal]) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
    assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), rpcs.includes(f), f);
  }
  report.checks.push('four RPCs for service_role only, two internal helpers; clients have no access');

  // Own accounts: only Xiaohongshu/Douyin, only on a brand account of the same platform, never over Post for Me.
  const u = await member('xiaohongshu'), other = await member('xiaohongshu'), yt = await member('youtube');
  const own = await connect(u, 'xiaohongshu', XHS);
  await code(connect(u, 'douyin', XHS), '22023');
  await code(connect(yt, 'youtube', 'UCLA_DiR1FfKNvjuUpBHmylQ'), '22023');
  await code(svc('SELECT publish_monitor_tikhub_connect($1,$2,$3,$4,$5) v', [other.a, u.account, 'xiaohongshu', XHS, true]), 'P0002');
  // A manual-only connection is upgraded in place.
  const mm = await member('douyin');
  const manual = await svc('SELECT publish_monitor_manual_import($1,$2,$3,$4) v', [mm.a, mm.account, 'link',
    j([{ postKey: 'p1', url: null, postedAt: null, titleExcerpt: null, metrics: { likes: 1 } }])]);
  const up = await connect(mm, 'douyin', 'MS4wLjABAAAA0123456789abcdefghijklmn');
  assert.equal(up.connectionId, manual.connectionId);
  assert.equal((await row(up.connectionId)).source, 'tikhub');
  report.checks.push('own TikHub accounts: own platform only, own brand account only, manual-only connections upgrade in place');

  // Benchmarks: per-brand cap, once per brand, no brand account binding.
  await bench(u, 'xiaohongshu', '61b46d790000000010008154');
  await code(bench(u, 'xiaohongshu', '61b46d790000000010008154'), 'PT409');
  await bench(u, 'tiktok', 'natgeo');
  await code(bench(u, 'douyin', 'MS4wLjABAAAAzzzzzzzzzzzzzzzzzzzzzzzz'), 'PT409');
  await code(svc('SELECT publish_monitor_benchmark_add($1,$2,$3,$4,$5,$6) v', [other.a, u.business, 'tiktok', 'x', null, 5]), 'P0002');
  assert.equal(await v("SELECT count(*)::int v FROM social_connections WHERE business_id=$1 AND role='benchmark'", [u.business]), 2);
  report.checks.push('benchmarks: at most the admin cap per brand, the same profile once, only on the user\'s own brand');

  // Daily claim: own with auto-track, all benchmarks; once per UTC day; Post for Me rows are not claimed here.
  const noTrack = await member('douyin');
  await connect(noTrack, 'douyin', 'MS4wLjABAAAA0123456789abcdefghijklmo', false);
  const claimed = await claimAll();
  const ids = claimed.map(x => x.connectionId);
  assert.ok(ids.includes(own.connectionId));
  assert.equal(claimed.filter(x => x.role === 'benchmark').length >= 2, true);
  assert.equal(claimed.some(x => x.account === 'MS4wLjABAAAA0123456789abcdefghijklmo'), false, 'no auto-track, no daily read');
  assert.deepEqual(await claimAll(), [], 'leased rows are not handed out twice');
  report.checks.push('daily claim: own accounts with auto-track and benchmarks, leased once');

  // Writing a read: account snapshot and post snapshots, idempotent, missing fields kept.
  const k = claimed.find(x => x.connectionId === own.connectionId);
  const posts = [{ platformPostId: 'n1', url: 'https://www.xiaohongshu.com/explore/n1', postedAt: new Date().toISOString(),
    titleExcerpt: 't', metrics: { likes: 3 }, missingFields: ['views'] }];
  assert.deepEqual(await write(k, { metrics: { followers: 100 }, missingFields: ['likesTotal'] }, posts), { stale: false, inserted: 1, existing: 0 });
  assert.deepEqual(await write(k, { metrics: { followers: 101 }, missingFields: [] }, posts), { stale: false, inserted: 0, existing: 1 });
  assert.equal(await v('SELECT count(*)::int v FROM social_metric_snapshots WHERE connection_id=$1', [own.connectionId]), 2);
  assert.equal(await v('SELECT (metrics->>\'followers\')::int v FROM social_metric_snapshots WHERE connection_id=$1 AND post_id IS NULL',
    [own.connectionId]), 101);
  assert.deepEqual(await write({ ...k, lease: randomUUID() }, null, posts), { stale: true });
  assert.equal(await finish(k, 'done'), true);
  assert.equal((await row(own.connectionId)).refresh_state, 'ok');
  const data = await svc('SELECT publish_monitor_data($1,30,NULL) v', [u.a]);
  assert.deepEqual(data.posts.map(x => [x.source, x.latest.missingFields]), [['tikhub', ['views']]]);
  report.checks.push('a read writes one account and one post snapshot a day, idempotently; missing fields stay listed');

  // Switching the profile on a brand account starts a fresh history.
  await connect(u, 'xiaohongshu', '61b46d790000000010008155');
  assert.equal(await v("SELECT count(*)::int v FROM social_posts WHERE connection_id=$1 AND source='tikhub'", [own.connectionId]), 0);
  report.checks.push('a new profile on the same brand account drops the old profile\'s TikHub data');

  // Erasure removes TikHub connections locally (no provider account to delete).
  await closeAccount(c, { actor: u.a });
  for (let i = 0; i < 10; i++) await c.query('SELECT account_erasure_local_cleanup($1,true)', [u.a]);
  assert.equal(Number(await v('SELECT publish_monitor_erasure_remaining($1) v', [u.a])), 0);
  assert.equal(await v('SELECT count(*)::int v FROM social_connections WHERE actor_id=$1', [u.a]), 0);
  report.checks.push('erasure removes TikHub own and benchmark connections and their data');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
