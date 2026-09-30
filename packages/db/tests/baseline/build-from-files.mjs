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

// Runs the plan. applyFile(path) runs a repository SQL file through psql; applyServerOnly(sql) sends
// one string with psql -c. Both return { ok, error }. Stops at the first failure; afterPlatform() lets
// a caller add its own local roles right after the platform stand-in.
export function buildFromFiles(root, { applyFile, applyServerOnly, afterPlatform, onFail }) {
  const { steps, bridges, bridgeDir } = buildPlan(root);
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const report = { steps: steps.length, passed: 0, bridges: [], failed: null };
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
  }
  return report;
}
