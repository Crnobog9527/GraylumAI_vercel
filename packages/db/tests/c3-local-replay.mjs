/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// C3 evidence only: no environment URLs, no remote Docker, no CI, no schema repair.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) {
  throw new Error('Manual local run only: node packages/db/tests/c3-local-replay.mjs --local-only');
}
const root = resolve(import.meta.dirname, '../../..');
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const invoke = (command, args, options = {}) => spawnSync(command, args, {
  encoding: 'utf8', env, cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options,
});
const requireSuccess = (result, label) => {
  if (result.error || result.status !== 0) throw new Error(`${label} failed`);
  return result.stdout.trim();
};
const endpoint = requireSuccess(invoke('docker', [
  'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}',
]), 'Docker context');
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) {
  throw new Error('Only a local Unix Docker socket is allowed');
}
const docker = (args, options) => invoke('docker', ['--host', endpoint, ...args], options);
requireSuccess(docker(['image', 'inspect', POSTGRES_IMAGE]), 'Pinned local image');
const migrations = readdirSync(resolve(root, 'packages/db/migrations'))
  .filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
const prefix = `graylum-c3-${randomUUID().slice(0, 8)}`;
const temp = mkdtempSync(resolve(tmpdir(), 'graylum-c3-config-'));
const containers = [];
const report = {
  source: requireSuccess(invoke('git', ['rev-parse', 'HEAD']), 'Git identity'),
  image: POSTGRES_IMAGE, migrationCount: migrations.length, phases: [], cleanup: null,
};
const sql = (container, input) => docker([
  'exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'c3_disposable',
  '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-f', '/dev/stdin',
], { input });
const diagnostic = result => (result.stderr || result.stdout || '')
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n')
  .filter(line => /ERROR:|blocked:|error:|Error:|applied|No changes/i.test(line)).slice(0, 8);
async function create(suffix) {
  const name = `${prefix}-${suffix}`;
  // Register cleanup before starting: even ambiguous start failures get inspected/removed.
  containers.push(name);
  requireSuccess(docker(['run', '-d', '--pull=never', '--name', name,
    '-p', '127.0.0.1::5432', '-e', 'POSTGRES_DB=c3_disposable',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]), 'Local container start');
  for (let i = 0; i < 100; i++) {
    if (docker(['exec', name, 'pg_isready', '-U', 'postgres']).status === 0) return name;
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  throw new Error('Local container readiness timeout');
}
function replay(container, name) {
  const entry = { name, passed: [], failed: null, notRun: [] };
  for (const [index, migration] of migrations.entries()) {
    const result = sql(container, readFileSync(resolve(root, 'packages/db/migrations', migration), 'utf8'));
    if (result.status !== 0 || result.error) {
      entry.failed = { migration, exitCode: result.status, diagnostic: diagnostic(result) };
      entry.notRun = migrations.slice(index + 1);
      break;
    }
    entry.passed.push(migration);
  }
  report.phases.push(entry);
}
try {
  const empty = await create('empty');
  report.postgres = requireSuccess(sql(empty, 'SHOW server_version;'), 'Local version');
  replay(empty, 'empty-ordered-replay');
  const pushed = await create('drizzle');
  const binding = requireSuccess(docker(['port', pushed, '5432/tcp']), 'Loopback port');
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Unexpected port binding');
  const databaseUrl = new URL(`postgresql://${binding}/c3_disposable`);
  databaseUrl.username = 'postgres';
  // The retired entry is not executed; a missing command is not evidence of target rejection.
  report.phases.push({ name: 'retired-db-push-guard', status: 'NOT_RUN',
    reason: 'db:push and its target guard were retired; no guard check was executed' });
  // Separate experiment: same schema/locked Drizzle, synthetic config with no dotenv.
  // Uses only the synthetic local target, never a Supabase target.
  const config = resolve(temp, 'drizzle.config.cjs');
  writeFileSync(config, `module.exports = ${JSON.stringify({
    schema: resolve(root, 'packages/db/schema.ts'), dialect: 'postgresql',
    dbCredentials: { url: databaseUrl.href },
  })};\n`, { mode: 0o600 });
  const pushedResult = invoke('pnpm', ['exec', 'drizzle-kit', 'push', `--config=${config}`]);
  report.phases.push({ name: 'local-underlying-drizzle-push', exitCode: pushedResult.status,
    diagnostic: diagnostic(pushedResult) });
  if (pushedResult.error || pushedResult.status !== 0) throw new Error('Local Drizzle push failed');
  report.publicTablesAfterPush = requireSuccess(sql(pushed,
    "SELECT count(*) FROM pg_tables WHERE schemaname='public';"), 'Local table count');
  replay(pushed, 'drizzle-then-ordered-replay');
  // A third, explicitly synthetic diagnostic: existing fixture's platform prefix only.
  // Rebuild fresh to avoid partial failed-migration state. Never repair business DDL.
  const platform = await create('platform');
  const fixture = readFileSync(resolve(root, 'packages/db/tests/v3/bootstrap.sql'), 'utf8');
  const boundary = fixture.indexOf('CREATE TABLE public.profiles');
  if (boundary < 0) throw new Error('Fixture prefix boundary missing');
  requireSuccess(sql(platform, fixture.slice(0, boundary)), 'Fixture platform prefix');
  const platformBinding = requireSuccess(docker(['port', platform, '5432/tcp']), 'Platform loopback port');
  if (!/^127\.0\.0\.1:\d+$/.test(platformBinding)) throw new Error('Unexpected platform port');
  databaseUrl.port = platformBinding.split(':')[1];
  writeFileSync(config, `module.exports = ${JSON.stringify({
    schema: resolve(root, 'packages/db/schema.ts'), dialect: 'postgresql',
    dbCredentials: { url: databaseUrl.href },
  })};\n`, { mode: 0o600 });
  requireSuccess(invoke('pnpm', ['exec', 'drizzle-kit', 'push', `--config=${config}`]), 'Platform Drizzle push');
  replay(platform, 'fixture-platform-plus-drizzle-then-ordered-replay');
} finally {
  const removed = containers.map(name => ({ name, result: docker(['rm', '-f', '-v', name]).status }));
  rmSync(temp, { recursive: true, force: true });
  report.cleanup = { removed: removed.length, success: removed.every(item => item.result === 0) };
  console.log(JSON.stringify(report, null, 2));
  if (!report.cleanup.success) process.exitCode = 1;
}
