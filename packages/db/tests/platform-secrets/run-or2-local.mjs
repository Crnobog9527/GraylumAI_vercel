/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only ADMIN-SECRETS OR-2 verification: synthesize the legacy column in a disposable full-chain database,
// apply the migration twice, then hand-run the recovery script after replacing the Vault value.
// No remote database or provider credential is used. Run: node packages/db/tests/platform-secrets/run-or2-local.mjs --local-only
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { localDb, read, root } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/' + readdirSync(root + '/packages/db/migrations')
  .find(name => /^\d{4}_admin_secrets_or2_drop_model_key\.sql$/.test(name));
const recoveryPath = 'packages/db/tests/admin-secrets-or2-rollback.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: migrationPath.split('/').at(-1), checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const columnPresent = async () => v(`SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='ai_models' AND column_name='api_key') v`);
const migration = () => c.query(read(migrationPath));
const profile = randomUUID();
const oldA = 'or2_legacy_fake_a1b2', oldB = 'or2_legacy_fake_c3d4';
const current = 'or2_current_fake_e5f6';
const replaced = 'or2_replaced_fake_7890';
const setSecret = async (value, revision) => {
  await c.query('SET ROLE service_role');
  try { return await c.query('SELECT public.platform_secret_set($1,$2,$3,$4)', ['openrouter', value, revision, profile]); }
  finally { await c.query('RESET ROLE'); }
};
try {
  await c.query(read('packages/db/tests/platform-secrets/vault_stub.sql'));
  await c.query('ALTER TABLE public.ai_models ADD COLUMN IF NOT EXISTS api_key text');
  await c.query("INSERT INTO profiles(id,credits,role,status,is_deleted) VALUES($1,0,'admin','active',false)", [profile]);
  await setSecret(current, 0);
  const rows = [
    [randomUUID(), 'or2-default', '', oldA],
    [randomUUID(), 'or2-explicit', 'https://openrouter.ai/api/v1/chat/completions', oldB],
    [randomUUID(), 'or2-other', 'https://api.example.test/v1', oldA],
  ];
  for (const [id, model, endpoint, key] of rows) await c.query(
    `INSERT INTO public.ai_models(id,model_id,name,provider,is_active,api_key,api_endpoint)
     VALUES($1,$2,$2,'openai','true',$3,$4)`, [id, model, key, endpoint]);
  await c.query('GRANT SELECT(api_key) ON TABLE public.ai_models TO PUBLIC, anon, authenticated');

  assert.equal(await columnPresent(), true);
  await migration();
  assert.equal(await columnPresent(), false);
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL'))
    + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const once = await v(catalogSql);
  await migration();
  assert.equal(await columnPresent(), false);
  assert.deepEqual(await v(catalogSql), once);
  report.checks.push('legacy column dropped; the second application succeeds and leaves catalog structure unchanged');

  await setSecret(replaced, 1);
  await c.query(read(recoveryPath));
  assert.equal(await columnPresent(), true);
  const restored = Object.fromEntries((await c.query('SELECT model_id,api_key FROM public.ai_models')).rows
    .map(row => [row.model_id, row.api_key]));
  assert.deepEqual(restored, { 'or2-default': replaced, 'or2-explicit': replaced, 'or2-other': null });
  report.checks.push('manual recovery restores the current Vault value to OpenRouter rows only after a replacement');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
