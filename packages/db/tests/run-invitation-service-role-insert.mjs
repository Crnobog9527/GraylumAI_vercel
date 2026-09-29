/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Narrow disposable PostgreSQL ACL test; no app, remote database or migration replay.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
const root = resolve(import.meta.dirname, '../../..');
const run = (args, options = {}) => execFileSync('docker', args, {
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
const endpoint = run(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Local Docker only');
const docker = (...args) => run(['--host', endpoint, ...args]);
docker('image', 'inspect', POSTGRES_IMAGE);
const name = `graylum-c4c-${randomUUID()}`;
let created = false;
try {
  docker('run', '-d', '--pull=never', '--name', name, '--network', 'none',
    '-e', 'POSTGRES_DB=c4c', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      docker('exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'c4c');
      ready = true;
      break;
    } catch { await new Promise(done => setTimeout(done, 200)); }
  }
  if (!ready) throw new Error('Local database did not become ready');
  const test = readFileSync(resolve(root, 'packages/db/tests/invitations-service-role-insert.sql'), 'utf8');
  const migration = readFileSync(resolve(root, 'packages/db/migrations/0141_invitations_service_role_insert.sql'), 'utf8');
  const input = test.replaceAll('\\ir ../migrations/0141_invitations_service_role_insert.sql', migration);
  const output = run(['--host', endpoint, 'exec', '-i', name, 'psql',
    '-X', '-U', 'postgres', '-d', 'c4c', '-v', 'ON_ERROR_STOP=1'], { input });
  console.log(output.split('\n').filter(line => line.startsWith('PASS:')).join('\n'));
} catch (error) {
  console.error(String(error.stderr ?? error.message));
  process.exitCode = 1;
} finally {
  if (created) {
    docker('rm', '-f', '-v', name);
    console.log('PASS: disposable local database removed');
  }
}
