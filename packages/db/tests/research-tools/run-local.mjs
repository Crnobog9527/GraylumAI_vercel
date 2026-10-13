/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only RESEARCH-TOOLS 0254 verification: admin-only writer, server-stamped hard-cap
// attestations (no supplier can be enabled without one), revision race, direct-write guard,
// and audit rows that hold summaries only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0254_research_tools_config.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0254', checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => { const e = await promise.then(() => null, x => x); assert.equal(e?.code, expected, `${e?.message} | ${e?.where} | ${e?.detail}`); };
const profile = async (role = 'user', status = 'active', deleted = false) => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits,role,status,is_deleted) VALUES($1,0,$2,$3,$4)', [id, role, status, deleted]);
  return id;
};
const config = (enabled = {}, extra = {}) => ({
  version: 1, enabled: true,
  vendors: Object.fromEntries(['tikhub', 'parallel', 'firecrawl'].map(k => [k, { enabled: !!enabled[k] }])),
  verifiedPlatforms: [], benchmarkPlatforms: [], routes: [],
  limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 },
  recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' }, ...extra,
});
const set = (cfg, attest, revision, actor) =>
  v('SELECT research_tools_config_set($1::jsonb,$2::text[],$3,$4) v', [JSON.stringify(cfg), attest, revision, actor]);
const stored = () => v("SELECT value v FROM system_settings WHERE key='research_tools_config'");
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0254 reapplication after the full chain preserves the complete catalog');

  for (const role of ['anon', 'authenticated']) {
    for (const f of ['research_tools_config_set(jsonb,text[],bigint,uuid)', 'research_tools_settings_guard()']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
  }
  assert.equal(await v("SELECT has_function_privilege('service_role','research_tools_config_set(jsonb,text[],bigint,uuid)','execute') v"), true);
  report.checks.push('only service_role can call the writer');

  const [admin, user, suspended, deleted] = [await profile('admin'), await profile(), await profile('admin', 'suspended'),
    await profile('admin', 'active', true)];
  await c.query('SET ROLE service_role');
  for (const actor of [user, suspended, deleted, randomUUID()]) await code(set(config(), [], 0, actor), '42501');
  assert.equal(await stored(), undefined);
  const first = await set(config(), [], 0, admin);
  assert.equal(first.revision, 1);
  assert.equal(first.updatedBy, admin);
  report.checks.push('deny: non-admin, suspended, deleted and unknown actors; allow: active admin');

  await code(set(config({ tikhub: true }), [], 1, admin), '23514');
  assert.equal((await stored()).vendors.tikhub.enabled, false);
  const forged = config({ tikhub: true });
  forged.vendors.tikhub.hardCapAttested = { by: admin, at: '2026-01-01T00:00:00Z' };
  await code(set(forged, [], 1, admin), '23514');
  const attested = await set(config({ tikhub: true }), ['tikhub'], 1, admin);
  assert.equal(attested.vendors.tikhub.enabled, true);
  assert.equal(attested.vendors.tikhub.hardCapAttested.by, admin);
  assert.match(attested.vendors.tikhub.hardCapAttested.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  const kept = await set(config({}), [], 2, admin);
  assert.deepEqual(kept.vendors.tikhub.hardCapAttested, attested.vendors.tikhub.hardCapAttested);
  assert.equal((await set(config({ tikhub: true }), [], 3, admin)).vendors.tikhub.enabled, true);
  report.checks.push('no supplier can be enabled without a hard-cap attestation; client-supplied attestations are ignored; server-stamped ones persist');

  await code(set(config(), [], 0, admin), 'PT409');
  await code(set(config({}, { revision: 99 }), [], 4, admin), '23514');
  await code(set(config(), ['brightdata'], 4, admin), '23514');
  await code(set({ ...config(), vendors: { tikhub: { enabled: true } } }, [], 4, admin), '23514');
  report.checks.push('stale revisions PT409; client revision, unknown suppliers and missing switches rejected');

  await code(c.query("UPDATE system_settings SET value=jsonb_set(value,'{enabled}','false') WHERE key='research_tools_config'"), '42501');
  await code(c.query("DELETE FROM system_settings WHERE key='research_tools_config'"), '42501');
  await code(c.query("INSERT INTO system_settings(key,value) VALUES('research_tools_config','{}') ON CONFLICT(key) DO UPDATE SET value=excluded.value"), '42501');
  await c.query("INSERT INTO system_settings(key,value) VALUES('research_tools_other','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  await c.query('RESET ROLE');
  await c.query("DELETE FROM system_settings WHERE key='research_tools_other'");
  report.checks.push('direct service-role writes (incl. the generic settings upsert path) are rejected; other keys unaffected');

  const logs = (await c.query("SELECT admin_id,action_type,details FROM user_activity_logs WHERE action='research_tools_config_set' ORDER BY created_at,id")).rows;
  assert.equal(logs.length, 4);
  assert.ok(logs.every(row => row.admin_id === admin && row.action_type === 'settings'));
  assert.deepEqual(logs.map(row => row.details.revision), [1, 2, 3, 4]);
  assert.deepEqual(logs[1].details.hardCapAttested, ['tikhub']);
  for (const row of logs) {
    assert.deepEqual(Object.keys(row.details).sort(),
      ['enabled', 'hardCapAttested', 'previousEnabled', 'previousRevision', 'revision', 'valueSha256', 'vendorsEnabled']);
    assert.match(row.details.valueSha256, /^[0-9a-f]{64}$/);
  }
  report.checks.push('each successful change writes one summary audit row (no full value, no secrets); refused changes write none');

  await c.query("DELETE FROM system_settings WHERE key='research_tools_config'");
  assert.equal(await stored(), undefined);
  report.checks.push('postgres can delete the key, which turns every research call off');

  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
