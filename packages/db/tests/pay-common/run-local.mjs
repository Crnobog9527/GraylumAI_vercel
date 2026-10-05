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
import { testConcurrency } from './concurrency.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) {
  throw new Error('Require local-only; no remote database input accepted');
}
const root = resolve(import.meta.dirname, '../../../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const run = (args, input) => spawnSync('docker', args, { cwd: root, input, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
const ok = r => { if (r.status !== 0 || r.error) throw new Error((r.stderr || String(r.error)).slice(0, 5000)); return r.stdout.trim(); };
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
    // The image starts a temporary init server before exec'ing the final postmaster.
    ready = docker(['exec', name, 'cat', '/proc/1/comm']).stdout.trim() === 'postgres'
      && docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'paycommon']).status === 0;
    if (!ready) await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready);
  installPgCronStub(root, name, (argv, input) => ok(docker(['exec', ...argv], input)));
  const outcome = r => ({ ok: r.status === 0 && !r.error, error: r.stderr });
  let contractTested = false;
  const testContract = () => {
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
  };
  let purchaseTested = false;
  const testPurchase = () => {
    const path = 'packages/db/migrations/0170_pay_common_purchase.sql';
    const catalog = read('packages/db/tests/pay-common/purchase-catalog.sql');
    const before = ok(sql(catalog));
    report.purchaseCatalog = { before };
    const initial = snapshot();
    const rejectDrift = () => {
      const result = sql('BEGIN; ALTER TABLE payment_orders ADD COLUMN unexpected_drift text;\n' + read(path));
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes('PAY_COMMON_PURCHASE_SCHEMA_DRIFT'), result.stderr);
    };
    rejectDrift();
    assert.deepEqual(snapshot(), initial);
    ok(sql(read(path)));
    const after = ok(sql(catalog));
    const applied = snapshot();
    report.purchaseCatalog = { before, after };
    ok(sql(read(path)));
    assert.deepEqual(snapshot(), applied);
    rejectDrift();
    assert.deepEqual(snapshot(), applied);
    report.purchaseCatalog = { before, after };
    report.checks.push('PR-2 source/replay drift rejected atomically; exact repeat preserves catalog');
  };
  report.build = buildFromFiles(root, {
    applyFile: path => {
      if (path === migrationPath && !contractTested) {
        testContract();
        contractTested = true;
        return { ok: true };
      }
      if (path.endsWith('/0170_pay_common_purchase.sql') && !purchaseTested) {
        testPurchase();
        purchaseTested = true;
        return { ok: true };
      }
      return outcome(sql(read(path)));
    },
    applyServerOnly: text => outcome(sql(text)), fingerprint: snapshot,
  });
  assert.equal(report.build.failed, null);
  ok(sql(read('packages/db/tests/pay-common/purchase-admission.sql')));
  report.checks.push('PR-2 purchase admission: free/paid eligibility, mapping ambiguity, protected closure and expiry retry');
  ok(sql(read('packages/db/tests/pay-common/checkout-persistence.sql')));
  report.checks.push('PR-2 checkout persistence, mismatch evidence, frozen package grant and callback replay');
  ok(sql(read('packages/db/tests/pay-common/catalog-write.sql')));
  report.checks.push('PR-2 current catalog mapping rotation, amount rejection and atomic rollback');
  ok(sql(read('packages/db/tests/pay-common/membership-facts.sql')));
  report.checks.push('PR-2 owner-only channel-aware facts and no private mapping exposure');
  ok(sql(read('packages/db/tests/pay-common/invoice-grant.sql')));
  report.checks.push('PR-2 frozen invoice grant, replay, renewal and closed-subject financial settlement');
  ok(sql(read('packages/db/tests/pay-common/annual-grant.sql')));
  report.checks.push('PR-2 frozen annual period-01 contract, cron replay and amount denial');
  ok(sql(read('packages/db/tests/pay-common/upgrade.sql')));
  report.checks.push('PR-2 real upgrade identity, verified closure/retry and immutable opening contract');
  ok(sql(read('packages/db/tests/pay-common/invoice-lifecycle.sql')));
  report.checks.push('PR-2 failure ordering, unpaid renewal identity and atomic cancellation lifecycle');
  report.checks.push(await testConcurrency({ endpoint, name, sql, ok }));

} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally {
  report.cleanup = docker(['rm', '-f', '-v', name]).status === 0 ? 'PASS' : 'FAIL';
  if (report.cleanup !== 'PASS') process.exitCode = 1;
  console.log(JSON.stringify(report, null, 2));
}
