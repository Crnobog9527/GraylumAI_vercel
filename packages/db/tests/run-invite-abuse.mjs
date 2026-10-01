/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only full file-built database, Auth, PostgREST and independent SQL sessions. No env files.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFromFiles, installPgCronStub } from './baseline/build-from-files.mjs';
import { POSTGRES_IMAGE, POSTGREST_IMAGE, GOTRUE_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) throw new Error('Require local-only');
const root = resolve(import.meta.dirname, '../../..');
for (const path of ['.env', '.env.local', 'apps/web/.env.local', 'packages/api/.env.local']) {
  if (existsSync(resolve(root, path))) throw new Error('Require a credential-free worktree');
}
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const command = (cmd, args, input) => execFileSync(cmd, args, {
  cwd: root, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
const endpoint = command('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Require local Unix Docker');
const docker = (...args) => command('docker', ['--host', endpoint, ...args]);
for (const image of [POSTGRES_IMAGE, POSTGREST_IMAGE, GOTRUE_IMAGE]) docker('image', 'inspect', image);
const tag = `graylum-invite-abuse-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`, auth = `${tag}-auth`;
const jwtKey = 'test-only-erasure-e-jwt-signing-key-00001';
const keyring = JSON.stringify({ active: 'test-v1',
  keys: { 'test-v1': Buffer.from('test-only-opening-grant-key-00001').toString('base64') } });
const jwt = role => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, aud: 'authenticated', exp: 4102444800 })}`;
  return `${body}.${createHmac('sha256', jwtKey).update(body).digest('base64url')}`;
};
const sql = input => command('docker', ['--host', endpoint, 'exec', '-i', db, 'psql', '-XqAt',
  '-U', 'postgres', '-d', 'erasure_e', '-v', 'ON_ERROR_STOP=1', '-f', '/dev/stdin'], input);
const read = file => readFileSync(resolve(root, file), 'utf8');
const file = readdirSync(resolve(root, 'packages/db/migrations'))
  .find(name => name.endsWith('_invitation_claim_eligibility.sql'));
assert.ok(file, 'invitation claim migration required');
const migration = `packages/db/migrations/${file}`;
const signatures = [
  'atomic_claim_invitation_code(text,uuid,text,text,text,text,integer,integer,text,text)',
  'atomic_apply_invitation_rebate(uuid,integer,text,integer,integer,integer,timestamptz,timestamptz,text)',
];
const fingerprintText = read('packages/db/tests/baseline/fingerprint.sql');
const catalog = () => JSON.parse(sql(`${fingerprintText.slice(0, fingerprintText.indexOf('-- FINAL'))}
  SELECT jsonb_object_agg(k,d ORDER BY k) FROM grouped;`));
const waitFor = async probe => {
  for (let i = 0; i < 150; i++) {
    try { if (await probe()) return; } catch { /* final TCP server may still be starting */ }
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('Local service readiness timeout');
};

try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_DB=erasure_e', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  await waitFor(() => docker('exec', db, 'psql', '-X', '-h', '127.0.0.1', '-U', 'postgres',
    '-d', 'erasure_e', '-tAc', 'SELECT 1') === '1');
  installPgCronStub(root, db, (argv, input) => command('docker', ['--host', endpoint, 'exec', ...argv], input));
  // Apply every prerequisite from the authoritative builder; defer only this migration to take
  // the actual complete catalog before/after/rollback snapshots. Never edits shared migration files.
  const outcome = action => {
    try { action(); return { ok: true, error: [] }; } catch { return { ok: false, error: ['local build failed'] }; }
  };
  const built = buildFromFiles(root, {
    applyFile: path => outcome(() => { if (path !== migration) sql(read(path)); }),
    applyServerOnly: input => outcome(() => sql(input)),
  });
  assert.equal(built.failed, null, 'complete prerequisite build');
  const before = catalog();
  sql(read('packages/db/tests/invite-abuse/reproduce.sql'));
  console.log('PASS pre-fix reproduction: multi-code, missing opening decision, bigint replay');
  const rollback = signatures.map(signature => sql(`SELECT pg_get_functiondef('${signature}'::regprocedure)`)).join(';\n')
    + ';\nDROP INDEX public.invitation_records_invitee_decision_idx;';
  sql(read(migration));
  const after = catalog();
  sql(read(migration));
  assert.deepEqual(catalog(), after, 'second migration execution leaves full catalog unchanged');
  sql(rollback);
  assert.deepEqual(catalog(), before, 'rollback restores full catalog including ACLs/policies/indexes');
  sql(read(migration));
  assert.deepEqual(catalog(), after, 'reapply after rollback restores full candidate');
  assert.equal(sql(read('packages/db/tests/erasure-e-audit.sql')), '');
  assert.equal(sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  console.log('PASS full file build, migration twice, exact catalog rollback/reapply, both audits');


  // Supplementary synthetic table for the original PR-A column-grant RLS regression; the
  // authoritative product schema above is never replaced by this fixture. Created after catalog snapshots.
  sql(`CREATE TABLE fixture_notes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES profiles(id), body text NOT NULL);
    ALTER TABLE fixture_notes ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON fixture_notes FROM PUBLIC,anon,authenticated;
    GRANT SELECT(user_id,body),INSERT(user_id,body) ON fixture_notes TO authenticated;
    CREATE POLICY fixture_notes_owner ON fixture_notes FOR ALL TO authenticated
      USING(auth.uid()=user_id) WITH CHECK(auth.uid()=user_id);
    CREATE POLICY account_open_required ON fixture_notes AS RESTRICTIVE FOR ALL TO authenticated
      USING(NOT (SELECT current_account_is_closed())) WITH CHECK(NOT (SELECT current_account_is_closed()));`);

  sql('CREATE ROLE erasure_e_auth LOGIN SUPERUSER; ALTER ROLE erasure_e_auth SET search_path=auth,public;');
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/erasure_e`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${jwtKey}`, POSTGREST_IMAGE);
  docker('run', '-d', '--pull=never', '--name', auth, '--network', tag, '-p', '127.0.0.1::9999',
    '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'PORT=9999', '-e', 'GOTRUE_DB_DRIVER=postgres',
    '-e', `DATABASE_URL=postgres://erasure_e_auth@${db}:5432/erasure_e?sslmode=disable`,
    '-e', 'GOTRUE_SITE_URL=http://127.0.0.1', '-e', 'API_EXTERNAL_URL=http://127.0.0.1',
    '-e', `GOTRUE_JWT_SECRET=${jwtKey}`, '-e', 'GOTRUE_JWT_AUD=authenticated', '-e', 'GOTRUE_JWT_EXP=3600',
    '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role',
    '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true', '-e', 'GOTRUE_MAILER_AUTOCONFIRM=true',
    '-e', 'GOTRUE_MAILER_OTP_EXP=4',
    '-e', 'GOTRUE_DISABLE_SIGNUP=false', GOTRUE_IMAGE);
  const port = (name, value) => docker('port', name, value).split(':').at(-1);
  const restUrl = `http://127.0.0.1:${port(rest, '3000')}`;
  const authUrl = `http://127.0.0.1:${port(auth, '9999')}`;
  await waitFor(async () => (await fetch(restUrl)).ok);
  await waitFor(async () => (await fetch(`${authUrl}/health`)).ok);
  assert.equal(sql(read('packages/db/tests/erasure-e-staging-source.sql')), '0|0|0|0',
    'read-only preflight parses against the actual local Auth schema without exposing identities');
  const testEnv = { ...env, OPENING_GRANT_HMAC_KEYS: keyring,
    ERASURE_E_LOCAL_REST: restUrl, ERASURE_E_LOCAL_AUTH: authUrl,
    ERASURE_LOCAL_REST: restUrl, ERASURE_LOCAL_AUTH: authUrl,
    ERASURE_SERVICE_JWT: jwt('service_role'), ERASURE_ANON_JWT: jwt('anon'),
    ERASURE_E_LOCAL_DB: `postgres://postgres@127.0.0.1:${port(db, '5432')}/erasure_e`,
    ERASURE_E_SERVICE_JWT: jwt('service_role'), ERASURE_E_ANON_JWT: jwt('anon') };
  // Sequential: the rotation test persists v2 facts, so a later v1-only process must be rejected.
  for (const test of ['../invitationAbuse.integration.ts', 'accountErasure.integration.ts', 'openingGrant.integration.ts']) {
    execFileSync('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts',
      test.startsWith('../') ? `src/services/${test.slice(3)}` : `src/services/accountErasure/${test}`], {
      cwd: root, stdio: 'inherit', env: testEnv,
    });
  }
  console.log('PASS invitation and original erasure/opening Auth integration regressions');
} catch (error) {
  console.error('FAIL invite-abuse local validation:', error.code ?? error.name);
  console.error(error.message);
  if (error.stderr) console.error(String(error.stderr).slice(-3000));
  process.exitCode = 1;
} finally {
  let clean = true;
  for (const name of [auth, rest, db]) {
    try { docker('container', 'inspect', name); } catch { continue; }
    try { docker('rm', '-f', '-v', name); } catch { clean = false; }
  }
  try { docker('network', 'rm', tag); } catch { clean = false; }
  console.log(`Invite-abuse cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
