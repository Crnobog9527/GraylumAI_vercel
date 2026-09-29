/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// S1-FIX batch 2 (A-09): observed baseline blocker, 0145 repair, idempotency and exact rollback.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE, POSTGREST_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
if (process.env.CI) throw new Error('Diagnostic fixture is local-only');
const root = resolve(import.meta.dirname, '../../..');
for (const path of ['.env', '.env.local', 'apps/web/.env.local', 'packages/api/.env.local']) {
  if (existsSync(resolve(root, path))) throw new Error('Use a credential-free worktree');
}
const run = (cmd, args, input) => execFileSync(cmd, args, {
  cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME }, input,
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
const endpoint = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Local Docker only');
const docker = (...args) => run('docker', ['--host', endpoint, ...args]);
for (const image of [POSTGRES_IMAGE, POSTGREST_IMAGE]) docker('image', 'inspect', image);
const tag = `graylum-s1f2-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`;
const secret = randomUUID() + randomUUID();
const owner = '00000000-0000-4000-8000-000000000001';
const admin = '00000000-0000-4000-8000-000000000003';
const jwt = (role, sub) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
};
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql',
  '-X', '-A', '-t', '-U', 'postgres', '-d', 's1f2', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], input);
const deniedSql = (role, query, sub = owner) => {
  let code;
  try { sql(`SET request.jwt.claims='${JSON.stringify({ sub })}'; SET ROLE ${role}; ${query};`); }
  catch (error) { code = /42501/.test(String(error.stderr)); }
  assert.equal(code, true, `${role} must receive SQLSTATE 42501 for ${query}`);
};
const snapshot = () => JSON.parse(sql(`SELECT jsonb_build_object(
  'acl',(SELECT jsonb_agg(x ORDER BY x) FROM unnest(relacl::text[]) x),'rls',relrowsecurity,
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p WHERE p.tablename='scheduled_job_runs'),
  'columns',(SELECT jsonb_agg(jsonb_build_array(attname,(SELECT jsonb_agg(y ORDER BY y) FROM unnest(attacl::text[]) y))
    ORDER BY attnum) FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped))
  FROM pg_class c WHERE c.oid='public.scheduled_job_runs'::regclass;`));
