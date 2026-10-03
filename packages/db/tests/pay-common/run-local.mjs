/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';
import { POSTGRES_IMAGE } from '../v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) {
  throw new Error('Require local-only; no remote database input accepted');
}
const root = resolve(import.meta.dirname, '../../../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const run = (args, input) => spawnSync('docker', args, { cwd: root, input, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
const ok = r => { if (r.status !== 0 || r.error) throw new Error((r.stderr || String(r.error)).slice(-4000)); return r.stdout.trim(); };
const endpoint = ok(run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'));
const docker = (args, input) => run(['--host', endpoint, ...args], input);
ok(docker(['image', 'inspect', POSTGRES_IMAGE]));
const name = `graylum-pay-common-${randomUUID().slice(0, 8)}`;
const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'paycommon',
  '-v', 'ON_ERROR_STOP=1'], input);
const migrationPath = 'packages/db/migrations/0161_pay_common_contract.sql';
const fingerprint = read('packages/db/tests/baseline/fingerprint.sql').split('-- FINAL')[0]
  + 'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
const snapshot = () => JSON.parse(ok(sql(fingerprint)));
const report = { checks: [], failed: null };
try {
  ok(docker(['run', '-d', '--pull=never', '--name', name, '-e', 'POSTGRES_DB=paycommon',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]));
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    ready = docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'paycommon']).status === 0;
    if (!ready) await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready);
  installPgCronStub(root, name, (argv, input) => ok(docker(['exec', ...argv], input)));
  const outcome = r => ({ ok: r.status === 0 && !r.error, error: r.stderr });
  report.build = buildFromFiles(root, {
    applyFile: path => path === migrationPath ? { ok: true } : outcome(sql(read(path))),
    applyServerOnly: text => outcome(sql(text)), fingerprint: snapshot,
  });
  report.build.excluded = [migrationPath];
  report.build.steps -= 1; report.build.passed -= 1; report.build.repeated -= 1;
  assert.equal(report.build.failed, null);
  const before = snapshot();
  const beforeHash = ok(sql(read('packages/db/tests/pay-common/catalog.sql')));
  const migration = read(migrationPath);
  const reject = (text, expected) => {
    const result = sql(text);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(expected), result.stderr);
  };
  reject('BEGIN; ALTER TABLE payment_orders ADD COLUMN unexpected_drift text;\n' + migration,
    'PAY_COMMON_SCHEMA_DRIFT');
  assert.deepEqual(snapshot(), before);
  ok(sql(migration));
  const after = snapshot();
  const afterHash = ok(sql(read('packages/db/tests/pay-common/catalog.sql')));
  ok(sql(migration));
  assert.deepEqual(snapshot(), after);
  report.checks.push('full-file baseline; migration repeated without catalog drift');
  report.catalog = { before: beforeHash, after: afterHash };
  const audit = ok(sql(read('packages/db/tests/account-open-policy-audit.sql')));
  assert.equal(audit, '');
  report.checks.push('account-open ACL audit');
  {
    ok(sql(read('packages/db/tests/pay-common/cases.sql')));
    report.checks.push('SQL allowed/denied, retention, immutable snapshot, replay and late financial facts');
    reject('BEGIN; ALTER TABLE payment_orders ADD COLUMN unexpected_drift text;\n' + migration,
      'PAY_COMMON_SCHEMA_DRIFT');
    assert.deepEqual(snapshot(), after);
    const rollback = read('packages/db/tests/pay-common/rollback.sql');
    reject(read('packages/db/tests/pay-common/cases.sql').replace(/ROLLBACK;\s*$/, '') + rollback,
      'PAY_COMMON_ROLLBACK_REQUIRES_FORWARD_FIX');
    assert.deepEqual(snapshot(), after);
    ok(sql(rollback));
    assert.deepEqual(snapshot(), before);
    ok(sql(migration));
    assert.deepEqual(snapshot(), after);
    report.checks.push('source/replay drift rejected; nonempty rollback rejected; empty rollback/reapply exact');
  }
  writeFileSync('/private/tmp/pay-common-pr1-catalog-evidence.json', JSON.stringify({ before, after }, null, 2));
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally {
  report.cleanup = docker(['rm', '-f', '-v', name]).status === 0 ? 'PASS' : 'FAIL';
  if (report.cleanup !== 'PASS') process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}
