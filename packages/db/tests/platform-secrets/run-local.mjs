/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only ADMIN-SECRETS 0259 verification: builds the full chain without Vault (the migration must
// not need it), then installs the local Vault stand-in and checks grants, the admin-only writers,
// revisions, clearing, audit rows without values, and repeatable application.
// Run: node packages/db/tests/platform-secrets/run-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0259_platform_secrets.sql';
// PAY-NOTIFY extends the slot list in place (adds 'resend'); reapplying 0259 alone restores six slots.
const slotExtensions = readdirSync(new URL('../../migrations/', import.meta.url))
  .filter(f => f.endsWith('_payment_notices.sql')).map(f => `packages/db/migrations/${f}`);
const reapply = async () => { for (const path of [migrationPath, ...slotExtensions]) await c.query(read(path)); };
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0259', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const failure = promise => promise.then(() => null, error => error);
const code = async (promise, expected) => {
  const e = await failure(promise);
  assert.equal(e?.code, expected, e?.message);
  return e;
};
const profile = async (role = 'user', status = 'active', deleted = false) => {
  const id = randomUUID();
  await c.query('INSERT INTO profiles(id,credits,role,status,is_deleted) VALUES($1,0,$2,$3,$4)', [id, role, status, deleted]);
  return id;
};
// Fake values only. CANARY marks text that must never appear outside Vault and the read function.
const CANARY = 'ADMINSECRETSCANARY';
const fake = tail => `sk-or-v1-${CANARY}-fake-${tail}`;
const set = (slot, value, revision, actor) =>
  v('SELECT platform_secret_set($1,$2,$3,$4) v', [slot, value, revision, actor]);
const clear = (slot, revision, actor) => v('SELECT platform_secret_clear($1,$2,$3) v', [slot, revision, actor]);
const readSecret = slot => v('SELECT platform_secret_read($1) v', [slot]);
const status = async slot => (await v('SELECT platform_secret_status() v')).find(row => row.slot === slot);
const audits = async () => (await c.query(
  "SELECT action,admin_id,details FROM user_activity_logs WHERE action LIKE 'platform_secret_%' ORDER BY created_at,id")).rows;
const FUNCTIONS = ['platform_secret_status()', 'platform_secret_set(text,text,bigint,uuid)',
  'platform_secret_clear(text,bigint,uuid)', 'platform_secret_read(text)'];

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await reapply();
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0259 reapplication after the full chain preserves the complete catalog');

  for (const role of ['anon', 'authenticated']) {
    for (const f of [...FUNCTIONS, 'platform_secret_check(text,uuid,bigint)']) {
      assert.equal(await v("SELECT has_function_privilege($1,$2,'execute') v", [role, f]), false, `${role} ${f}`);
    }
  }
  for (const f of FUNCTIONS) assert.equal(await v("SELECT has_function_privilege('service_role',$1,'execute') v", [f]), true, f);
  assert.equal(await v("SELECT has_function_privilege('service_role','platform_secret_check(text,uuid,bigint)','execute') v"), false);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await v('SELECT has_table_privilege($1,$2,$3) v', [role, 'public.platform_secrets', p]), false, `${role} ${p}`);
    }
  }
  report.checks.push('only service_role can call the four entry points; nobody but postgres touches the table');

  const [admin, admin2, user, suspended, deleted] = [await profile('admin'), await profile('admin'), await profile(),
    await profile('admin', 'suspended'), await profile('admin', 'active', true)];
  await c.query('SET ROLE service_role');
  const missing = await code(set('openrouter', fake('a1b2'), 0, admin), '55000');
  assert.match(missing.message, /PLATFORM_SECRET_VAULT_MISSING/);
  assert.equal((await status('openrouter')).configured, false);
  assert.equal(await readSecret('openrouter'), null);
  await c.query('RESET ROLE');
  report.checks.push('without Vault the writer refuses (no clear-text fallback) and nothing is stored');

  await c.query(read('packages/db/tests/platform-secrets/vault_stub.sql'));
  for (const role of ['anon', 'authenticated']) {
    await c.query(`SET ROLE ${role}`);
    for (const sql of ['SELECT platform_secret_status()', "SELECT platform_secret_read('openrouter')",
      `SELECT platform_secret_set('openrouter','${fake('zzzz')}',0,'${admin}')`,
      `SELECT platform_secret_clear('openrouter',0,'${admin}')`, 'SELECT * FROM platform_secrets']) {
      await code(c.query(sql), '42501');
    }
    await c.query('RESET ROLE');
  }
  report.checks.push('anon and authenticated get permission denied on every function and on the table');

  await c.query('SET ROLE service_role');
  for (const actor of [user, suspended, deleted, randomUUID()]) await code(set('openrouter', fake('a1b2'), 0, actor), '42501');
  for (const actor of [user, suspended, deleted]) await code(clear('openrouter', 0, actor), '42501');
  for (const [slot, value] of [['unknown', fake('a1b2')], ['openrouter', 'short-key'], ['openrouter', `${fake('a1')} b2`],
    ['openrouter', `${fake('a1')}\nb2`], ['openrouter', 'x'.repeat(1025)], [null, fake('a1b2')], ['openrouter', null]]) {
    const e = await code(set(slot, value, 0, admin), '23514');
    assert.ok(!e.message.includes(CANARY) && !(e.detail ?? '').includes(CANARY));
  }
  await code(set('openrouter', fake('a1b2'), -1, admin), '23514');
  assert.equal((await status('openrouter')).configured, false);
  assert.equal((await audits()).length, 0);
  report.checks.push('deny: user, suspended, deleted and unknown actors; invalid input refused without echoing it; no audit');

  const first = await set('openrouter', fake('a1b2'), 0, admin);
  assert.equal(first.length, 6 + slotExtensions.length);
  assert.ok(!JSON.stringify(first).includes(CANARY));
  const s1 = await status('openrouter');
  assert.deepEqual({ ...s1, updatedAt: null }, { slot: 'openrouter', configured: true, last4: 'a1b2', revision: 1,
    updatedBy: admin, updatedAt: null });
  assert.match(s1.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.equal(await readSecret('openrouter'), fake('a1b2'));
  assert.equal((await status('postforme')).configured, false);
  assert.equal(await readSecret('postforme'), null);
  await code(set('openrouter', fake('c3d4'), 0, admin), 'PT409');
  assert.equal(await readSecret('openrouter'), fake('a1b2'));
  report.checks.push('admin write stores the value, status shows last 4 only; stale revision is PT409 and changes nothing');

  await c.query('RESET ROLE');
  const vaultId = await v("SELECT vault_secret_id v FROM platform_secrets WHERE slot='openrouter'");
  assert.equal(await v('SELECT count(*)::int v FROM vault.secrets WHERE strpos(secret,$1)>0', [CANARY]), 0);
  await c.query('SET ROLE service_role');
  await set('openrouter', fake('c3d4'), 1, admin2);
  assert.equal(await readSecret('openrouter'), fake('c3d4'));
  assert.equal((await status('openrouter')).updatedBy, admin2);
  await c.query('RESET ROLE');
  assert.equal(await v("SELECT vault_secret_id v FROM platform_secrets WHERE slot='openrouter'"), vaultId);
  assert.equal(await v("SELECT count(*)::int v FROM vault.secrets WHERE name='graylum.platform.openrouter'"), 1);
  await c.query('SET ROLE service_role');
  report.checks.push('replace keeps one Vault entry, records the new operator and returns the new value');

  await clear('openrouter', 2, admin);
  const cleared = await status('openrouter');
  assert.equal(cleared.configured, false);
  assert.equal(cleared.last4, null);
  assert.equal(cleared.revision, 3);
  assert.equal(await readSecret('openrouter'), null);
  await clear('openrouter', 0, admin);
  assert.equal((await status('openrouter')).revision, 3);
  await c.query('RESET ROLE');
  assert.equal(await v("SELECT count(*)::int v FROM vault.secrets WHERE name='graylum.platform.openrouter'"), 0);
  await c.query('SET ROLE service_role');
  report.checks.push('clear removes the Vault entry; clearing an empty slot is a no-op');

  await set('openrouter', fake('e5f6'), 3, admin);
  await set('tikhub', `tikhub-${CANARY}-fake-g7h8`, 0, admin);
  assert.equal(await readSecret('tikhub'), `tikhub-${CANARY}-fake-g7h8`);
  await c.query('RESET ROLE');
  await c.query("DELETE FROM vault.secrets WHERE name='graylum.platform.tikhub'");
  await c.query('SET ROLE service_role');
  await code(readSecret('tikhub'), '55000');
  await set('tikhub', `tikhub-${CANARY}-fake-i9j0`, 1, admin);
  assert.equal(await readSecret('tikhub'), `tikhub-${CANARY}-fake-i9j0`);
  report.checks.push('a dangling Vault reference fails the read loudly and the next write repairs it');

  // Post for Me webhook shared secret: its own slot, independent of the Post for Me API key.
  await set('postforme_webhook', `whsecret-${CANARY}-fake-k1l2`, 0, admin);
  assert.equal(await readSecret('postforme_webhook'), `whsecret-${CANARY}-fake-k1l2`);
  assert.equal(await readSecret('postforme'), null);
  assert.deepEqual((await v('SELECT platform_secret_status() v')).map(row => row.slot),
    ['openrouter', 'postforme', 'postforme_webhook', 'tikhub', 'parallel', 'firecrawl',
      ...(slotExtensions.length ? ['resend'] : [])]);
  await clear('postforme_webhook', 1, admin);
  assert.equal(await readSecret('postforme_webhook'), null);
  report.checks.push('postforme_webhook is its own slot: set, read and clear without touching postforme');

  await c.query('RESET ROLE');
  const rows = await audits();
  assert.deepEqual(rows.map(row => [row.action, row.details.slot, row.details.last4, row.details.previousLast4,
    row.details.revision]), [
    ['platform_secret_set', 'openrouter', 'a1b2', null, 1],
    ['platform_secret_replace', 'openrouter', 'c3d4', 'a1b2', 2],
    ['platform_secret_clear', 'openrouter', null, 'c3d4', 3],
    ['platform_secret_set', 'openrouter', 'e5f6', null, 4],
    ['platform_secret_set', 'tikhub', 'g7h8', null, 1],
    ['platform_secret_replace', 'tikhub', 'i9j0', 'g7h8', 2],
    ['platform_secret_set', 'postforme_webhook', 'k1l2', null, 1],
    ['platform_secret_clear', 'postforme_webhook', null, 'k1l2', 2],
  ]);
  assert.deepEqual(rows.map(row => row.admin_id), [admin, admin2, admin, admin, admin, admin, admin, admin]);
  for (const table of ['user_activity_logs', 'application_logs', 'platform_secrets', 'vault.secrets']) {
    if (!await v('SELECT to_regclass($1) IS NOT NULL v', [table])) continue;
    assert.equal(await v(`SELECT count(*)::int v FROM ${table} t WHERE strpos(t::text,$1)>0`, [CANARY]), 0, table);
  }
  report.checks.push('one audit row per change with slot and last 4 only; no value anywhere outside Vault ciphertext');

  await reapply();
  assert.equal(await v("SELECT platform_secret_read('openrouter') v"), fake('e5f6'));
  report.checks.push('reapplying 0259 with data present keeps the stored secrets');

  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
