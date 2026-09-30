/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-BASELINE: the one implementation of "build an empty database from repository files", shared by
// run-db-baseline-replay.mjs and v3/run-workbench.mjs (--schema-from-files). Order: local platform
// stand-in -> packages/db/baseline/*.sql -> every migration in file-name order, where
// packages/db/baseline/bridges/<migration file> (if any) runs immediately before that migration.
// Baseline and bridge files are checked by file-rules.mjs first and sent to the server as one string
// (psql -c) so psql never interprets meta-commands in them.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { baselineViolations, bridgeViolations } from './file-rules.mjs';

export const PLATFORM = 'packages/db/tests/baseline/platform-local.sql';
const BASELINE_DIR = 'packages/db/baseline';
const BRIDGE_DIR = 'packages/db/baseline/bridges';
const MIGRATION_DIR = 'packages/db/migrations';

const sqlFiles = (root, dir) => readdirSync(resolve(root, dir)).filter(file => /^\d{4}_.+\.sql$/.test(file)).sort()
  .map(file => `${dir}/${file}`);

// The ordered steps and bridges; throws before anything runs if a baseline or bridge breaks the rules.
export function buildPlan(root) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const baseline = sqlFiles(root, BASELINE_DIR);
  const migrations = sqlFiles(root, MIGRATION_DIR);
  const migrationNames = new Set(migrations.map(step => step.split('/').at(-1)));
  const bridges = new Set(readdirSync(resolve(root, BRIDGE_DIR)).filter(file => file.endsWith('.sql')));
  for (const bridge of bridges) {
    if (!migrationNames.has(bridge)) throw new Error(`Bridge without a migration of the same name: ${bridge}`);
    const problems = bridgeViolations(read(`${BRIDGE_DIR}/${bridge}`));
    if (problems.length > 0) throw new Error(`Bridge ${bridge} breaks the bridge rules: ${problems.join('; ')}`);
  }
  for (const step of baseline) {
    const problems = baselineViolations(read(step));
    if (problems.length > 0) throw new Error(`Baseline ${step} breaks the baseline rules: ${problems.join('; ')}`);
  }
  return { steps: [PLATFORM, ...baseline, ...migrations], bridges, bridgeDir: BRIDGE_DIR };
}

// Installs the local pg_cron stand-in (0010 runs CREATE EXTENSION pg_cron; the plain image has none).
// dockerExec(argv, input) runs `docker exec` arguments and must throw on failure.
export function installPgCronStub(root, container, dockerExec) {
  const shareDir = dockerExec([container, 'pg_config', '--sharedir']).trim();
  dockerExec(['-i', '-u', 'root', container, 'sh', '-c', `cat > ${shareDir}/extension/pg_cron.control`],
    "default_version = '1.0'\nrelocatable = false\nsuperuser = true\ncomment = 'local stub'\n");
  dockerExec(['-i', '-u', 'root', container, 'sh', '-c', `cat > ${shareDir}/extension/pg_cron--1.0.sql`],
    readFileSync(resolve(root, 'packages/db/tests/baseline/pg_cron_stub.sql'), 'utf8'));
}

// Migrations applied twice in a row, as the v3 workbench fixture did for 0067-0139 (0103 was never
// repeated there): everything from 0067 on, including every later migration, except those listed
// in NOT_REPEATABLE with the reason they cannot run twice.
export const REPEAT_FROM = '0067';
export const NOT_REPEATABLE = {};
export const repeatsTwice = step => {
  const file = step.split('/').at(-1);
  return step.startsWith(`${MIGRATION_DIR}/`) && file.slice(0, 4) >= REPEAT_FROM && !(file in NOT_REPEATABLE);
};

// Runs the plan. applyFile(path) runs a repository SQL file through psql; applyServerOnly(sql) sends
// one string with psql -c. Both return { ok, error }. Stops at the first failure; afterPlatform() lets
// a caller add its own local roles right after the platform stand-in. With fingerprint() (returns the
// catalog objects as { key: definition }) every repeatsTwice() migration is applied again right away
// and must leave the structure unchanged.
export function buildFromFiles(root, { applyFile, applyServerOnly, afterPlatform, onFail, fingerprint }) {
  const { steps, bridges, bridgeDir } = buildPlan(root);
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const report = { steps: steps.length, passed: 0, bridges: [], repeated: 0, failed: null };
  for (const step of steps) {
    const file = step.split('/').at(-1);
    if (step.startsWith(`${MIGRATION_DIR}/`) && bridges.has(file)) {
      const bridged = applyServerOnly(read(`${bridgeDir}/${file}`));
      if (!bridged.ok) {
        report.failed = { step: `${bridgeDir}/${file}`, error: bridged.error };
        break;
      }
      report.bridges.push(file);
    }
    const result = step.startsWith(`${BASELINE_DIR}/`) ? applyServerOnly(read(step)) : applyFile(step);
    if (!result.ok) {
      report.failed = { step, error: result.error };
      if (onFail) report.failed.inspect = onFail();
      break;
    }
    report.passed += 1;
    if (step === PLATFORM && afterPlatform) afterPlatform();
    if (fingerprint && repeatsTwice(step)) {
      const before = fingerprint();
      const again = applyFile(step);
      if (!again.ok) {
        report.failed = { step: `${step} (applied twice)`, error: again.error };
        break;
      }
      const after = fingerprint();
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]);
      if (changed.length > 0) {
        report.failed = { step: `${step} (second application changed the structure)`,
          error: changed.slice(0, 20).map(key => `${key}: ${before[key] ?? '(absent)'} -> ${after[key] ?? '(absent)'}`) };
        break;
      }
      report.repeated += 1;
    }
  }
  return report;
}
