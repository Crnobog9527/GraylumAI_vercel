/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DATA-ERASURE PR-A: migration forward/idempotent/rollback plus real Auth (GoTrue) and PostgREST.
// Local-only disposable containers; never reads environment credentials or remote hosts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GOTRUE_IMAGE, POSTGRES_IMAGE, POSTGREST_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
if (process.env.CI) throw new Error('Diagnostic fixture is local-only');
const root = resolve(import.meta.dirname, '../../..');
// PR-E changes the confirmation entry point; use its complete file-built fixture for current API
// coverage, including all original PR-A cases. The historical PR-A-only diagnostic remains below.
if (readdirSync(resolve(root, 'packages/db/migrations')).some(name => name.endsWith('_opening_grant_identity_digests.sql'))) {
  await import('./run-erasure-e.mjs');
  process.exit(process.exitCode ?? 0);
}
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
for (const image of [POSTGRES_IMAGE, POSTGREST_IMAGE, GOTRUE_IMAGE]) docker('image', 'inspect', image);
const tag = `graylum-erasure-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`, auth = `${tag}-auth`;
const secret = randomUUID() + randomUUID();
const roleJwt = role => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
};
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql', '-X', '-A', '-t',
  '-U', 'postgres', '-d', 'erasure', '-v', 'ON_ERROR_STOP=1'], input);
const apply = path => sql(readFileSync(resolve(root, path), 'utf8'));
const migrationName = readdirSync(resolve(root, 'packages/db/migrations'))
  .find(name => /^\d{4}_account_erasure_close\.sql$/.test(name));
assert.ok(migrationName, 'account erasure migration present');
const migration = `packages/db/migrations/${migrationName}`;
const rollback = 'packages/db/tests/account-erasure-close-rollback.sql';
const snapshot = () => JSON.parse(sql(`SELECT jsonb_build_object(
  'tables', (SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'),
  'policies', (SELECT jsonb_agg(jsonb_build_array(tablename, policyname, permissive, roles::text, qual, with_check)
    ORDER BY tablename, policyname) FROM pg_policies WHERE schemaname = 'public'),
  'functions', (SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text, p.proacl::text, p.prosecdef, md5(p.prosrc))
    ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace),
  'triggers', (SELECT jsonb_agg(tgname ORDER BY tgname) FROM pg_trigger
    WHERE tgrelid = 'public.profiles'::regclass AND NOT tgisinternal));`));
