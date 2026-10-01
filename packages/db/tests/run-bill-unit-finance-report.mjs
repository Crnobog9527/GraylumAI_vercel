/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BILL-UNIT: isolated synthetic bill2 fixture for the PENDING bill2_admin_call_report function.
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
const db = `graylum-bill-unit-report-${randomUUID().slice(0, 8)}`;
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql', '-X', '-A', '-t', '-F', '|',
  '-U', 'postgres', '-d', 'billunit', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], input);
const file = 'packages/db/pending/bill_unit_finance_report.sql';
const apply = () => sql(readFileSync(resolve(root, file), 'utf8'));
const state = query => {
  try { sql(query); return 'ok'; } catch (error) { return /\b42501\b/.test(String(error.stderr)) ? '42501' : 'other'; }
};
const report = (from, to, limit) => sql(`SET ROLE service_role;
  SELECT model, selected_cost_usd, run_multiplier, call_multiplier, purpose, run_call_count
  FROM public.bill2_admin_call_report(${from}, ${to}, ${limit})`).replace(/^SET\n?/, '');

try {
  docker('run', '-d', '--pull=never', '--name', db, '-e', 'POSTGRES_DB=billunit',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { sql('SELECT 1'); ready = true; break; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, 'local database ready');
  // Same ACL shape as 0105: the bill2 tables are revoked from every API role.
  sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    CREATE TABLE public.bill2_runs(id uuid PRIMARY KEY, actor_id uuid NOT NULL, payload jsonb NOT NULL,
      credits_per_usd numeric NOT NULL, multiplier numeric NOT NULL, state text NOT NULL, outcome text,
      charged integer, actual_restore integer);
    CREATE TABLE public.bill2_calls(id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES public.bill2_runs(id),
      sequence integer NOT NULL, payload jsonb NOT NULL, provider text NOT NULL, model text NOT NULL, state text NOT NULL,
      selected_cost_usd numeric, created_at timestamptz NOT NULL);
    REVOKE ALL ON public.bill2_runs, public.bill2_calls FROM PUBLIC, anon, authenticated, service_role;
    INSERT INTO public.bill2_runs VALUES
      ('00000000-0000-4000-8000-000000000001', gen_random_uuid(),
       '{"purposeBudget":{"purpose":"interactive"},"secret":"private input"}', 1000, 1.5, 'settled', 'delivered', 15, 0);
    INSERT INTO public.bill2_calls VALUES
      (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 1, '{"billingUnit":{"multiplier":"3","source":"model"}}',
       'openrouter', 'vendor/a', 'responded', 0.01, '2026-10-01T00:00:00Z'),
      (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 2, '{}',
       'openrouter', 'vendor/b', 'unknown', NULL, '2026-10-01T01:00:00Z');`);

  apply();
  apply();
  console.log('PASS PENDING report function applies twice');

  assert.equal(state("SET ROLE service_role; SELECT count(*) FROM public.bill2_calls"), '42501');
  for (const role of ['anon', 'authenticated']) {
    assert.equal(state(`SET ROLE ${role}; SELECT * FROM public.bill2_admin_call_report(now() - interval '1 year', now(), 10)`), '42501');
  }
  console.log('PASS only service_role may execute; table access stays revoked');

  const all = report(`'2026-09-30'`, `'2026-10-02'`, 10).split('\n');
  assert.deepEqual(all, ['vendor/a|0.01|1.5|3|interactive|2', 'vendor/b||1.5||interactive|2']);
  assert.equal(report(`'2026-09-30'`, `'2026-10-02'`, 1).split('\n').length, 1);
  assert.equal(report(`'2026-09-30'`, `'2026-10-02'`, 99999).split('\n').length, 2);
  assert.equal(report('NULL', `'2026-10-02'`, 10), '');
  assert.equal(report(`'2026-10-02'`, `'2026-09-30'`, 10), '');
  assert.equal(report(`'2026-10-01T00:30:00Z'`, `'2026-10-02'`, 10), 'vendor/b||1.5||interactive|2');
  console.log('PASS window, limit, frozen call multiplier vs run multiplier, purpose');

  const names = sql(`SELECT array_to_string(proargnames, ',') FROM pg_proc
    WHERE oid = 'public.bill2_admin_call_report(timestamptz, timestamptz, integer)'::regprocedure`);
  for (const forbidden of ['actor', 'request', 'scope', 'secret', 'payload']) assert.ok(!names.includes(forbidden), forbidden);
  console.log('PASS returns financial columns only (no actor, request, scope or payload)');
} catch (error) {
  console.error('FAIL BILL-UNIT finance report contract:', error.message ?? error.name);
  process.exitCode = 1;
} finally {
  let clean = true;
  try { docker('rm', '-f', '-v', db); } catch { clean = false; }
  console.log(`BILL-UNIT report cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
