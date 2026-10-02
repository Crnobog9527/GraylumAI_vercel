/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only 0157 (BILL-UNIT) verification; no database URL, environment secrets or remote host accepted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE } from '../v3/images.mjs';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';
import { cases } from './cases.mjs';

const development = process.argv.slice(2).join(' ') === '--local-only --development';
if ((!development && process.argv.slice(2).join(' ') !== '--local-only') || process.env.CI) throw new Error('Require --local-only');
const root = resolve(import.meta.dirname, '../../../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const run = (cmd, args, input) => spawnSync(cmd, args, { input, encoding: 'utf8', cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
const ok = (r) => { if (r.status !== 0 || r.error) throw new Error((r.stderr || String(r.error)).slice(-5000)); return r.stdout.trim(); };
const endpoint = ok(run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'), 'only local Docker socket');
const docker = (args, input) => run('docker', ['--host', endpoint, ...args], input);
ok(docker(['image', 'inspect', POSTGRES_IMAGE]));
const name = `graylum-bill-unit-${randomUUID().slice(0, 8)}`;
const sql = (input) => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'billunit', '-v', 'ON_ERROR_STOP=1'], input);
const fp = read('packages/db/tests/baseline/fingerprint.sql');
const objectSql = fp.slice(0, fp.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot = () => JSON.parse(ok(sql(objectSql)));
const migrationPath = 'packages/db/migrations/0157_bill_unit.sql';
const migration = read(migrationPath);
const rollback = read('packages/db/tests/bill-unit/rollback.sql');
const report = { development, build: null, checks: [], failed: null };
let client;
try {
  ok(docker(['run', '-d', '--pull=never', '--name', name, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_DB=billunit', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]));
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    ready = docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'billunit']).status === 0;
    if (!ready) await new Promise((done) => setTimeout(done, 200));
  }
  assert.ok(ready, 'local postgres ready');
  installPgCronStub(root, name, (argv, input) => ok(docker(['exec', ...argv], input)));
  const outcome = (r) => ({ ok: r.status === 0 && !r.error, error: r.stderr });
  const originals = JSON.parse(read('packages/db/tests/bill-unit/source-md5.json'));
  let before;
  report.build = buildFromFiles(root, {
    applyFile: (path) => {
      if (path === migrationPath && !before) {
        for (const [sig, md5] of Object.entries(originals)) {
          assert.equal(ok(sql(`SELECT md5(pg_get_functiondef('${sig}'::regprocedure));`)), md5, sig);
        }
        report.checks.push('source md5 before 0157: 2/2');
        before = snapshot();
      }
      return outcome(sql(read(path)));
    },
    applyServerOnly: (input) => outcome(docker(['exec', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'billunit', '-c', input])),
    fingerprint: development ? undefined : snapshot,
  });
  assert.equal(report.build.failed, null, JSON.stringify(report.build.failed));
  assert.ok(before, '0157 must be applied through the canonical build plan');
  const once = snapshot();
  ok(sql(migration));
  assert.deepEqual(snapshot(), once, 'repeat 0157 is a structural no-op');
  report.checks.push('0157 canonical application and replay: identical full catalog');

  // Source drift must abort before the column, helper or any function changes.
  ok(sql(rollback));
  assert.deepEqual(snapshot(), before, 'no-data structural rollback restores the exact catalog');
  ok(sql(`CREATE OR REPLACE FUNCTION bill2_finalize(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN '{}'; END $$;`));
  const drift = snapshot();
  const refused = sql(migration);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /BILL_UNIT_SOURCE_MISMATCH/);
  assert.deepEqual(snapshot(), drift, 'source drift leaves the catalog untouched');
  report.checks.push('source drift rejects atomically; no-data rollback restores the exact pre-0157 catalog');

  // Rebuild cleanly: restore the original finalize from the rollback text, then reapply 0157.
  const originalFinalize = rollback.slice(rollback.indexOf('CREATE OR REPLACE FUNCTION public.bill2_finalize'),
    rollback.indexOf('DROP FUNCTION public.bill2_admin_call_report'));
  ok(sql(originalFinalize));
  assert.deepEqual(snapshot(), before);
  ok(sql(migration));
  assert.deepEqual(snapshot(), once, 'reapply after rollback reproduces the same catalog');

  // A pre-existing price_multiplier of another type aborts the whole migration.
  ok(sql(rollback));
  ok(sql('ALTER TABLE ai_models ADD COLUMN price_multiplier text;'));
  const typed = sql(migration);
  assert.notEqual(typed.status, 0);
  assert.match(typed.stderr, /BILL_UNIT_PRICE_MULTIPLIER_TYPE_MISMATCH/);
  ok(sql('ALTER TABLE ai_models DROP COLUMN price_multiplier;'));
  ok(sql(migration));
  report.checks.push('a pre-existing price_multiplier of another type aborts 0157 and changes nothing');

  const require = createRequire(resolve(root, 'packages/api/package.json'));
  const { Client } = require('pg');
  const address = ok(docker(['port', name, '5432/tcp']));
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  client = new Client({ connectionString: `postgres://postgres@${address}/billunit` });
  await client.connect();
  await client.query(read('packages/db/tests/bill-unit/fixture.sql'));
  await cases(client, report);
  const unsafe = sql(rollback);
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /BILL_UNIT_ROLLBACK_REQUIRES_FORWARD_FIX/);
  report.checks.push('rollback refuses once a run carries billingUnit; forward fix required');
} catch (error) {
  report.failed = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await client?.end();
  report.cleanup = docker(['rm', '-f', '-v', name]).status === 0 ? 'PASS' : 'FAIL';
  if (report.cleanup !== 'PASS') process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}
