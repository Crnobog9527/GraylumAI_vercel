/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE } from '../v3/images.mjs';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';
import { replayTail } from '../content-erasure/tail-replay.mjs';
export const root = resolve(import.meta.dirname, '../../../..');
export const read = path => readFileSync(resolve(root, path), 'utf8');

// Snapshot of the finished build (CI speed-up, Owner 2026-11-01): run-local-suites.mjs builds the database from the repository files once,
// stops the container cleanly and commits it as an image; every suite then starts its own fresh container from that image instead of
// replaying every migration again. A suite still owns a whole container, so nothing it writes (data, roles, settings) can reach another one.
// The runner hands the image and the build report to the suite processes in these two variables.
export const SNAPSHOT_IMAGE_ENV = 'GRAYLUM_DB_SNAPSHOT_IMAGE';
export const SNAPSHOT_BUILD_ENV = 'GRAYLUM_DB_SNAPSHOT_BUILD';
const SNAPSHOT_DATA = '/graylum-snapshot/pgdata'; // outside the image's VOLUME, so `docker commit` keeps it
const DATABASE = 'perf';

function dockerTools() {
  const run = (cmd, args, input) => spawnSync(cmd, args, { input, encoding: 'utf8', cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
  const ok = r => { if (r.status !== 0 || r.error) throw new Error((r.stderr || String(r.error)).slice(-5000)); return r.stdout.trim(); };
  const endpoint = ok(run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
  assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'));
  const docker = (args, input) => run('docker', ['--host', endpoint, ...args], input);
  return { ok, docker };
}

// Starts a container from `image` (the pinned PostgreSQL image, or a snapshot of it) and waits until it accepts connections.
async function startContainer({ ok, docker }, { image, name, extraEnv = [], dockerArgs = [], postgresArgs = [] }) {
  ok(docker(['run', '-d', '--pull=never', '--name', name, '-p', '127.0.0.1::5432',
    '-e', `POSTGRES_DB=${DATABASE}`, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', ...extraEnv, ...dockerArgs, image,
    '-c', 'track_functions=all', ...postgresArgs]));
  for (let i = 0; i < 300; i++) {
    if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', DATABASE]).status === 0) break;
    await new Promise(r => setTimeout(r, 200));
  }
}

// Replays every repository file into the container's database; returns the build report (throws on the first failure).
function buildInto({ ok, docker }, name, beforeApply) {
  const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', DATABASE, '-v', 'ON_ERROR_STOP=1'], input);
  installPgCronStub(root, name, (args, input) => ok(docker(['exec', ...args], input)));
  const outcome = r => ({ ok: r.status === 0 && !r.error, error: r.stderr });
  const build = buildFromFiles(root, {
    applyFile: path => { beforeApply?.(path, input => ok(sql(input))); return outcome(sql(read(path))); },
    applyServerOnly: input => outcome(docker(['exec', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', DATABASE, '-c', input])),
  });
  assert.equal(build.failed, null, JSON.stringify(build.failed));
  return build;
}

// Builds the database once and commits it as a local image. Returns { image, build, remove }; remove() deletes the image.
export async function buildSnapshot() {
  const tools = dockerTools();
  const { ok, docker } = tools;
  ok(docker(['image', 'inspect', POSTGRES_IMAGE]));
  const name = `graylum-snapshot-${randomUUID().slice(0, 8)}`;
  const image = `graylum-db-snapshot:${randomUUID().slice(0, 12)}`;
  try {
    await startContainer(tools, { image: POSTGRES_IMAGE, name, extraEnv: ['-e', `PGDATA=${SNAPSHOT_DATA}`] });
    const build = buildInto(tools, name);
    ok(docker(['stop', '--timeout', '120', name])); // SIGINT: a clean shutdown, so the snapshot starts without crash recovery
    ok(docker(['commit', name, image]));
    return { image, build, remove: () => docker(['image', 'rm', '-f', image]) };
  } finally {
    docker(['rm', '-f', '-v', name]);
  }
}

// beforeApply(path, sql): optional, runs synchronously before each repository file is applied (sql(text) runs
// psql on the build database), so a suite can seed data at the point in the chain it is about. It needs the real chain, so a suite that
// passes it always replays the files and never uses a snapshot.
// dockerArgs / postgresArgs (CORE-PATH-V2 single-machine load run): extra `docker run` options (cpus, memory) and extra `postgres -c` settings.
// snapshot: { image, build } from buildSnapshot(); defaults to the image the runner passed in the environment.
export async function localDb({ beforeApply, dockerArgs = [], postgresArgs = [], snapshot = snapshotFromEnv() } = {}) {
  // MAINT-P1: --local-only on a developer machine, --ci in CI (run-local-suites.mjs); never the other way round.
  const ci = process.argv[2] === '--ci';
  assert.equal(process.argv[2], ci ? '--ci' : '--local-only');
  assert.equal(Boolean(process.env.CI), ci);
  const tools = dockerTools();
  const { ok, docker } = tools;
  const useSnapshot = Boolean(snapshot) && !beforeApply;
  ok(docker(['image', 'inspect', useSnapshot ? snapshot.image : POSTGRES_IMAGE]));
  const name = `graylum-runtime-perf-${randomUUID().slice(0, 8)}`;
  const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', DATABASE, '-v', 'ON_ERROR_STOP=1'], input);
  let client;
  const close = async () => { await client?.end(); ok(docker(['rm', '-f', '-v', name])); };
  try {
    await startContainer(tools, { image: useSnapshot ? snapshot.image : POSTGRES_IMAGE, name, dockerArgs, postgresArgs });
    const build = useSnapshot ? snapshot.build : buildInto(tools, name, beforeApply);
    const require = createRequire(resolve(root,'package.json'));
    const {Client} = require('pg');
    const address=ok(docker(['port',name,'5432/tcp']));
    assert.match(address,/^127\.0\.0\.1:\d+$/);
    client=new Client({connectionString:`postgres://postgres@${address}/${DATABASE}`});
    await client.connect();
    return {client,build,close,sql:input=>ok(sql(input)),raw:sql,address,exec:args=>ok(docker(['exec',name,...args])),fromSnapshot:useSnapshot};
  } catch(e) {await close();throw e;}
}

export function snapshotFromEnv() {
  const image = process.env[SNAPSHOT_IMAGE_ENV];
  return image ? { image, build: JSON.parse(process.env[SNAPSHOT_BUILD_ENV] ?? 'null') } : null;
}

/**
 * "Re-applying migration M leaves the complete catalog unchanged", on the final catalog: M is replayed together with every later migration, in
 * order (content-erasure/tail-replay.mjs), because M alone rewrites functions that later migrations changed or dropped. Asserts inside; every
 * migration it could not replay is recorded in report.skipped. finalCatalog: the catalog to land on (default: the catalog now, which is
 * what a plain re-application check wants); pass the catalog taken before a rollback when the replay is the recovery from that rollback.
 */
export async function replayMigrationTail(db, { migrationPath, report, finalCatalog }) {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const objectSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;';
  const sql = input => { try { return { status: 0, stdout: db.sql(input), stderr: '' }; } catch (error) { return { status: 1, stdout: '', stderr: String(error.message) }; } };
  const ok = result => { if (result.status !== 0) throw new Error(result.stderr); return result.stdout; };
  const snapshot = () => JSON.parse(ok(sql(objectSql)));
  await replayTail({ root, read, sql, ok, snapshot, finalCatalog: finalCatalog ?? snapshot(), report, migrationPath, first: read(migrationPath) });
}
