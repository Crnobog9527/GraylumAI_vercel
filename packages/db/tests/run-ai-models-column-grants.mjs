/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// B01: isolated synthetic S1 ACL-02 fixture, not a complete migration replay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POSTGRES_IMAGE, POSTGREST_IMAGE } from './v3/images.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
const root = resolve(import.meta.dirname, '../../..');
for (const path of ['.env.local', 'apps/web/.env.local', 'packages/api/.env.local']) {
  if (existsSync(resolve(root, path))) throw new Error('Use a credential-free worktree');
}
const run = (cmd, args, input) => execFileSync(cmd, args, { cwd: root,
  env: { PATH: process.env.PATH, HOME: process.env.HOME }, input,
  encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const endpoint = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Local Docker only');
const docker = (...args) => run('docker', ['--host', endpoint, ...args]);
for (const image of [POSTGRES_IMAGE, POSTGREST_IMAGE]) docker('image', 'inspect', image);
const tag = `graylum-b01-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`;
const secret = randomUUID() + randomUUID();
const jwt = role => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
};
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql',
  '-X', '-A', '-t', '-U', 'postgres', '-d', 'b01', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], input);
const apply = path => sql(readFileSync(resolve(root, path), 'utf8'));
const migration = 'packages/db/migrations/0142_ai_models_column_grants.sql';
const rollback = 'packages/db/tests/ai-models-column-grants-rollback.sql';
const asRole = (role, query) => sql(`SET ROLE ${role}; ${query};`).replace(/^SET\n/, '');
const denied = (role, query) => {
  let code;
  try { asRole(role, query); } catch (error) { code = /42501/.test(String(error.stderr)); }
  assert.equal(code, true, `${role} must receive SQLSTATE 42501`);
};
const snapshot = () => sql(`SELECT jsonb_build_object(
  'acl', relacl::text, 'rls', relrowsecurity, 'force', relforcerowsecurity,
  'policies', (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policy p WHERE polrelid=c.oid),
  'data', (SELECT jsonb_agg(to_jsonb(m)) FROM ai_models m),
  'columns', (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,attacl)) FROM pg_attribute
    WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped))
  FROM pg_class c WHERE oid='public.ai_models'::regclass;`);
let restUrl;
const http = async (role, columns) => {
  const response = await fetch(`${restUrl}/ai_models?select=${encodeURIComponent(columns)}`, {
    headers: { Authorization: `Bearer ${jwt(role)}` },
  });
  return { status: response.status, body: await response.json() };
};
const verify = async () => {
  denied('authenticated', 'SELECT api_key FROM ai_models');
  denied('authenticated', 'SELECT * FROM ai_models');
  denied('anon', 'SELECT id FROM ai_models');
  denied('b01_unprivileged', 'SELECT api_key FROM ai_models');
  assert.equal(asRole('authenticated', 'SELECT name FROM ai_models'), 'active');
  assert.equal(asRole('service_role', 'SELECT count(api_key) FROM ai_models'), '2');
  assert.equal(sql(`SELECT has_column_privilege('authenticated','ai_models','api_key','SELECT')`), 'f');
  const safe = await http('authenticated', 'id,name,is_active,future_display');
  assert.equal(safe.status, 200);
  assert.equal(safe.body.length, 1);
  for (const columns of ['api_key', '*', 'id,api_key']) {
    const result = await http('authenticated', columns);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, '42501');
  }
  const anon = await http('anon', 'id');
  assert.equal(anon.body.code, '42501');
  assert.equal((await http('service_role', 'api_key')).body.length, 2);
};
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-e', 'POSTGRES_DB=b01', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try { sql('SELECT 1'); ready = true; break; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, 'local database ready');
  sql(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE ROLE authenticator LOGIN;
    CREATE ROLE b01_unprivileged NOLOGIN;
    GRANT anon,authenticated,service_role TO authenticator;
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role,b01_unprivileged;
    CREATE TABLE ai_models(id integer PRIMARY KEY, name text, is_active text,
      api_key text, future_display text, dropped_column text);
    ALTER TABLE ai_models DROP COLUMN dropped_column;
    ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;
    CREATE POLICY authenticated_active_ai_models_select ON ai_models FOR SELECT
      TO authenticated USING (is_active='true');
    CREATE TABLE profiles(id uuid PRIMARY KEY, role text, status text);
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT SELECT ON profiles TO authenticated;
    CREATE POLICY ai_models_select_admin ON ai_models FOR SELECT TO authenticated USING (
      EXISTS(SELECT 1 FROM profiles p WHERE p.id=auth.uid() AND p.role='admin' AND p.status='active'));
    GRANT MAINTAIN ON ai_models TO anon;
    GRANT SELECT, MAINTAIN ON ai_models TO authenticated;
    GRANT SELECT, INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ai_models TO service_role;
    INSERT INTO ai_models VALUES(1,'active','true','synthetic-active','future'),
      (2,'inactive','false','synthetic-inactive','future');`);
  const before = JSON.parse(snapshot());
  assert.equal(asRole('authenticated', 'SELECT count(api_key) FROM ai_models'), '1');
  denied('anon', 'SELECT api_key FROM ai_models');
  console.log('PASS baseline: S1 ACL-02 and active-row RLS; authenticated can read synthetic credential');
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/b01`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  const address = docker('port', rest, '3000/tcp');
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  restUrl = `http://${address}`;
  ready = false;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(restUrl)).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, 'local REST ready');
  assert.equal((await http('authenticated', 'api_key')).status, 200);
  apply(migration);
  await verify();
  const once = snapshot();
  apply(migration);
  assert.equal(snapshot(), once);
  await verify();
  const after = JSON.parse(once);
  assert.deepEqual(after.policies, before.policies);
  assert.deepEqual(after.data, before.data);
  assert.equal(after.rls, before.rls);
  assert.equal(after.force, before.force);
  assert.equal(after.acl.split(',').find(x => x.startsWith('service_role=')),
    before.acl.split(',').find(x => x.startsWith('service_role=')));
  console.log('PASS migration twice: SQL/REST 42501, safe columns, inactive-row isolation, unchanged service role/RLS/data');
  apply(rollback);
  assert.deepEqual(JSON.parse(snapshot()), before);
  assert.equal((await http('authenticated', 'api_key')).status, 200);
  console.log('PASS rollback: exact original ACL, column grants, policies and data restored');
  // Deliberately dirty grants must not survive the migration, including PUBLIC inheritance.
  sql('GRANT SELECT(api_key) ON ai_models TO PUBLIC, anon, authenticated;');
  apply(migration);
  await verify();
  console.log('PASS historical column grants to PUBLIC/anon/authenticated cleared');
} catch (error) {
  // Never emit query results, tokens, or provider credential values.
  console.error('FAIL B01 local contract:', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  let clean = true;
  for (const name of [rest, db]) {
    try { docker('container', 'inspect', name); } catch { continue; }
    try { docker('rm', '-f', '-v', name); } catch { clean = false; }
  }
  try { docker('network', 'rm', tag); } catch { clean = false; }
  console.log(`B01 cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
