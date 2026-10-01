/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BILL-UNIT: isolated synthetic ai_models fixture for the PENDING per-model multiplier migration.
// Not a complete migration replay; the numbered file is replayed with the full chain once renamed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
const root = resolve(import.meta.dirname, '../../..');
for (const path of ['.env.local', 'apps/web/.env.local', 'packages/api/.env.local']) {
  if (existsSync(resolve(root, path))) throw new Error('Use a credential-free worktree');
}
const run = (cmd, args, input) => execFileSync(cmd, args, { cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME }, input,
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const endpoint = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Local Docker only');
const docker = (...args) => run('docker', ['--host', endpoint, ...args]);
docker('image', 'inspect', POSTGRES_IMAGE);
const db = `graylum-bill-unit-${randomUUID().slice(0, 8)}`;
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql',
  '-X', '-A', '-t', '-U', 'postgres', '-d', 'billunit', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], input);
const migration = 'packages/db/pending/bill_unit_model_multiplier.sql';
const apply = () => sql(readFileSync(resolve(root, migration), 'utf8'));
const sqlState = query => {
  try { sql(query); return 'ok'; } catch (error) { return /\b(23514|42501|22P02)\b/.exec(String(error.stderr))?.[1] ?? 'other'; }
};
const structure = () => sql(`SELECT jsonb_build_object(
  'columns', (SELECT jsonb_agg(jsonb_build_array(attname, format_type(atttypid, atttypmod), attnotnull, attacl) ORDER BY attnum)
    FROM pg_attribute WHERE attrelid = 'public.ai_models'::regclass AND attnum > 0 AND NOT attisdropped),
  'checks', (SELECT jsonb_agg(jsonb_build_array(conname, pg_get_constraintdef(oid)) ORDER BY conname)
    FROM pg_constraint WHERE conrelid = 'public.ai_models'::regclass),
  'acl', (SELECT relacl::text FROM pg_class WHERE oid = 'public.ai_models'::regclass));`);

try {
  docker('run', '-d', '--pull=never', '--name', db, '-e', 'POSTGRES_DB=billunit',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { sql('SELECT 1'); ready = true; break; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, 'local database ready');
  // Shape after 0142: authenticated holds column grants on the safe columns only.
  sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE TABLE public.ai_models(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
      model_id text NOT NULL, is_active text NOT NULL DEFAULT 'true', api_key text);
    ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;
    CREATE POLICY authenticated_active_ai_models_select ON public.ai_models FOR SELECT TO authenticated USING (is_active = 'true');
    GRANT SELECT (id, name, model_id, is_active) ON public.ai_models TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON public.ai_models TO service_role;
    INSERT INTO public.ai_models(name, model_id) VALUES ('a', 'vendor/a'), ('b', 'vendor/b');`);

  apply();
  const once = structure();
  apply();
  assert.equal(structure(), once, 'second application leaves the structure unchanged');
  console.log('PASS PENDING migration applies twice with identical structure');

  assert.equal(sql(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute
    WHERE attrelid = 'public.ai_models'::regclass AND attname = 'price_multiplier'`), 'numeric');
  assert.equal(sql('SELECT count(*) FROM public.ai_models WHERE price_multiplier IS NULL'), '2');
  console.log('PASS unconstrained numeric column; existing rows stay NULL (inherit the site default)');

  const set = value => sqlState(`UPDATE public.ai_models SET price_multiplier = ${value} WHERE name = 'a'`);
  for (const value of ['NULL', '1', '3', '1.5', '19.99', '20', '20.00']) assert.equal(set(value), 'ok', `accepts ${value}`);
  for (const value of ['0', '0.99', '-1', '20.01', '21', '1.234', '3.100']) assert.equal(set(value), '23514', `rejects ${value}`);
  console.log('PASS CHECK accepts NULL and 1..20 with <=2 decimals; rejects 0, negative, >20 and extra precision');

  assert.equal(sql(`SELECT has_column_privilege('authenticated', 'public.ai_models', 'price_multiplier', 'SELECT')`), 'f');
  assert.equal(sql(`SELECT has_column_privilege('anon', 'public.ai_models', 'price_multiplier', 'SELECT')`), 'f');
  assert.equal(sqlState('SET ROLE authenticated; SELECT price_multiplier FROM public.ai_models'), '42501');
  assert.equal(sqlState("SET ROLE authenticated; UPDATE public.ai_models SET price_multiplier = 2"), '42501');
  assert.equal(sql("SET ROLE authenticated; SELECT count(*) FROM public.ai_models").replace(/^SET\n/, ''), '2');
  assert.equal(sqlState("SET ROLE service_role; UPDATE public.ai_models SET price_multiplier = 2.5 WHERE name = 'b'"), 'ok');
  assert.equal(sql("SELECT price_multiplier::text FROM public.ai_models WHERE name = 'b'"), '2.5');
  console.log('PASS only service_role reads/writes the multiplier; authenticated safe-column reads unchanged');

  // A pre-existing column of another type must stop the migration instead of being kept silently.
  sql('ALTER TABLE public.ai_models DROP COLUMN price_multiplier; ALTER TABLE public.ai_models ADD COLUMN price_multiplier text;');
  let mismatch = '';
  try { apply(); } catch (error) { mismatch = String(error.stderr); }
  assert.match(mismatch, /BILL_UNIT_PRICE_MULTIPLIER_TYPE_MISMATCH/);
  assert.equal(sql(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute
    WHERE attrelid = 'public.ai_models'::regclass AND attname = 'price_multiplier'`), 'text');
  console.log('PASS a pre-existing price_multiplier of another type aborts the migration and changes nothing');
} catch (error) {
  console.error('FAIL BILL-UNIT model multiplier contract:', error.message ?? error.name);
  process.exitCode = 1;
} finally {
  let clean = true;
  try { docker('rm', '-f', '-v', db); } catch { clean = false; }
  console.log(`BILL-UNIT cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
