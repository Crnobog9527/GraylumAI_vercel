/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-BASELINE: build an empty database from repository files only (baseline/build-from-files.mjs)
// and check its structure. Fails on any build error and on any difference from the committed
// built fingerprint (baseline/built-fingerprint.json; refresh it with --write-built in the PR that
// changes the structure; --out only dumps the structure). With --staging <snapshot> it instead
// compares with a staging snapshot,
// allowing only baseline/expected-differences.json. --ci runs the same checks in CI (no network,
// no secrets, digest-pinned image already pulled by the workflow).
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE } from './v3/images.mjs';
import { buildFromFiles, buildPlan, installPgCronStub } from './baseline/build-from-files.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: node packages/db/tests/run-db-baseline-replay.mjs --local-only|--ci [--write-built]'
  + ' [--staging <snapshot.json>] [--out <local.json>] [--after <a.sql,b.sql>] [--on-fail <SQL>] [--query <SQL>]';
const ci = args[0] === '--ci';
if (!(ci ? process.env.CI : args[0] === '--local-only' && !process.env.CI)) throw new Error(usage);
if (ci && ['--write-built', '--staging', '--out', '--on-fail', '--query'].some(flag => args.includes(flag))) {
  throw new Error('CI mode only builds and checks; it never writes files or takes diagnostics');
}
const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const root = resolve(import.meta.dirname, '../../..');
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const invoke = (command, argv, options = {}) => spawnSync(command, argv, {
  encoding: 'utf8', env, cwd: root, timeout: 300000, maxBuffer: 64 * 1024 * 1024, ...options,
});
const ok = (result, label) => {
  if (result.error || result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || '').slice(0, 2000)}`);
  return result.stdout.trim();
};
const endpoint = ok(invoke('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']), 'Docker context');
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Only a local Unix Docker socket is allowed');
const docker = (argv, options) => invoke('docker', ['--host', endpoint, ...argv], options);
ok(docker(['image', 'inspect', POSTGRES_IMAGE]), 'Pinned local image');

const name = `graylum-dbb-${randomUUID().slice(0, 8)}`;
const psql = input => docker(['exec', '-i', name, 'psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', 'dbb',
  '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-f', '/dev/stdin'], { input });
// Files outside the migration ledger go to the server as one string (-c): psql does not
// interpret meta-commands such as \! or \i in them.
const psqlServerOnly = sql => docker(['exec', name, 'psql', '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', 'dbb',
  '-c', sql]);
const read = path => readFileSync(resolve(root, path), 'utf8');
const readJson = path => JSON.parse(read(path));
const errorLines = result => (result.stderr || '').split('\n').filter(Boolean).slice(0, 12);
buildPlan(root); // rules for baseline and bridge files are checked before anything starts

const BUILT = 'packages/db/tests/baseline/built-fingerprint.json';
const md5 = text => createHash('md5').update(text ?? '<null>').digest('hex');
const builtObjects = localDetail => Object.fromEntries(Object.keys(localDetail).sort()
  .map(key => [key, md5(localDetail[key]).slice(0, 12)]));
// Compares the build with the committed built fingerprint, object by object.
function compareBuilt(localDetail, built) {
  const local = builtObjects(localDetail);
  const keys = [...new Set([...Object.keys(local), ...Object.keys(built.objects)])].sort();
  return keys.filter(key => local[key] !== built.objects[key]).map(key => (key in built.objects
    ? (key in local ? `differs: ${key} :: ${localDetail[key]}` : `missing from the build: ${key}`)
    : `new in the build: ${key} :: ${localDetail[key]}`).slice(0, 400));
}

// Compares the local build with a staging snapshot; returns the unexpected differences.
function compare(local, localDetail, snapshot, expected) {
  const same = key => key in local && key in snapshot.groups && local[key].startsWith(snapshot.groups[key]);
  const keys = [...new Set([...Object.keys(local), ...Object.keys(snapshot.groups)])].sort();
  const differing = keys.filter(key => !same(key));
  const seen = { platformOnlyOnStaging: [], pendingOnStaging: [], stricterInFiles: [] };
  const unexpected = [];
  const allow = (list, key) => {
    if (!expected[list].keys.includes(key)) return false;
    seen[list].push(key);
    return true;
  };
  for (const key of differing) {
    if (!(key in local)) {
      if (!allow('platformOnlyOnStaging', key)) unexpected.push(`only on staging: ${key}`);
    } else if (!(key in snapshot.groups)) {
      if (!allow('pendingOnStaging', key)) unexpected.push(`only in files: ${key}`);
    } else {
      // Object-by-object: ACL text verbatim, everything else by md5 prefix.
      const objects = Object.keys(localDetail).filter(item => item.split('.')[0] === key);
      const stagingObjects = Object.keys(snapshot.objects).filter(item => item.split('.')[0] === key);
      if (stagingObjects.length === 0) unexpected.push(`changed group without staging objects: ${key}`);
      for (const item of new Set([...objects, ...stagingObjects])) {
        const stagingValue = snapshot.objects[item];
        const localValue = localDetail[item];
        if (stagingValue === undefined) {
          if (!allow('stricterInFiles', item) && !allow('pendingOnStaging', item)) {
            unexpected.push(`only in files: ${item} :: ${localValue}`);
          }
        } else if (localValue === undefined) {
          unexpected.push(`only on staging: ${item}`);
        } else if (/^(acl|defacl):/.test(item) ? localValue !== stagingValue : !md5(localValue).startsWith(stagingValue)) {
          unexpected.push(`differs: ${item} :: local ${localValue}`);
        }
      }
    }
  }
  for (const list of Object.keys(seen)) {
    for (const key of expected[list].keys) {
      if (!seen[list].includes(key)) unexpected.push(`expected difference no longer occurs (${list}): ${key}`);
    }
  }
  return { differingGroups: differing.length, unexpected };
}

let report = { image: POSTGRES_IMAGE, failed: null };
try {
  ok(docker(['run', '-d', '--pull=never', '--name', name, '-e', 'POSTGRES_DB=dbb',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'Local container start');
  // The image's init step first runs a temporary socket-only server, then restarts. Probe over TCP
  // (like run-workbench.mjs) so only the final server counts, then require one real query.
  let ready = false;
  for (let i = 0; i < 300 && !ready; i++) {
    ready = docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'dbb']).status === 0
      && docker(['exec', name, 'psql', '-X', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'dbb', '-tAc', 'SELECT 1'])
        .stdout?.trim() === '1';
    if (!ready) await new Promise(done => setTimeout(done, 200));
  }
  if (!ready) throw new Error('Local container readiness timeout (60 s)');
  installPgCronStub(root, name, (argv, input) => ok(docker(['exec', ...argv], { input }), 'pg_cron stand-in'));
  const outcome = result => ({ ok: result.status === 0 && !result.error, error: errorLines(result) });
  report = { ...report, ...buildFromFiles(root, {
    applyFile: path => outcome(psql(read(path))),
    applyServerOnly: sql => outcome(psqlServerOnly(sql)),
    onFail: option('--on-fail') ? () => psql(option('--on-fail')).stdout.trim().split('\n') : undefined,
  }) };
  if (!report.failed) {
    const fingerprintSql = read('packages/db/tests/baseline/fingerprint.sql');
    const local = JSON.parse(ok(psql(fingerprintSql), 'Local fingerprint'));
    const detailSql = `${fingerprintSql.slice(0, fingerprintSql.indexOf('-- FINAL'))}`
      + 'SELECT jsonb_object_agg(k, d ORDER BY k) FROM grouped;';
    const localDetail = JSON.parse(ok(psql(detailSql), 'Local detail'));
    report.groups = Object.keys(local).length;
    if (option('--query')) report.query = psql(option('--query')).stdout.trim().split('\n');
    // DATA-ERASURE §6: every table a signed-in client can reach carries account_open_required
    // (checked on the database exactly as the files built it, before any re-apply below).
    const audit = ok(psql(read('packages/db/tests/account-open-policy-audit.sql')), 'Account-open audit');
    report.accountOpenAudit = audit ? audit.split('\n') : [];
    if (report.accountOpenAudit.length > 0) report.failed = { step: 'account-open-policy-audit' };
    if (option('--out')) writeFileSync(option('--out'), JSON.stringify({ groups: local, objects: localDetail }, null, 1));
    if (option('--staging')) {
      report.comparison = compare(local, localDetail, JSON.parse(readFileSync(option('--staging'), 'utf8')),
        readJson('packages/db/tests/baseline/expected-differences.json'));
      if (report.comparison.unexpected.length > 0) report.failed ??= { step: 'staging comparison' };
    } else if (option('--out')) {
      // Dump mode (used by baseline/replay-with-new-migrations.mjs): the structure is written to
      // --out and judged by the caller, so the built fingerprint is not compared here.
      report.builtFingerprint = 'not compared (--out)';
    } else if (args.includes('--write-built')) {
      writeFileSync(resolve(root, BUILT), `${JSON.stringify({
        _about: 'Structure of an empty database built from repository files by run-db-baseline-replay.mjs '
          + '(catalog fingerprint, object -> md5 prefix). Regenerate with --write-built in every PR that '
          + 'changes the structure; the diff lists exactly which objects the change adds, drops or alters.',
        objects: builtObjects(localDetail),
      }, null, 1)}\n`);
      report.builtFingerprint = 'written';
    } else {
      report.builtDifferences = compareBuilt(localDetail, readJson(BUILT));
      if (report.builtDifferences.length > 0) report.failed ??= { step: 'built fingerprint (run with --write-built and commit)' };
    }
    // The convergence migration must be a no-op once its target state is reached (as on staging).
    const convergence = 'packages/db/migrations/0148_db_baseline_convergence.sql';
    const again = psql(read(convergence));
    if (again.status !== 0 || again.error) report.failed = { step: `${convergence} (re-apply)`, error: errorLines(again) };
    else if (JSON.stringify(JSON.parse(ok(psql(fingerprintSql), 'Re-apply fingerprint'))) !== JSON.stringify(local)) {
      report.failed = { step: `${convergence} (re-apply changed the structure)` };
    } else {
      report.convergenceReapply = 'unchanged';
      // Staging simulation: the rollback removes exactly what 0148 adds on staging (the credit
      // guard); applying 0148 again restores the converged structure.
      const guardKeys = ['fn:prevent_client_profile_credit_write()', 'fnacl:prevent_client_profile_credit_write()',
        'trg:profiles.trg_prevent_client_profile_credit_write'];
      ok(psql(read('packages/db/tests/db-baseline-0148-rollback.sql')), 'Rollback');
      const rolledBack = JSON.parse(ok(psql(detailSql), 'Rollback detail'));
      const removed = Object.keys(localDetail).filter(key => !(key in rolledBack)).sort();
      const changedByRollback = Object.keys(rolledBack).filter(key => rolledBack[key] !== localDetail[key]);
      ok(psql(read(convergence)), 'Apply after rollback');
      const restored = JSON.stringify(JSON.parse(ok(psql(fingerprintSql), 'Restored fingerprint'))) === JSON.stringify(local);
      report.rollback = { removed, changedByRollback, restored };
      if (JSON.stringify(removed) !== JSON.stringify(guardKeys) || changedByRollback.length > 0 || !restored) {
        report.failed = { step: 'rollback / re-apply simulation' };
      }
    }
    // Optional local SQL checks on the finished database, e.g. baseline/credit-guard-paths.sql.
    for (const file of option('--after')?.split(',') ?? []) {
      if (report.failed) break;
      const result = psql(readFileSync(resolve(root, file), 'utf8'));
      (report.after ??= []).push({ file: file.split('/').at(-1), output: result.stdout.trim().split('\n') });
      if (result.status !== 0 || result.error) report.failed = { step: file, error: errorLines(result) };
    }
  }
} finally {
  const removed = docker(['rm', '-f', '-v', name]);
  report.cleanup = removed.status === 0 ? 'PASS' : 'FAIL';
  console.log(JSON.stringify(report, null, 1));
  if (report.failed || report.cleanup !== 'PASS') process.exitCode = 1;
}
