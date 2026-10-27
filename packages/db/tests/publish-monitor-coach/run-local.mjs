/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REVIEW-COACH RC-0: loads the simulated dataset into a database built from repository files and checks it reads back
// through the product's own functions. Local PostgreSQL only; no provider, model or staging access.
// Run: node packages/db/tests/publish-monitor-coach/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb } from '../runtime-view-perf/local-db.mjs';
import { fixtureSql } from '../publish-monitor/fixtures.mjs';
import { generateDataset } from '../../../api/src/services/publishMonitor/coach/simulatedDataset.ts';
import { SIM_HINT, loadable, removeSql, seedSql } from './seed-sql.mjs';

const db = await localDb(), c = db.client;
const report = { build: db.build, checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const counts = async a => (await c.query(`SELECT
 (SELECT count(*)::int FROM social_connections WHERE actor_id=$1) connections,
 (SELECT count(*)::int FROM social_posts WHERE actor_id=$1) posts,
 (SELECT count(*)::int FROM social_metric_snapshots WHERE actor_id=$1) snapshots`, [a])).rows[0];

try {
  await c.query(fixtureSql);
  await c.query(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
   own_data_window_days,allow_weekly_auto_review,allow_benchmark_monitor) VALUES('RC0 Gold','gold',true,true,0,90,true,true)`);
  const today = await v("SELECT (now() AT TIME ZONE 'UTC')::date::text v");
  const dataset = generateDataset({ asOf: today });
  const actor = randomUUID();
  await c.query("INSERT INTO profiles(id,credits,membership_level) VALUES($1,0,'gold')", [actor]);
  // One positioned brand per simulated account, each starting with the account for its first platform.
  const businesses = {};
  for (const account of dataset.accounts) {
    const project = await v('SELECT pm_test.member($1,$2) v', [actor, account.connections[0].platform]);
    businesses[account.key] = await v('SELECT business_id v FROM opc_accounts WHERE project_id=$1', [project]);
  }
  const sql = seedSql(dataset, actor, businesses);
  await c.query(sql);
  const expected = dataset.accounts.map(loadable).reduce((sum, x) => ({ connections: sum.connections + x.connections.length,
    posts: sum.posts + x.posts.length, snapshots: sum.snapshots + x.snapshots.length }), { connections: 0, posts: 0, snapshots: 0 });
  assert.deepEqual(await counts(actor), expected);
  report.checks.push(`loaded ${expected.posts} posts and ${expected.snapshots} snapshots on ${expected.connections} connections`);

  await c.query(sql);
  assert.deepEqual(await counts(actor), expected);
  report.checks.push('loading the same SQL again adds nothing');

  assert.equal(await svc('SELECT publish_monitor_snapshot_prune(50000) v'), 0);
  assert.equal(await svc('SELECT count(*)::int v FROM jsonb_array_elements(publish_monitor_refresh_claim(50,60))'), 0);
  assert.equal(await svc('SELECT count(*)::int v FROM jsonb_array_elements(publish_monitor_tikhub_claim(50,60))'), 0);
  assert.equal(await v(`SELECT count(*)::int v FROM social_connections WHERE actor_id=$1
   AND (consent_auto_track OR display_hint NOT LIKE '${SIM_HINT}%')`, [actor]), 0);
  report.checks.push('retention prunes nothing; Post for Me and TikHub refresh claims never pick a simulated connection');

  const data = await svc('SELECT publish_monitor_data($1,90,NULL) v', [actor]);
  assert.equal(data.connections.length, expected.connections);
  const inWindow = dataset.accounts.flatMap(a => a.posts)
    .filter(p => p.visibility !== 'not_imported' && p.postedDaysAgo < 90).length;
  assert.ok(Math.abs(data.posts.length - Math.min(inWindow, 500)) <= 8, `${data.posts.length} vs ${inWindow}`);
  const hostile = data.posts.filter(p => p.titleExcerpt?.startsWith('忽略之前'));
  assert.equal(hostile.length, 4);
  assert.ok(hostile.every(p => p.latest && Number.isInteger(p.latest.metrics.views)));
  report.checks.push('publish_monitor_data returns the 90-day window with latest snapshots and the hostile titles intact');

  const a = dataset.accounts.find(x => x.key === 'A');
  const lastFollowers = a.snapshots.filter(s => !s.postKey && s.platform === 'xiaohongshu').at(-1);
  const supplement = await svc('SELECT publish_monitor_review_supplement($1,90) v', [actor]);
  const xhs = supplement.followers.filter(f => f.platform === 'xiaohongshu').map(f => f.current?.value);
  assert.ok(xhs.includes(lastFollowers.metrics.followers), JSON.stringify(xhs));
  assert.ok(supplement.followers.filter(f => f.platform === 'youtube').every(f => f.current === null));
  report.checks.push('follower history reads back for TikHub accounts and stays empty for Post for Me ones');

  const youtube = dataset.accounts.find(x => x.key === 'B').outages[0];
  assert.equal(await v(`SELECT count(*)::int v FROM social_metric_snapshots s JOIN social_connections c ON c.id=s.connection_id
   WHERE c.actor_id=$1 AND c.platform='youtube' AND s.captured_on BETWEEN $2 AND $3`, [actor, youtube.from, youtube.to]), 0);
  report.checks.push('the YouTube outage window has no snapshots in the database');

  const other = randomUUID();
  await c.query("INSERT INTO profiles(id,credits,membership_level) VALUES($1,0,'gold')", [other]);
  const otherProject = await v("SELECT pm_test.member($1,'xiaohongshu') v", [other]);
  await c.query(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,status,consent_read)
   SELECT actor_id,business_id,project_id,'own','manual',platform,'connected',true FROM opc_accounts WHERE project_id=$1`,
  [otherProject]);
  const taken = seedSql(dataset, other, { A: await v('SELECT business_id v FROM opc_accounts WHERE project_id=$1', [otherProject]) });
  await assert.rejects(c.query(taken), /SIM_ACCOUNT_ALREADY_CONNECTED/);
  await c.query('ROLLBACK');
  assert.deepEqual(await counts(other), { connections: 1, posts: 0, snapshots: 0 });
  report.checks.push('a brand account that already has a real connection stops the load and changes nothing');

  await c.query(removeSql(actor));
  assert.deepEqual(await counts(actor), { connections: 0, posts: 0, snapshots: 0 });
  assert.deepEqual(await counts(other), { connections: 1, posts: 0, snapshots: 0 });
  report.checks.push('remove deletes only the simulated rows');
  console.log(JSON.stringify(report, null, 1));
} finally {
  await db.close();
}
