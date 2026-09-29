/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// S1-FIX batch 1: observed baseline blockers, 0144 repair, drift fail-closed and exact rollback.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CHANGED_TABLES, verifyBlockers, verifyRepair } from './s1-fix-1-cases.mjs';
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
const tag = `graylum-s1f1-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`;
const secret = randomUUID() + randomUUID();
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-000000000003';
const jwt = (role, sub) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
};
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql',
  '-X', '-A', '-t', '-U', 'postgres', '-d', 's1f1', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], input);
const deniedSql = (role, query, sub = owner) => {
  let code;
  try { sql(`SET request.jwt.claims='${JSON.stringify({ sub })}'; SET ROLE ${role}; ${query};`); }
  catch (error) { code = /42501/.test(String(error.stderr)); }
  assert.equal(code, true, `${role} must receive SQLSTATE 42501 for ${query}`);
};
const TABLES = [...CHANGED_TABLES, 'credit_transactions', 'system_settings'];
const snapshot = () => JSON.parse(sql(`SELECT jsonb_agg(jsonb_build_object(
  'table',c.relname,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p WHERE p.tablename=c.relname),
  'columns',(SELECT jsonb_agg(jsonb_build_array(attname,atttypid,attacl) ORDER BY attnum)
    FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)) ORDER BY c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN (${TABLES.map(t => `'${t}'`).join(',')});`)).map(row => ({
    ...row, acl: row.acl?.sort(),
    columns: row.columns.map(([name, type, acl]) => [name, type, acl?.sort() ?? null]),
  }));
const rows = () => sql(`SELECT jsonb_build_object(${TABLES.map(t =>
  `'${t}',(SELECT jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text) FROM ${t} x)`).join(',')});`);
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
const apply = path => sql(readFileSync(resolve(root, path), 'utf8'));
const migration = 'packages/db/migrations/0144_profile_announcement_admin_grants.sql';
const rollback = 'packages/db/tests/s1-fix-1-rollback.sql';
const waitFor = async probe => {
  for (let i = 0; i < 100; i++) {
    try { if (await probe()) return true; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  return false;
};
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-e', 'POSTGRES_DB=s1f1', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  assert.ok(await waitFor(() => sql('SELECT 1') === '1'), 'local PostgreSQL ready');
  sql(readFileSync(resolve(root, 'packages/db/tests/s1-fix-1-fixture.sql'), 'utf8'));
  const before = snapshot(), dataBefore = rows();
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/s1f1`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  const address = docker('port', rest, '3000/tcp');
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  restUrl = `http://${address}`;
  assert.ok(await waitFor(async () => (await fetch(restUrl, { signal: AbortSignal.timeout(1000) })).ok),
    'local PostgREST ready');
  await verifyBlockers({ sql, http, owner, admin });
  assert.deepEqual(snapshot(), before);
  assert.equal(rows(), dataBefore);
  console.log('PASS baseline: nickname/banner/admin profile/announcement/audit 42501, checkin key hidden, '
    + 'client TRUNCATE permitted despite RLS (rolled back)');
  // Unexpected policies must prevent any partial grant change.
  for (const drift of [
    'CREATE POLICY unexpected_access ON announcements FOR SELECT USING (true)',
    'CREATE POLICY profiles_select_own_2 ON profiles FOR SELECT USING (true)',
    'CREATE POLICY user_activity_logs_insert_any ON user_activity_logs FOR INSERT WITH CHECK (true)',
  ]) {
    sql(drift);
    const drifted = snapshot();
    let blocked = false;
    try { apply(migration); } catch (error) { blocked = String(error.stderr).includes('unexpected profile'); }
    assert.equal(blocked, true, drift);
    assert.deepEqual(snapshot(), drifted);
    sql(`DROP POLICY ${drift.split(' ')[2]} ON ${drift.split(' ')[4]}`);
  }
  assert.deepEqual(snapshot(), before);
  console.log('PASS 0144 fails closed on unknown policies without partial changes');
  apply(migration);
  assert.equal(rows(), dataBefore, 'migration must not change any row');
  const repaired = snapshot();
  apply(migration);
  assert.deepEqual(snapshot(), repaired, 'migration idempotency');
  for (const table of ['credit_transactions', 'system_settings']) {
    assert.deepEqual(repaired.find(x => x.table === table), before.find(x => x.table === table));
  }
  await verifyRepair({ sql, http, deniedSql, owner, other, admin });
  console.log('PASS 0144 SQL/PostgREST: own nickname only, other/anon/client denials, banner columns, '
    + 'service_role admin writes and audit, unchanged ledger/settings ACLs, idempotency');
  execFileSync('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run',
    '--config', 'vitest.integration.config.ts', 'src/routers/s1Fix1Grants.integration.ts'], {
    cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME,
      S1F1_LOCAL_REST: restUrl, S1F1_OWNER_JWT: jwt('authenticated', owner),
      S1F1_ADMIN_JWT: jwt('authenticated', admin), S1F1_SERVICE_JWT: jwt('service_role', admin),
      S1F1_ANON_JWT: jwt('anon'),
    },
  });
  console.log('PASS S1-FIX-1: real user/settings/checkin/admin routers against local PostgREST');
  const afterOperations = rows();
  apply(rollback);
  assert.deepEqual(snapshot(), before, 'exact baseline ACL and policies restored');
  assert.equal(rows(), afterOperations, 'rollback does not touch data');
  console.log('PASS exact rollback to the 13:18:38 UTC catalog with data preserved');
  // Old PUBLIC/client column grants must not survive a (re)application.
  apply(migration);
  sql(`GRANT SELECT(last_ip), UPDATE(credits), INSERT(role), REFERENCES(id) ON profiles TO PUBLIC, anon;
    GRANT UPDATE(role), INSERT(credits) ON profiles TO authenticated;
    GRANT SELECT(icon), UPDATE(title), INSERT(title) ON announcements TO PUBLIC, anon, authenticated;
    GRANT SELECT(ip_address), INSERT(action) ON user_activity_logs TO PUBLIC, anon, authenticated;`);
  apply(migration);
  assert.deepEqual(snapshot(), repaired);
  console.log('PASS 0144 clears historical PUBLIC/client column ACLs');
} catch (error) {
  // Only synthetic assertion information; never print connection strings or JWTs.
  console.error('FAIL S1-FIX-1 diagnostic:', error.code ?? error.name, error.operator ?? '');
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
  console.log(`S1-FIX-1 cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
