/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// S1-FIX batch 3 (B-02/B-03): observed baseline, 0146 repair, idempotency and exact rollback.
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
const tag = `graylum-s1f3-${randomUUID().slice(0, 8)}`;
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
  '-X', '-A', '-t', '-U', 'postgres', '-d', 's1f3', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], input);
const deniedSql = (role, query, sub = owner) => {
  let code;
  try { sql(`SET request.jwt.claims='${JSON.stringify({ sub })}'; SET ROLE ${role}; ${query};`); }
  catch (error) { code = /42501/.test(String(error.stderr)); }
  assert.equal(code, true, `${role} must receive SQLSTATE 42501 for ${query}`);
};
// Whole public catalog: sorted table/column ACLs, RLS, policies and postgres' table defaults.
const snapshot = () => JSON.parse(sql(`SELECT jsonb_build_object(
  'tables',(SELECT jsonb_object_agg(c.relname, jsonb_build_object(
    'acl',(SELECT jsonb_agg(x ORDER BY x) FROM unnest(c.relacl::text[]) x),'rls',c.relrowsecurity,
    'columns',(SELECT jsonb_agg(jsonb_build_array(attname,(SELECT jsonb_agg(y ORDER BY y) FROM unnest(attacl::text[]) y))
      ORDER BY attnum) FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)))
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename, p.policyname) FROM pg_policies p WHERE p.schemaname='public'),
  'defaults',(SELECT jsonb_agg(x ORDER BY x) FROM pg_default_acl d, unnest(d.defaclacl::text[]) x
    WHERE d.defaclrole='postgres'::regrole AND d.defaclnamespace='public'::regnamespace AND d.defaclobjtype='r'));`));
const rows = () => sql(`SELECT jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM diagnostic_results r),
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM application_logs r),
  (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM subscription_credit_grants r));`);
const priv = (role, table, privilege) => sql(`SELECT has_table_privilege('${role}','${table}','${privilege}')`) === 't';
const NON_DML = ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const CLIENT_TABLES = ['ai_models', 'ai_usage_logs', 'application_logs', 'billing_history',
  'conversation_context_snapshots', 'conversations', 'credit_packages', 'credit_transactions',
  'diagnostic_results', 'invitation_records', 'invitations', 'membership_plans', 'messages', 'modules',
  'payment_orders', 'prompts', 'subscription_credit_grants', 'system_settings', 'token_stats',
  'user_checkins', 'user_subscriptions'];
