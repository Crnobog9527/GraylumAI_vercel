/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Isolated, synthetic finance report regression against the complete file-built schema.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFromFiles, installPgCronStub } from './baseline/build-from-files.mjs';
import { POSTGRES_IMAGE, POSTGREST_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
const root = resolve(import.meta.dirname, '../../..');
for (const path of ['.env', '.env.local', 'apps/web/.env.local', 'packages/api/.env.local']) {
  if (existsSync(resolve(root, path))) throw new Error('Use a credential-free worktree');
}
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const run = (cmd, args, input) => execFileSync(cmd, args, {
  cwd: root, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
const endpoint = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
assert.match(endpoint, /^unix:\/\/\/[^\n]+$/);
const docker = (...args) => run('docker', ['--host', endpoint, ...args]);
for (const image of [POSTGRES_IMAGE, POSTGREST_IMAGE]) docker('image', 'inspect', image);
const tag = `graylum-finance-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`;
const secret = randomUUID() + randomUUID();
const admin = '00000000-0000-4000-8000-000000000003';
const jwt = role => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ role, sub: admin, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
};
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql',
  '-X', '-q', '-A', '-t', '-U', 'postgres', '-d', 'finance', '-v', 'ON_ERROR_STOP=1'], input);
const outcome = fn => { try { fn(); return { ok: true }; } catch (e) { return { ok: false, error: [String(e.stderr)] }; } };
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-e', 'POSTGRES_DB=finance', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { sql('SELECT 1'); ready = true; break; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready);
  installPgCronStub(root, db, (args, input) => run('docker', ['--host', endpoint, 'exec', ...args], input));
  const built = buildFromFiles(root, {
    applyFile: path => outcome(() => sql(readFileSync(resolve(root, path), 'utf8'))),
    applyServerOnly: text => outcome(() => docker('exec', db, 'psql', '-X', '-U', 'postgres', '-d', 'finance', '-c', text)),
  });
  assert.equal(built.failed, null, JSON.stringify(built.failed));
  console.log(`Schema built: ${built.passed}/${built.steps}`);
  sql(`INSERT INTO profiles(id,role,nickname) VALUES ('${admin}','admin','Synthetic admin');`);
  // Fixture setup as the local database owner; do not broaden application ledger grants.
  sql(`INSERT INTO credit_transactions(user_id,type,amount) VALUES
    ('${admin}','checkin',7), ('${admin}','future_reward',11);`);
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/finance`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  const address = docker('port', rest, '3000/tcp');
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const origin = `http://${address}`;
  ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready);
  execFileSync('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run', '--config',
    'vitest.integration.config.ts', 'src/routers/adminFinance.integration.ts'], {
    cwd: root, stdio: 'inherit', env: { ...env, FINANCE_LOCAL_REST: origin,
      FINANCE_SERVICE_JWT: jwt('service_role'), FINANCE_ADMIN_JWT: jwt('authenticated') },
  });
} catch (error) {
  console.error('Finance regression failed:', error.message);
  process.exitCode = 1;
} finally {
  for (const name of [rest, db]) {
    try { docker('container', 'inspect', name); } catch { continue; }
    docker('rm', '-f', '-v', name);
  }
  docker('network', 'rm', tag);
  console.log('Local finance containers removed');
}
