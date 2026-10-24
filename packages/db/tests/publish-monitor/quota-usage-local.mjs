/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR (0354) verification: the read-only publish count of the current billing period.
// Run: node packages/db/tests/publish-monitor/quota-usage-local.mjs --local-only
import assert from 'node:assert/strict';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0354_publish_monitor_quota_usage.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0354', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const svc = async (sql, args = []) => {
  await c.query('SET ROLE service_role');
  try { return (await c.query(sql, args)).rows[0]?.v; } finally { await c.query('RESET ROLE'); }
};
const usage = () => svc('SELECT publish_monitor_quota_usage() v');
const setting = value => c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_publish_quota',$1::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(value)]);

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0354 reapplication preserves the complete catalog');

  const fn = 'publish_monitor_quota_usage()';
  for (const role of ['anon', 'authenticated']) assert.equal(await v('SELECT has_function_privilege($1,$2,\'EXECUTE\') v', [role, fn]), false, role);
  assert.equal(await v('SELECT has_function_privilege(\'service_role\',$1,\'EXECUTE\') v', [fn]), true);
  report.checks.push('only the server role may call it');

  await c.query("DELETE FROM system_settings WHERE key='publish_monitor_publish_quota'");
  assert.deepEqual(await usage(), { configured: false });
  await setting({ limit: 0, periodAnchor: '2026-10-13T00:00:00Z' });
  assert.deepEqual(await usage(), { configured: false });
  await setting({ limit: 1000, periodAnchor: '2999-01-01T00:00:00Z' });
  assert.deepEqual(await usage(), { configured: false }, 'an anchor in the future is not a configured period');
  report.checks.push('a missing, zero or future-anchored setting reads as not configured, never as an error');

  await setting({ limit: 1000, periodAnchor: '2026-10-13T00:00:00Z' });
  const empty = await usage();
  assert.deepEqual([empty.configured, empty.limit, empty.used, empty.reserved], [true, 1000, 0, 0], 'a period nobody published in reads as zero');
  assert.ok(new Date(empty.periodStart) <= new Date() && new Date() < new Date(empty.periodEnd));
  await c.query('INSERT INTO social_publish_quota_periods(period_start,period_end,slot_limit,used,reserved) VALUES($1,$2,1000,17,3)',
    [empty.periodStart, empty.periodEnd]);
  const filled = await usage();
  assert.deepEqual([filled.used, filled.reserved, filled.limit], [17, 3, 1000]);
  assert.deepEqual(Object.keys(filled).sort(), ['configured', 'limit', 'periodEnd', 'periodStart', 'reserved', 'used']);
  report.checks.push('the current period reports its start, end, limit, delivered and held counts and nothing else');

  const rows = await v('SELECT count(*)::int v FROM social_publish_quota_periods');
  await usage();
  assert.equal(await v('SELECT count(*)::int v FROM social_publish_quota_periods'), rows, 'reading changes nothing');
  report.checks.push('reading writes nothing');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