const CLOSED = ['diagnostic_results', 'application_logs'];
// Everything the migration must keep: service_role/postgres entries and client DML outside CLOSED.
const kept = snap => Object.fromEntries(Object.entries(snap.tables).map(([name, t]) => [name, {
  acl: (t.acl ?? []).map(item => {
    const [grantee, rest] = item.split('=');
    if (!['anon', 'authenticated'].includes(grantee)) return item;
    const letters = CLOSED.includes(name) ? '' : rest.split('/')[0].replace(/[Dxtm]/g, '');
    return letters ? `${grantee}=${letters}/${rest.split('/')[1]}` : null;
  }).filter(Boolean).sort(),
  rls: t.rls,
  columns: t.columns,
}]));
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
const migration = 'packages/db/migrations/0146_client_non_dml_and_diagnostics_grants.sql';
const rollback = 'packages/db/tests/s1-fix-3-rollback.sql';
const waitFor = async probe => {
  for (let i = 0; i < 100; i++) {
    try { if (await probe()) return true; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  return false;
};
const RESULT = { test_id: 'ai_routing', test_name: 'AI routing', category: 'ai', status: 'passed' };
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-e', 'POSTGRES_DB=s1f3', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  assert.ok(await waitFor(() => sql('SELECT 1') === '1'), 'local PostgreSQL ready');
  sql(readFileSync(resolve(root, 'packages/db/tests/s1-fix-3-fixture.sql'), 'utf8'));
  const before = snapshot(), dataBefore = rows();
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/s1f3`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  const address = docker('port', rest, '3000/tcp');
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  restUrl = `http://${address}`;
  assert.ok(await waitFor(async () => (await fetch(restUrl, { signal: AbortSignal.timeout(1000) })).ok),
    'local PostgREST ready');
  // Baseline: clients hold MAINTAIN on 21 tables and TRUNCATE (bypassing RLS) on three of them.
  for (const role of ['anon', 'authenticated']) {
    for (const table of CLIENT_TABLES) assert.ok(priv(role, table, 'MAINTAIN'), `${role} ${table} baseline`);
    for (const table of [...CLOSED, 'subscription_credit_grants']) {
      sql(`BEGIN; SET ROLE ${role}; TRUNCATE ${table}; RESET ROLE; ROLLBACK;`);
    }
  }
  assert.equal(sql(`BEGIN; SET request.jwt.claims='{"sub":"${admin}"}'; SET ROLE authenticated;
    INSERT INTO diagnostic_results (test_id, test_name, category, status) VALUES ('x','x','ai','passed');
    RESET ROLE; ROLLBACK; SELECT 'admin-jwt-insert-ok';`).split('\n').at(-1), 'admin-jwt-insert-ok');
  assert.equal(rows(), dataBefore);
  assert.deepEqual(snapshot(), before);
  console.log('PASS baseline: client MAINTAIN on 21 tables, client TRUNCATE despite RLS, admin JWT writes diagnostics (rolled back)');
  apply(migration);
  assert.equal(rows(), dataBefore, 'migration must not change any row');
  const repaired = snapshot();
  apply(migration);
  assert.deepEqual(snapshot(), repaired, 'migration idempotency');
  assert.deepEqual(repaired.policies, before.policies, 'policies untouched');
  assert.deepEqual(kept(repaired), kept(before), 'only client non-DML and the two closed tables changed');
  assert.deepEqual(repaired.defaults.filter(item => /^(anon|authenticated|service_role)=/.test(item)),
    ['service_role=Dxtm/postgres'], 'client table defaults removed, service_role defaults kept');
  for (const role of ['anon', 'authenticated']) {
    for (const table of Object.keys(repaired.tables)) {
      for (const privilege of NON_DML) assert.equal(priv(role, table, privilege), false, `${role} ${table} ${privilege}`);
    }
    for (const table of CLOSED) {
      for (const privilege of DML) assert.equal(priv(role, table, privilege), false, `${role} ${table} ${privilege}`);
    }
    for (const table of [...CLOSED, 'subscription_credit_grants']) deniedSql(role, `TRUNCATE ${table}`);
  }
  // Kept client DML still works (sample): users keep their table-level reads.
  assert.ok(priv('authenticated', 'conversations', 'INSERT') && priv('anon', 'credit_packages', 'SELECT'));
  // New tables created by postgres no longer hand clients non-DML privileges.
  sql('CREATE TABLE s1f3_new_table(id int)');
  for (const role of ['anon', 'authenticated']) {
    for (const privilege of NON_DML) assert.equal(priv(role, 's1f3_new_table', privilege), false);
  }
  assert.ok(priv('service_role', 's1f3_new_table', 'TRUNCATE'), 'service_role defaults untouched');
  sql('DROP TABLE s1f3_new_table');
  console.log('PASS 0146 SQL: no client non-DML on any table or new table; diagnostics/logs closed; rest unchanged; idempotent');
  execFileSync('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run',
    '--config', 'vitest.integration.config.ts', 'src/services/diagnosticsResultsGrants.integration.ts'], {
    cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME,
      S1F3_LOCAL_REST: restUrl, S1F3_SERVICE_JWT: jwt('service_role', admin), S1F3_ADMIN_ID: admin,
      S1F3_ADMIN_JWT: jwt('authenticated', admin), S1F3_OWNER_JWT: jwt('authenticated', owner),
      S1F3_ANON_JWT: jwt('anon'),
    },
  });
  console.log('PASS S1-FIX-3: real diagnostics save/latest/history/summary/cleanup via service_role; clients denied');
  // PostgREST: service_role keeps full diagnostic access; every client JWT is refused.
  const [saved] = await ok('service_role', admin, 'diagnostic_results?select=id', 'POST', RESULT);
  await ok('service_role', admin, `diagnostic_results?id=eq.${saved.id}`, 'DELETE');
  for (const [role, sub] of [[null, null], ['authenticated', owner], ['authenticated', admin]]) {
    for (const table of CLOSED) {
      await denied(role, sub, `${table}?select=id`);
      await denied(role, sub, `${table}?select=id`, 'POST', table === 'diagnostic_results'
        ? RESULT : { level: 'warn', category: 'system', message: 'x' });
      await denied(role, sub, `${table}?id=not.is.null`, 'PATCH', { message: 'x' });
      await denied(role, sub, `${table}?id=not.is.null`, 'DELETE');
    }
  }
  console.log('PASS 0146 PostgREST: service_role diagnostics insert/delete; anon/user/admin JWT fully denied');
  const afterOperations = rows();
  apply(rollback);
  assert.deepEqual(snapshot(), before, 'exact baseline catalog restored');
  assert.equal(rows(), afterOperations, 'rollback does not touch data');
  console.log('PASS exact rollback to the 16:17:55 UTC catalog with data preserved');
  apply(migration);
  sql(`GRANT SELECT(message), INSERT(test_id), UPDATE(status), REFERENCES(id)
    ON diagnostic_results TO PUBLIC, anon, authenticated;
    GRANT REFERENCES(id) ON modules TO PUBLIC, anon; GRANT TRUNCATE ON opc_accounts TO PUBLIC;`);
  apply(migration);
  assert.deepEqual(snapshot(), repaired);
  console.log('PASS 0146 clears historical PUBLIC/client column ACLs and PUBLIC non-DML');
  // A client privilege the migration does not revoke (inherited through role membership).
  sql('CREATE ROLE s1f3_other NOLOGIN; GRANT s1f3_other TO anon; GRANT TRUNCATE ON opc_accounts TO s1f3_other;');
  let failedClosed = false;
  try { apply(migration); } catch (error) { failedClosed = /S1-FIX-3: a client privilege survived/.test(String(error.stderr)); }
  assert.ok(failedClosed, 'migration must fail closed when it cannot revoke a client privilege');
  assert.deepEqual(snapshot().tables.diagnostic_results, repaired.tables.diagnostic_results);
  console.log('PASS 0146 fails closed (whole transaction) when a client non-DML privilege survives');
} catch (error) {
  // Only synthetic assertion information; never print connection strings or JWTs.
  console.error('FAIL S1-FIX-3 diagnostic:', error.code ?? error.name, error.operator ?? '');
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
  console.log(`S1-FIX-3 cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