const rows = () => sql(`SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM scheduled_job_runs r;`);
let restUrl;
const http = async (role, sub, path, method = 'GET', body) => {
  const response = await fetch(`${restUrl}/${path}`, {
    method, signal: AbortSignal.timeout(5000),
    headers: { ...(role ? { Authorization: `Bearer ${jwt(role, sub)}` } : {}),
      'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const denied = async (role, sub, path, method, body) => {
  const response = await http(role, sub, path, method, body);
  assert.equal(response.body?.code, '42501', `${role ?? 'anon'} ${method ?? 'GET'} ${path}`);
};
const ok = async (role, sub, path, method, body) => {
  const response = await http(role, sub, path, method, body);
  assert.ok(response.status < 300, `${role} ${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
};
const apply = path => sql(readFileSync(resolve(root, path), 'utf8'));
const migration = 'packages/db/migrations/0145_scheduled_job_runs_service_writes.sql';
const rollback = 'packages/db/tests/s1-fix-2-rollback.sql';
const waitFor = async probe => {
  for (let i = 0; i < 100; i++) {
    try { if (await probe()) return true; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  return false;
};
const START = { job_key: 'ticket_auto_close', trigger_source: 'cron', status: 'running', started_at: new Date().toISOString() };
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-e', 'POSTGRES_DB=s1f2', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  assert.ok(await waitFor(() => sql('SELECT 1') === '1'), 'local PostgreSQL ready');
  sql(readFileSync(resolve(root, 'packages/db/tests/s1-fix-2-fixture.sql'), 'utf8'));
  const before = snapshot(), dataBefore = rows();
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/s1f2`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  const address = docker('port', rest, '3000/tcp');
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  restUrl = `http://${address}`;
  assert.ok(await waitFor(async () => (await fetch(restUrl, { signal: AbortSignal.timeout(1000) })).ok),
    'local PostgREST ready');
  // Baseline: the cron's first write fails, while clients can TRUNCATE despite RLS.
  await denied('service_role', admin, 'scheduled_job_runs?select=id', 'POST', START);
  await denied('service_role', admin, 'scheduled_job_runs?id=not.is.null', 'PATCH', { status: 'success' });
  for (const role of ['anon', 'authenticated']) {
    sql(`BEGIN; SET ROLE ${role}; TRUNCATE scheduled_job_runs; RESET ROLE; ROLLBACK;`);
  }
  assert.equal(rows(), dataBefore);
  assert.deepEqual(snapshot(), before);
  console.log('PASS baseline: service_role run start/finish 42501; client TRUNCATE permitted despite RLS (rolled back)');
  apply(migration);
  assert.equal(rows(), dataBefore, 'migration must not change any row');
  const repaired = snapshot();
  apply(migration);
  assert.deepEqual(snapshot(), repaired, 'migration idempotency');
  assert.deepEqual(repaired.policies, before.policies, 'policies untouched');
  // service_role: exactly the cron bookkeeping columns.
  const [run] = await ok('service_role', admin, 'scheduled_job_runs?select=id', 'POST', START);
  await ok('service_role', admin, `scheduled_job_runs?id=eq.${run.id}&select=id`, 'PATCH',
    { status: 'success', finished_at: new Date().toISOString(), summary: { closed: 0 }, error: null });
  for (const body of [{ ...START, id: randomUUID() }, { ...START, summary: {} }, { ...START, created_at: START.started_at }]) {
    await denied('service_role', admin, 'scheduled_job_runs?select=id', 'POST', body);
  }
  for (const body of [{ job_key: 'other' }, { started_at: START.started_at }, { trigger_source: 'manual' }]) {
    await denied('service_role', admin, `scheduled_job_runs?id=eq.${run.id}`, 'PATCH', body);
  }
  await denied('service_role', admin, `scheduled_job_runs?id=eq.${run.id}`, 'DELETE');
  // Clients (including an admin JWT) have no access at all.
  for (const [role, sub] of [[null, null], ['authenticated', owner], ['authenticated', admin]]) {
    await denied(role, sub, 'scheduled_job_runs?select=id');
    await denied(role, sub, 'scheduled_job_runs?select=id', 'POST', START);
    await denied(role, sub, `scheduled_job_runs?id=eq.${run.id}`, 'PATCH', { status: 'error' });
    await denied(role, sub, `scheduled_job_runs?id=eq.${run.id}`, 'DELETE');
  }
  for (const role of ['anon', 'authenticated']) {
    deniedSql(role, 'TRUNCATE scheduled_job_runs');
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      assert.equal(sql(`SELECT has_table_privilege('${role}','scheduled_job_runs','${privilege}')`), 'f');
    }
  }
  console.log('PASS 0145 SQL/PostgREST: service_role start/finish columns only; no delete/rewrite; clients fully denied; idempotent');
  execFileSync('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run',
    '--config', 'vitest.integration.config.ts', 'src/services/scheduledJobRunsGrants.integration.ts'], {
    cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME,
      S1F2_LOCAL_REST: restUrl, S1F2_SERVICE_JWT: jwt('service_role', admin),
      S1F2_ADMIN_JWT: jwt('authenticated', admin), S1F2_OWNER_JWT: jwt('authenticated', owner),
      S1F2_ANON_JWT: jwt('anon'),
    },
  });
  console.log('PASS S1-FIX-2: real scheduledJobRuns start/finish/latest against local PostgREST');
  const afterOperations = rows();
  apply(rollback);
  assert.deepEqual(snapshot(), before, 'exact baseline ACL restored');
  assert.equal(rows(), afterOperations, 'rollback does not touch data');
  console.log('PASS exact rollback to the 15:01:51 UTC catalog with data preserved');
  apply(migration);
  sql(`GRANT SELECT(summary), INSERT(job_key), UPDATE(status), REFERENCES(id)
    ON scheduled_job_runs TO PUBLIC, anon, authenticated;`);
  apply(migration);
  assert.deepEqual(snapshot(), repaired);
  console.log('PASS 0145 clears historical PUBLIC/client column ACLs');
} catch (error) {
  // Only synthetic assertion information; never print connection strings or JWTs.
  console.error('FAIL S1-FIX-2 diagnostic:', error.code ?? error.name, error.operator ?? '');
  if (error.stderr) console.error(String(error.stderr).replaceAll(secret, '[redacted]'));
  if (error.name === 'AssertionError') console.error(error.message);
  process.exitCode = 1;
} finally {
  let clean = true;
  for (const name of [rest, db]) {
    try { docker('container', 'inspect', name); } catch { continue; }
    try { docker('rm', '-f', '-v', name); } catch { clean = false; }
  }
  try { docker('network', 'rm', tag); } catch { clean = false; }
  console.log(`S1-FIX-2 cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