const rows = () => sql(`SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM profiles p;`);
const waitFor = async probe => {
  for (let i = 0; i < 150; i++) {
    try { if (await probe()) return true; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  return false;
};
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_DB=erasure', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  assert.ok(await waitFor(() => { sql('SELECT 1'); return true; }), 'local Postgres ready');
  apply('packages/db/tests/account-erasure-close-fixture.sql');
  const before = snapshot();

  apply(migration);
  const once = snapshot();
  apply(migration);
  assert.deepEqual(snapshot(), once, 'migration idempotency');
  const restrictive = once.policies.filter(p => p[1] === 'account_open_required').map(p => p[0]).sort();
  assert.deepEqual(restrictive, ['fixture_column_notes', 'fixture_notes', 'payment_orders', 'user_checkins', 'user_subscriptions'],
    'restrictive policy on every client-accessible RLS table except profiles');
  assert.ok(once.policies.filter(p => p[1] === 'account_open_required').every(p => p[2] === 'RESTRICTIVE'));
  const acl = name => once.functions.find(f => f[0].startsWith(`${name}(`));
  for (const name of ['account_erasure_confirm', 'account_erasure_preview', 'account_erasure_note_error']) {
    assert.match(acl(name)[1], /service_role=X/, `${name} executable by service_role`);
    assert.doesNotMatch(acl(name)[1], /(^|[{,])(anon|authenticated)?=X/, `${name} not client executable`);
  }
  assert.match(acl('current_account_is_closed')[1], /authenticated=X/);
  assert.doesNotMatch(acl('current_account_is_closed')[1], /(^|[{,])(anon)?=X/);
  const tableAcl = sql(`SELECT array_to_string(relacl, ',') FROM pg_class
    WHERE oid = 'public.account_erasure_requests'::regclass;`).split(',').filter(x => !x.startsWith('postgres='));
  assert.deepEqual(tableAcl.map(x => x.split('/')[0]), ['service_role=r'], 'progress table: service_role SELECT only');
  assert.equal(sql(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.account_erasure_requests'::regclass
    AND attacl IS NOT NULL;`), '0', 'no column ACLs');
  // Normal path after the migration: a user edits their own nickname through the profiles trigger.
  const probeUser = randomUUID();
  sql(`INSERT INTO profiles(id, nickname) VALUES ('${probeUser}', 'before');`);
  assert.equal(sql(`BEGIN; SET LOCAL request.jwt.claims = '{"sub":"${probeUser}"}'; SET LOCAL ROLE authenticated;
    UPDATE profiles SET nickname = 'after' WHERE id = '${probeUser}' RETURNING nickname; COMMIT;`)
    .split('\n').filter(line => line === 'after').length, 1, 'own nickname update succeeds after migration');
  sql(`DELETE FROM profiles WHERE id = '${probeUser}';`);
  const audit = () => sql(readFileSync(resolve(root, 'packages/db/tests/account-open-policy-audit.sql'), 'utf8'));
  assert.equal(audit(), '', '§6 audit: every client-accessible table carries account_open_required');
  // A table granted to clients after the migration must be caught until it adds the policy.
  sql(`CREATE TABLE audit_probe(id int PRIMARY KEY); ALTER TABLE audit_probe ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON audit_probe TO authenticated;`);
  assert.equal(audit(), 'audit_probe|policy_missing');
  sql('ALTER TABLE audit_probe DISABLE ROW LEVEL SECURITY;');
  assert.equal(audit(), 'audit_probe|rls_disabled');
  sql(`ALTER TABLE audit_probe ENABLE ROW LEVEL SECURITY; CREATE POLICY account_open_required ON audit_probe
    AS RESTRICTIVE FOR ALL TO authenticated USING (NOT (SELECT public.current_account_is_closed()));`);
  assert.equal(audit(), '');
  sql('DROP TABLE audit_probe;');
  // Definer triage audit runs; in this fixture only the caller-scoped closed check is client-executable.
  const definers = sql(readFileSync(resolve(root, 'packages/db/tests/account-open-definer-audit.sql'), 'utf8'));
  // Staging (2026-09-30) has four: the two writers now check closure; validate_invitation_code (read-only,
  // checks status) and rls_auto_enable (event trigger) are exempt and not part of this fixture.
  const triage = Object.fromEntries(definers.split('\n').map(line => line.split('|'))
    .map(([name, , owner, closed, active, writes]) => [name, { owner, closed, active, writes }]));
  assert.deepEqual(Object.keys(triage).sort(),
    ['claim_daily_checkin(uuid)', 'current_account_is_closed()', 'soft_delete_conversation(uuid,uuid)']);
  for (const name of ['claim_daily_checkin(uuid)', 'soft_delete_conversation(uuid,uuid)']) {
    assert.deepEqual(triage[name], { owner: 'postgres', closed: 't', active: 'f', writes: 't' }, name);
  }
  console.log('PASS migration: idempotent; restrictive RLS coverage; function ACLs; §6 audit');

  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/erasure`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  docker('run', '-d', '--pull=never', '--name', auth, '--network', tag, '-p', '127.0.0.1::9999',
    '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'PORT=9999', '-e', 'GOTRUE_DB_DRIVER=postgres',
    '-e', `DATABASE_URL=postgres://erasure_auth@${db}:5432/erasure?sslmode=disable`,
    '-e', 'GOTRUE_SITE_URL=http://127.0.0.1', '-e', 'API_EXTERNAL_URL=http://127.0.0.1',
    '-e', `GOTRUE_JWT_SECRET=${secret}`, '-e', 'GOTRUE_JWT_AUD=authenticated', '-e', 'GOTRUE_JWT_EXP=3600',
    '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role',
    '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true', '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true',
    '-e', 'GOTRUE_MAILER_OTP_EXP=4', '-e', 'GOTRUE_DISABLE_SIGNUP=true', GOTRUE_IMAGE);
  const port = (name, p) => docker('port', name, p).split(':').at(-1);
  const restUrl = `http://127.0.0.1:${port(rest, '3000')}`;
  const authUrl = `http://127.0.0.1:${port(auth, '9999')}`;
  assert.ok(await waitFor(async () => (await fetch(restUrl)).ok), 'local PostgREST ready');
  assert.ok(await waitFor(async () => (await fetch(`${authUrl}/health`)).ok), 'local GoTrue ready');
  execFileSync('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
    'src/services/accountErasure/accountErasure.integration.ts'], {
    cwd: root, stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME,
      ERASURE_LOCAL_REST: restUrl, ERASURE_LOCAL_AUTH: authUrl, ERASURE_SERVICE_JWT: roleJwt('service_role'),
      ERASURE_ANON_JWT: roleJwt('anon') },
  });
  console.log('PASS integration: real Auth re-authentication, closure, ban, RLS and OTP expiry/replay');

  let refused = false;
  try { apply(rollback); } catch (error) { refused = String(error.stderr).includes('ROLLBACK_REFUSED'); }
  assert.equal(refused, true, 'rollback refuses while closed accounts exist');
  assert.deepEqual(snapshot(), once, 'refused rollback changed nothing');
  // Disposable only: remove closure rows so the exact rollback path can be proven.
  sql('DELETE FROM account_erasure_requests;');
  const data = rows();
  apply(rollback);
  const after = snapshot();
  assert.deepEqual(after.policies, before.policies, 'policies restored');
  assert.deepEqual(after.functions, before.functions, 'functions restored');
  assert.deepEqual(after.triggers, before.triggers, 'triggers restored');
  assert.deepEqual(after.tables.filter(t => t !== 'schema_migrations'), before.tables, 'tables restored');
  assert.equal(rows(), data, 'rollback does not touch profiles');
  apply(migration);
  assert.deepEqual(snapshot().policies, once.policies, 're-apply after rollback');
  console.log('PASS rollback: refused with closures, exact catalog restore, data preserved, re-apply');
} catch (error) {
  console.error('FAIL account erasure diagnostic:', error.code ?? error.name, error.operator ?? '');
  if (error.stderr) console.error(String(error.stderr).replaceAll(secret, '[redacted]'));
  if (error.name === 'AssertionError') console.error(error.message);
  process.exitCode = 1;
} finally {
  let clean = true;
  for (const name of [auth, rest, db]) {
    try { docker('container', 'inspect', name); } catch { continue; }
    try { docker('rm', '-f', '-v', name); } catch { clean = false; }
  }
  try { docker('network', 'rm', tag); } catch { clean = false; }
  console.log(`Account erasure cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
