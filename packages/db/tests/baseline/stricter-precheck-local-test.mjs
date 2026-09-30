/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Exercises the actual SELECTs on a disposable file-built database and synthetic rows.
// The existing replay owns the local-only Docker boundary and container cleanup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

assert.deepEqual(process.argv.slice(2), ['--local-only']);
assert.ok(!process.env.CI, 'This synthetic fixture is local only');
const root = resolve(import.meta.dirname, '../../../..');
const read = file => readFileSync(resolve(root, file), 'utf8');
const keys = JSON.parse(read('packages/db/tests/baseline/expected-differences.json')).stricterInFiles.keys;
assert.equal(keys.length, 90);
assert.equal(keys.filter(key => key.startsWith('con:')).length, 13);
const sql = read('packages/db/tests/baseline/stricter-precheck.sql').replace(/^--.*$/gm, '').trim();
const masked = sql.replace(/'(?:''|[^'])*'/g, "''");
assert.equal(masked.split(';').filter(part => part.trim()).length, 2);
assert.ok(masked.split(';').filter(part => part.trim()).every(part => /^\s*SELECT\b/.test(part)));
assert.doesNotMatch(masked, /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|DO|CALL|COPY|SET|INTO)\b|\\/i);
assert.deepEqual([...sql.matchAll(/'((?:con|idx):[^']+)'/g)].map(match => match[1]).sort(), [...keys].sort());
const [gate, objects] = sql.split(';').filter(part => part.trim());
const capture = `BEGIN READ ONLY;
SELECT row_to_json(gate) FROM (${gate}) gate;
SELECT jsonb_agg(to_jsonb(actual) ORDER BY object_key) FROM (${objects}) actual;
ROLLBACK;`;
const captureObjects = `BEGIN READ ONLY;
SELECT jsonb_agg(to_jsonb(actual) ORDER BY object_key) FROM (${objects}) actual;
ROLLBACK;`;
const built = JSON.parse(read('packages/db/tests/baseline/built-fingerprint.json')).objects;
const tables = [...new Set(keys.map(key => key.split(':')[1].split('.')[0]))];
const fixtureTables = tables.map(table => {
  const columns = Object.keys(built).filter(key => key.startsWith(`col:${table}.`))
    .map(key => key.split('.')[1])
    .map(column => `"${column}" ${column === 'credits' ? 'numeric' : 'text'}`);
  assert.ok(columns.length > 0, `Missing fixture table: ${table}`);
  return `CREATE TABLE public.${table} (${columns.join(', ')});`;
});
const checkColumns = [
  ['ai_usage_logs', 'status', 'success'],
  ['billing_history', 'operation_type', 'pre_deduct'],
  ['conversation_context_snapshots', 'snapshot_type', 'rolling_summary'],
  ['scheduled_job_runs', 'status', 'running'],
  ['scheduled_job_runs', 'trigger_source', 'manual'],
];
const invalidRows = checkColumns.map(([table, column, valid]) =>
  `INSERT INTO public.${table} (${column}) VALUES ('invalid'), ('${valid}'), (NULL), (NULL);`);
const fixture = `${capture}
-- The following writes run ONLY in the disposable local replay container.
BEGIN;
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
${fixtureTables.join('\n')}
COMMIT;
${captureObjects}
BEGIN;
${invalidRows.join('\n')}
INSERT INTO public.profiles (credits) VALUES (-1), (0), (NULL), (NULL);
INSERT INTO public.payment_orders
  (billing_cycle, item_type, mode, stripe_checkout_session_id, stripe_invoice_id) VALUES
  ('invalid', 'invalid', 'invalid', NULL, NULL),
  ('monthly', 'credit_package', 'payment', 'duplicate-session', 'duplicate-invoice'),
  ('monthly', 'credit_package', 'payment', 'duplicate-session', 'duplicate-invoice'),
  ('monthly', 'credit_package', 'payment', 'duplicate-session', NULL),
  (NULL, NULL, NULL, NULL, NULL), (NULL, NULL, NULL, NULL, NULL);
INSERT INTO public.user_subscriptions (billing_cycle, stripe_subscription_id) VALUES
  ('invalid', NULL), ('monthly', 'duplicate-subscription'), ('monthly', 'duplicate-subscription'),
  ('monthly', 'duplicate-subscription'), (NULL, NULL), (NULL, NULL);
COMMIT;
${captureObjects}
BEGIN;
ALTER TABLE public.ai_usage_logs ADD CONSTRAINT ai_usage_logs_status_check
  CHECK (status = 'unexpected') NOT VALID;
CREATE INDEX idx_ai_models_name ON public.ai_models (is_active);
ALTER TABLE public.ai_models DROP COLUMN name;
ALTER TABLE public.announcements DROP COLUMN is_deleted;
COMMIT;
${captureObjects}`;

const temporary = mkdtempSync(resolve(tmpdir(), 'graylum-stricter-test-'));
try {
  const file = resolve(temporary, 'fixture.sql');
  writeFileSync(file, fixture);
  const result = spawnSync(process.execPath, [
    'packages/db/tests/run-db-baseline-replay.mjs', '--local-only', '--after', file,
  ], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.failed, null);
  assert.deepEqual(report.builtDifferences, []);
  assert.equal(report.cleanup, 'PASS');
  const [safety, present, missing, violating, drift] = report.after[0].output.map(line => JSON.parse(line));
  assert.deepEqual(safety, { read_only_count: 1, full_visibility_count: 1 });
  const fields = ['object_exists_count', 'violation_count', 'missing_column_count',
    'definition_mismatch_count', 'invalid_object_count'];
  for (const rows of [present, missing, violating, drift]) {
    assert.deepEqual(rows.map(row => row.object_key), [...keys].sort());
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['object_key', ...fields].sort());
      for (const field of fields) assert.ok(Number.isInteger(row[field]) && row[field] >= 0);
    }
  }
  for (const row of present) {
    assert.equal(row.object_exists_count, 1, row.object_key);
    for (const field of fields.slice(1)) assert.equal(row[field], 0, `${row.object_key}: ${field}`);
  }
  for (const row of missing) {
    for (const field of fields) assert.equal(row[field], 0, `${row.object_key}: ${field}`);
  }
  for (const row of violating) {
    assert.equal(row.violation_count, row.object_key.startsWith('con:') ? 1 : 0, row.object_key);
    for (const field of fields.filter(field => field !== 'violation_count')) assert.equal(row[field], 0);
  }
  const byKey = Object.fromEntries(drift.map(row => [row.object_key, row]));
  assert.equal(byKey['con:ai_usage_logs.ai_usage_logs_status_check'].invalid_object_count, 1);
  assert.equal(byKey['con:ai_usage_logs.ai_usage_logs_status_check'].definition_mismatch_count, 1);
  assert.equal(byKey['idx:ai_models.idx_ai_models_name'].definition_mismatch_count, 1);
  for (const key of ['idx:ai_models.idx_ai_models_name', 'idx:announcements.idx_announcements_active',
    'idx:announcements.idx_announcements_is_deleted']) assert.equal(byKey[key].missing_column_count, 1);
  for (const [field, total] of Object.entries({ object_exists_count: 2, violation_count: 13,
    missing_column_count: 3, definition_mismatch_count: 2, invalid_object_count: 1 })) {
    assert.equal(drift.reduce((sum, row) => sum + row[field], 0), total, field);
  }
  console.log('PASS: SELECT-only; exact 90 keys; existing/missing objects; NULL CHECK semantics;');
  console.log('duplicate groups (NULL excluded); predicate columns; definition drift; NOT VALID; count-only output.');
  console.log(`PASS: file-built fingerprint unchanged; ${report.repeated} repeated migrations; cleanup.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
