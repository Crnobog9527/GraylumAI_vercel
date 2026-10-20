/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only ADMIN-SECRETS OR-1 verification: the migration that moves the OpenRouter key from ai_models.api_key
// into the Vault `openrouter` slot, and its hand-run rollback. Builds the full chain from files (the slot stays
// empty: no model rows), installs the local Vault stand-in, then reapplies the migration against each case.
// Run: node packages/db/tests/platform-secrets/run-or1-local.mjs --local-only
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read, root } from '../runtime-view-perf/local-db.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) throw new Error('Require --local-only');
const migrationPath = 'packages/db/migrations/' + readdirSync(root + '/packages/db/migrations')
  .find(name => /^\d{4}_openrouter_key_to_vault\.sql$/.test(name));
const rollbackPath = 'packages/db/tests/admin-secrets-or1-rollback.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: migrationPath.split('/').at(-1), checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const failure = promise => promise.then(() => null, error => error);
// The full-chain fixture already includes OR-2. Recreate the legacy schema locally so this historical
// migration test can continue covering OR-1's data-move behavior with synthetic rows only.
await c.query('ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS api_key text');
// Fake values only.
const CANARY = 'OR1CANARY', fake = tail => `sk-or-v1-${CANARY}-fake-${tail}`;
const KEY = fake('original-a1b2'), REPLACED = fake('replaced-c3d4');
const account = key => 'openrouter-key:' + createHash('sha256').update(key).digest('hex');
const model = async (key, endpoint = '') => {
  const id = randomUUID();
  await c.query("INSERT INTO ai_models(id,name,model_id,provider,is_active,api_key,api_endpoint) VALUES($1,'OR-1 fixture','synthetic/or1','openai','true',$2,$3)",
    [id, key, endpoint]);
  return id;
};
const reset = async () => {
  await c.query('DELETE FROM ai_models'); await c.query("DELETE FROM user_activity_logs WHERE action LIKE 'platform_secret_%'");
  await c.query("DELETE FROM vault.secrets WHERE name='graylum.platform.openrouter'"); await c.query("DELETE FROM platform_secrets WHERE slot='openrouter'");
};
const migrate = () => c.query(read(migrationPath));
const slot = () => v("SELECT platform_secret_read('openrouter') v");
const audits = async () => (await c.query("SELECT admin_id,details FROM user_activity_logs WHERE action='platform_secret_migrate' ORDER BY created_at")).rows;
try {
  assert.equal(await v("SELECT count(*)::int v FROM platform_secrets WHERE slot='openrouter' AND vault_secret_id IS NOT NULL"), 0);
  report.checks.push('file-built chain: no model rows, the slot stays empty and the migration needs no Vault');
  await c.query(read('packages/db/tests/platform-secrets/vault_stub.sql'));

  await reset(); await migrate(); await migrate();
  assert.equal(await slot(), null); assert.deepEqual(await audits(), []);
  report.checks.push('no key in any row: nothing happens, no audit');

  await reset(); await model(KEY); await model(' ' + KEY + ' '); await model(null); await model('');
  await migrate();
  assert.equal(await slot(), KEY);
  assert.equal(account(await slot()), account(KEY), 'fingerprint of the moved key equals the quoted one');
  const [audit] = await audits();
  assert.equal(audit.admin_id, null);
  assert.deepEqual(audit.details, { slot: 'openrouter', last4: 'a1b2', previousLast4: null, revision: 1, previousRevision: 0, source: 'ai_models.api_key' });
  assert.equal((await v("SELECT row_to_json(p)::jsonb v FROM platform_secrets p WHERE slot='openrouter'")).last4, 'a1b2');
  for (const table of ['user_activity_logs', 'platform_secrets', 'vault.secrets'])
    assert.equal(await v(`SELECT count(*)::int v FROM ${table} t WHERE strpos(t::text,'OR1CANARY')>0`), 0, table);
  report.checks.push('one distinct key (blank and padded rows included): moved into Vault, same fingerprint, one audit row without the value');

  const before = (await c.query("SELECT * FROM platform_secrets WHERE slot='openrouter'")).rows[0];
  await migrate();
  assert.deepEqual((await c.query("SELECT * FROM platform_secrets WHERE slot='openrouter'")).rows[0], before);
  assert.equal((await audits()).length, 1);
  report.checks.push('repeat run with the slot filled: no change, no second audit');

  // An admin clears the slot, the legacy column still holds the old key: a re-run must not bring it back.
  const clearer = randomUUID();
  await c.query("INSERT INTO profiles(id,credits,role,status,is_deleted) VALUES($1,0,'admin','active',false)", [clearer]);
  await c.query('SELECT platform_secret_clear($1,$2,$3)', ['openrouter', await v("SELECT revision::int v FROM platform_secrets WHERE slot='openrouter'"), clearer]);
  assert.equal(await slot(), null);
  const auditsBefore = (await audits()).length;
  await migrate(); await migrate();
  assert.equal(await slot(), null, 'a cleared slot stays cleared');
  assert.equal((await audits()).length, auditsBefore, 'no second platform_secret_migrate audit');
  assert.equal(await v("SELECT count(*)::int v FROM vault.secrets WHERE name='graylum.platform.openrouter'"), 0);
  report.checks.push('clear then re-run: the cleared slot stays cleared, the legacy key is not restored, no audit');

  await reset(); await model(KEY); await model(REPLACED);
  const ambiguous = await failure(migrate());
  assert.match(ambiguous?.message ?? '', /OPENROUTER_KEY_MIGRATION_AMBIGUOUS/);
  assert.doesNotMatch(ambiguous.message, /OR1CANARY/);
  await c.query('ROLLBACK').catch(() => {});
  assert.equal(await slot(), null); assert.deepEqual(await audits(), []);
  report.checks.push('two distinct keys: stops with a code only, stores nothing');

  await reset(); await model('short-key');
  assert.match((await failure(migrate()))?.message ?? '', /OPENROUTER_KEY_MIGRATION_INVALID/);
  await c.query('ROLLBACK').catch(() => {});
  report.checks.push('a value platform_secret_set would refuse is refused here too');

  // Rollback after the admin replaced the key: the CURRENT key goes back into every OpenRouter row.
  await reset(); const a = await model(KEY), b = await model(KEY, 'https://openrouter.ai/api/v1'), padded = await model(KEY, '  https://openrouter.ai/api/v1/chat/completions '),
    withPort = await model(KEY, 'https://openrouter.ai:443/api/v1/chat/completions'), upper = await model(KEY, 'HTTPS://OpenRouter.AI/api/v1'),
    lookalike = await model(null, 'https://openrouter.ai.evil.test/api/v1'), otherPort = await model(null, 'https://openrouter.ai:8443/api/v1'),
    other = await model(null, 'https://api.example.test/v1');
  await migrate();
  const admin = randomUUID();
  await c.query("INSERT INTO profiles(id,credits,role,status,is_deleted) VALUES($1,0,'admin','active',false)", [admin]);
  await c.query('SELECT platform_secret_set($1,$2,$3,$4)', ['openrouter', REPLACED, 1, admin]);
  await c.query(read(rollbackPath));
  const keys = Object.fromEntries((await c.query('SELECT id,api_key FROM ai_models')).rows.map(row => [row.id, row.api_key]));
  assert.deepEqual(keys, { [a]: REPLACED, [b]: REPLACED, [padded]: REPLACED, [withPort]: REPLACED, [upper]: REPLACED,
    [lookalike]: null, [otherPort]: null, [other]: null });
  report.checks.push('rollback after a replacement writes the current key (not the retired one) into OpenRouter rows only, padded, default-port and upper-case OpenRouter addresses included, look-alike hosts and other ports not');

  await c.query("UPDATE platform_secrets SET vault_secret_id=NULL,last4=NULL WHERE slot='openrouter'");
  assert.match((await failure(c.query(read(rollbackPath))))?.message ?? '', /OPENROUTER_KEY_ROLLBACK_SLOT_EMPTY/);
  await c.query('ROLLBACK').catch(() => {});
  report.checks.push('rollback refuses when the slot is empty');

  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
