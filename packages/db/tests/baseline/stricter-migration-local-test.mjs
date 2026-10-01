/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Full-catalog proof: file-built no-op, missing-90 restoration, and repeated application.
// All DDL below is confined to the existing replay's disposable local Docker container.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

assert.deepEqual(process.argv.slice(2), ['--local-only']);
assert.ok(!process.env.CI, 'This fixture is local only');
const root = resolve(import.meta.dirname, '../../../..');
const read = file => readFileSync(resolve(root, file), 'utf8');
const migrationFiles = readdirSync(resolve(root, 'packages/db/migrations'))
  .filter(name => /^\d{4}_db_baseline_stricter_objects\.sql$/.test(name));
assert.equal(migrationFiles.length, 1);
const migration = read(`packages/db/migrations/${migrationFiles[0]}`);
const precheck = read('packages/db/tests/baseline/stricter-precheck.sql');
const keys = [...precheck.matchAll(/'((?:con|idx):[^']+)'/g)].map(match => match[1]);
assert.equal(new Set(keys).size, 90);
const quote = value => `'${value.replaceAll("'", "''")}'`;
const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
const catalog = `${fingerprint.slice(0, fingerprint.indexOf('-- FINAL'))}
SELECT jsonb_object_agg(k, d ORDER BY k) FROM grouped`;
const capture = label => `INSERT INTO stricter_test_snapshots
SELECT '${label}', (${catalog});`;
const assertEqual = label => `DO $test$
BEGIN
  IF (SELECT objects FROM stricter_test_snapshots WHERE label = '${label}')
    IS DISTINCT FROM (SELECT objects FROM stricter_test_snapshots WHERE label = 'original') THEN
    RAISE EXCEPTION 'stricter catalog mismatch: ${label}';
  END IF;
END $test$;`;
const remove = keys.map(key => {
  const [table, name] = key.split(':')[1].split('.');
  return key.startsWith('con:')
    ? `ALTER TABLE public.${table} DROP CONSTRAINT ${name};`
    : `DROP INDEX IF EXISTS public.${name};`;
}).join('\n');
const fixture = `CREATE TEMP TABLE stricter_test_snapshots(label text PRIMARY KEY, objects jsonb);
${capture('original')}
${migration}
${capture('no_op_once')}
${assertEqual('no_op_once')}
${migration}
${capture('no_op_twice')}
${assertEqual('no_op_twice')}
-- Simulate exactly the controller-confirmed 90 absent catalog objects, without changing rows.
BEGIN;
${remove}
COMMIT;
${capture('missing')}
DO $test$
DECLARE original jsonb; missing jsonb;
BEGIN
  SELECT objects INTO original FROM stricter_test_snapshots WHERE label = 'original';
  SELECT objects INTO missing FROM stricter_test_snapshots WHERE label = 'missing';
  IF missing IS DISTINCT FROM original - ARRAY[${keys.map(quote).join(', ')}]::text[] THEN
    RAISE EXCEPTION 'fixture did not remove exactly the expected 90 objects';
  END IF;
END $test$;
${migration}
${capture('restored_once')}
${assertEqual('restored_once')}
${migration}
${capture('restored_twice')}
${assertEqual('restored_twice')}
SELECT 'stricter migration: all four full-catalog comparisons passed';`;

const builtPath = resolve(root, 'packages/db/tests/baseline/built-fingerprint.json');
const builtBefore = readFileSync(builtPath, 'utf8');
const temporary = mkdtempSync(resolve(tmpdir(), 'graylum-stricter-migration-'));
try {
  const file = resolve(temporary, 'fixture.sql');
  writeFileSync(file, fixture);
  const result = spawnSync(process.execPath, [
    'packages/db/tests/run-db-baseline-replay.mjs', '--local-only', '--write-built', '--after', file,
  ], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.failed, null);
  assert.equal(report.cleanup, 'PASS');
  assert.equal(readFileSync(builtPath, 'utf8'), builtBefore, 'Regenerated built fingerprint must not change');
  assert.deepEqual(report.after[0].output, ['stricter migration: all four full-catalog comparisons passed']);
  console.log(`PASS: ${migrationFiles[0]}; regenerated built fingerprint byte-for-byte unchanged.`);
  console.log('PASS: two file-built no-ops; remove exactly 90; apply twice restores the full original catalog.');
  console.log(`PASS: ${report.passed} build steps, ${report.repeated} repeated migrations; cleanup.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
