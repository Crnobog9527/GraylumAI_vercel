/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Disposable SQL fixture for the declined-purchase integration test. No remote DB or provider access.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFromFiles, installPgCronStub } from '../baseline/build-from-files.mjs';
import { POSTGRES_IMAGE } from '../v3/images.mjs';

assert.deepEqual(process.argv.slice(2), ['--local-only']);
const root = resolve(import.meta.dirname, '../../../..');
const options = { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME },
  maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
const endpoint = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], options).trim();
assert.ok(endpoint.startsWith('unix:///') && !endpoint.includes('\n'));
const docker = (args, input) => execFileSync('docker', ['--host', endpoint, ...args], { ...options, input }).trim();
const name = `graylum-decline-${randomUUID()}`;
docker(['image', 'inspect', POSTGRES_IMAGE]);
try {
  docker(['run', '-d', '--pull=never', '--name', name, '-e', 'POSTGRES_DB=paycommon',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE]);
  let ready = false;
  for (let count = 0; count < 300 && !ready; count++) {
    try { ready = docker(['exec', name, 'cat', '/proc/1/comm']) === 'postgres'
      && docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'paycommon']).includes('accepting'); } catch { /* starting */ }
    if (!ready) await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, 'local database startup');
  installPgCronStub(root, name, (args, input) => docker(['exec', ...args], input));
  const sql = text => {
    try { docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'paycommon',
      '-v', 'ON_ERROR_STOP=1', '-c', text]); return { ok: true }; }
    catch (error) { return { ok: false, error: String(error.stderr) }; }
  };
  const report = buildFromFiles(root, { applyFile: path => sql(readFileSync(resolve(root, path), 'utf8')),
    applyServerOnly: sql });
  assert.equal(report.failed, null, JSON.stringify(report.failed));
  console.log(JSON.stringify({ endpoint, name, steps: report.passed }));
} catch (error) {
  docker(['rm', '-f', '-v', name]);
  throw error;
}
