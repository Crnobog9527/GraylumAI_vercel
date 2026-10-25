/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REL-1 core 7 (6): builds an empty local database from the migration files, then runs the library cleanup backlog
// drill (packages/api/src/services/library/backlogDrill.integration.ts) against it. Local Docker only; needs a
// local database slot. Sizes: LIBRARY_DRILL_SIZES=1000,6000 (default); LIBRARY_DRILL_BACKGROUND=20000 live documents;
// LIBRARY_DRILL_BATCH=50 (default) or 100 rows per run.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { POSTGRES_IMAGE } from '../v3/images.mjs';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const name = `graylum-libdrill-${randomUUID().slice(0, 8)}`;
const command = (argv, input) => {
  const r = spawnSync('docker', argv, { input, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0 || r.error) throw new Error(r.stderr || String(r.error));
  return r.stdout.trim();
};
const endpoint = command(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
assert.ok(endpoint.startsWith('unix:///'));
const docker = (argv, input) => command(['--host', endpoint, ...argv], input);
const sql = input => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'libdrill',
  '-v', 'ON_ERROR_STOP=1', '-f', '/dev/stdin'], input);
let status = 1;
try {
  docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=local-test-only', '-e', 'POSTGRES_DB=libdrill',
    '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  let ready = false;
  for (let attempt = 0; attempt < 150 && !ready; attempt++) {
    try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  assert.ok(ready, 'PostgreSQL TCP listener must be ready');
  installPgCronStub(root, name, (argv, input) => docker(['exec', ...argv], input));
  const apply = input => { try { sql(input); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } };
  const report = buildFromFiles(root, {
    applyFile: path => apply(readFileSync(resolve(root, path), 'utf8')), applyServerOnly: apply,
  });
  assert.equal(report.failed, null, JSON.stringify(report));
  sql(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
    VALUES('Free','free',false,false,50000000) ON CONFLICT(level) DO NOTHING`);
  const port = Number(docker(['port', name, '5432/tcp']).split(':').at(-1));
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
    'src/services/library/backlogDrill.integration.ts'], {
    cwd: resolve(root, 'packages/api'), stdio: 'inherit',
    env: { ...process.env, LIBRARY_DRILL_DB_PORT: String(port) },
  });
  status = run.status ?? 1;
} finally {
  try { docker(['rm', '-f', name]); } catch { /* already gone */ }
}
process.exit(status);
