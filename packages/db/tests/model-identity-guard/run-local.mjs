/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only MODEL-IDENTITY-GUARD 0216 verification: default, admin-only writer,
// audit record, optimistic revision race and the direct-write guard.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0216_model_identity_guard_switch.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0216', checks: [] };
const v = async (sql, args = [], client = c) => (await client.query(sql, args)).rows[0]?.v;
const code = async (promise, expected) => { const e = await promise.then(() => null, x => x); assert.equal(e?.code, expected, e?.message); };
const profile = async (role = 'user', status = 'active', deleted = false) => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits,role,status,is_deleted) VALUES($1,0,$2,$3,$4)', [id, role, status, deleted]);
  return id;
};
const set = (enabled, revision, actor, client = c) =>
  v('SELECT model_identity_guard_set($1,$2,$3) v', [enabled, revision, actor], client);
const config = () => v('SELECT model_identity_guard_config() v');
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0216 reapplication after the full chain preserves the complete catalog');

  for (const role of ['anon', 'authenticated']) {
    for (const f of ['model_identity_guard_config()', 'model_identity_guard_set(boolean,bigint,uuid)',
      'model_identity_guard_settings_guard()']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
  }
  for (const f of ['model_identity_guard_config()', 'model_identity_guard_set(boolean,bigint,uuid)']) {
    assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true);
  }
  report.checks.push('only service_role can call the reader and writer');

  assert.deepEqual(await config(), { version: 1, enabled: true, revision: 0, updatedBy: null, updatedAt: null });
  report.checks.push('absent key defaults to enabled');

  const [admin, user, suspended, deleted] = [await profile('admin'), await profile(), await profile('admin', 'suspended'),
    await profile('admin', 'active', true)];
  await c.query('SET ROLE service_role');
  for (const actor of [user, suspended, deleted, randomUUID()]) await code(set(false, 0, actor), '42501');
  assert.equal((await config()).enabled, true);
  const off = await set(false, 0, admin);
  assert.equal(off.enabled, false);
  assert.equal(off.revision, 1);
  assert.equal(off.updatedBy, admin);
  assert.match(off.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  await code(set(true, 0, admin), 'PT409');
  assert.equal((await config()).enabled, false);
  assert.equal((await set(true, 1, admin)).revision, 2);
  await code(set(null, 2, admin), '23514');
  report.checks.push('deny: non-admin, suspended, deleted and unknown actors; allow: active admin; stale revision PT409');

  await code(c.query("UPDATE system_settings SET value=jsonb_set(value,'{enabled}','false') WHERE key='model_identity_guard'"), '42501');
  await code(c.query("DELETE FROM system_settings WHERE key='model_identity_guard'"), '42501');
  await code(c.query("INSERT INTO system_settings(key,value) VALUES('model_identity_guard','{}') ON CONFLICT(key) DO UPDATE SET value=excluded.value"), '42501');
  assert.equal((await config()).enabled, true);
  await c.query("INSERT INTO system_settings(key,value) VALUES('model_identity_guard_other','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  await c.query("UPDATE system_settings SET value='2' WHERE key='model_identity_guard_other'");
  await c.query('RESET ROLE');
  await c.query("DELETE FROM system_settings WHERE key='model_identity_guard_other'");
  report.checks.push('direct service-role writes to the key are rejected; other keys are unaffected');

  const logs = (await c.query("SELECT admin_id,action_type,details FROM user_activity_logs WHERE action='model_identity_guard_set' ORDER BY created_at,id")).rows;
  assert.equal(logs.length, 2);
  assert.ok(logs.every(row => row.admin_id === admin && row.action_type === 'settings'));
  assert.deepEqual(logs.map(row => row.details.enabled).sort(), [false, true]);
  report.checks.push('each successful change writes one audit row; refused changes write none');

  await c.query("UPDATE system_settings SET value='\"text\"' WHERE key='model_identity_guard'");
  await assert.rejects(config(), /MODEL_IDENTITY_GUARD_CONFIG_INVALID/);
  await c.query("DELETE FROM system_settings WHERE key='model_identity_guard'");
  assert.equal((await config()).enabled, true);
  report.checks.push('malformed stored value fails closed; postgres can delete the key to recover the default (on)');

  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
