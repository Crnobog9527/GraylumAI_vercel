/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Diagnostic evidence for B02's explicit RLS stop condition, NOT a migration test.
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
const tag = `graylum-b02-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`;
const secret = randomUUID() + randomUUID();
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const admin = '00000000-0000-4000-8000-000000000003';
const ticket = '10000000-0000-4000-8000-000000000001';
const otherTicket = '10000000-0000-4000-8000-000000000002';
const jwt = (role, sub) => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url')}`;
};
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql',
  '-X', '-A', '-t', '-U', 'postgres', '-d', 'b02', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], input);
const asRole = (role, query, sub = owner) => sql(
  `SET request.jwt.claims='${JSON.stringify({ sub })}'; SET ROLE ${role}; ${query};`,
);
const denied = (role, query) => {
  let code;
  try { asRole(role, query); } catch (error) { code = /42501/.test(String(error.stderr)); }
  assert.equal(code, true, `${role} must receive SQLSTATE 42501`);
};
const snapshot = () => JSON.parse(sql(`SELECT jsonb_agg(jsonb_build_object(
  'table',c.relname,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p WHERE p.tablename=c.relname),
  'columns',(SELECT jsonb_agg(jsonb_build_array(attname,atttypid,attacl) ORDER BY attnum)
    FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)) ORDER BY c.relname)
  FROM pg_class c WHERE c.oid IN ('public.tickets'::regclass,'public.ticket_replies'::regclass);`));
const rows = () => sql(`SELECT jsonb_build_object(
  'tickets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tickets t),
  'replies',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ticket_replies r));`);
// Counterfactual grant-only probe: intentionally broad SELECT rules out projection failures.
// Never deploy this. The existing policies are preserved, including their missing own-row rules.
const probe = `GRANT SELECT ON tickets,ticket_replies TO authenticated;
  GRANT INSERT(user_id,title,description,category,status,attachments) ON tickets TO authenticated;
  GRANT INSERT(ticket_id,user_id,content) ON ticket_replies TO authenticated;
  GRANT UPDATE(status) ON tickets TO authenticated;
  REVOKE TRUNCATE,REFERENCES,TRIGGER ON ticket_replies FROM anon,authenticated;`;
const undoProbe = `REVOKE SELECT ON tickets,ticket_replies FROM authenticated;
  REVOKE INSERT(user_id,title,description,category,status,attachments) ON tickets FROM authenticated;
  REVOKE INSERT(ticket_id,user_id,content) ON ticket_replies FROM authenticated;
  REVOKE UPDATE(status) ON tickets FROM authenticated;
  GRANT TRUNCATE,REFERENCES,TRIGGER ON ticket_replies TO anon,authenticated;`;
let restUrl;
const http = async (role, sub, path, method = 'GET', body) => {
  const response = await fetch(`${restUrl}/${path}`, {
    method, signal: AbortSignal.timeout(5000),
    headers: { ...(role ? { Authorization: `Bearer ${jwt(role, sub)}` } : {}),
      'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const verifyBlocker = async () => {
  for (const sub of [owner, other]) {
    const list = await http('authenticated', sub, 'tickets?select=*,ticket_replies(*)');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, [], 'GRANT alone cannot make even own rows visible');
    assert.deepEqual((await http('authenticated', sub, 'ticket_replies?select=*')).body, []);
  }
  for (const user_id of [owner, other]) {
    const result = await http('authenticated', owner, 'tickets', 'POST', { user_id, title: 'fixture' });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, '42501');
  }
  for (const ticket_id of [ticket, otherTicket]) {
    const result = await http('authenticated', owner, 'ticket_replies', 'POST', { ticket_id, user_id: owner, content: 'fixture' });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, '42501');
  }
  const close = await http('authenticated', owner, `tickets?id=eq.${ticket}`, 'PATCH', { status: 'closed' });
  assert.equal(close.status, 200);
  assert.deepEqual(close.body, [], 'UPDATE silently matches zero rows without an own UPDATE policy');
  for (const table of ['tickets', 'ticket_replies']) {
    const anon = await http(null, null, `${table}?select=*`);
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, '42501');
    const adminRead = await http('authenticated', admin, `${table}?select=*`);
    assert.equal(adminRead.status, 200);
    assert.equal(adminRead.body.length, 2, 'Existing policies allow admin JWT reads only');
  }
  for (const role of ['anon', 'authenticated']) denied(role, 'TRUNCATE ticket_replies');
  const service = await http('service_role', admin, 'tickets?select=*');
  assert.equal(service.status, 200);
  assert.equal(service.body.length, 2);
  const replies = await http('service_role', admin, 'ticket_replies?select=*');
  assert.equal(replies.status, 403);
  assert.equal(replies.body.code, '42501');
  denied('service_role', "UPDATE tickets SET status='closed'");
  denied('service_role', `INSERT INTO ticket_replies(ticket_id,content) VALUES('${ticket}','fixture')`);
};
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-e', 'POSTGRES_DB=b02', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { sql('SELECT 1'); ready = true; break; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, 'local PostgreSQL ready');
  sql(readFileSync(resolve(root, 'packages/db/tests/ticket-grants-blocker-fixture.sql'), 'utf8'));
  const before = snapshot(), dataBefore = rows();
  for (const role of ['anon', 'authenticated']) {
    denied(role, 'SELECT * FROM tickets');
    denied(role, 'SELECT * FROM ticket_replies');
    // Demonstrate the dangerous baseline only in this synthetic database and roll it back.
    sql(`BEGIN; SET ROLE ${role}; TRUNCATE ticket_replies; RESET ROLE; ROLLBACK;`);
  }
  assert.equal(rows(), dataBefore);
  console.log('PASS baseline SQL: 42501 reads, client TRUNCATE permitted despite RLS (transaction rolled back)');
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/b02`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  const address = docker('port', rest, '3000/tcp');
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  restUrl = `http://${address}`;
  ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(restUrl, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, 'local PostgREST ready');
  const baseline = await http('authenticated', owner, 'tickets?select=*,ticket_replies(*)');
  assert.equal(baseline.status, 403);
  assert.equal(baseline.body.code, '42501');
  sql(probe);
  await verifyBlocker();
  const once = snapshot();
  sql(probe);
  assert.deepEqual(snapshot(), once);
  await verifyBlocker();
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual(once[i].policies, before[i].policies);
    assert.equal(once[i].rls, before[i].rls);
    assert.equal(once[i].force, before[i].force);
    assert.equal(once[i].acl.find(x => x.startsWith('service_role=')),
      before[i].acl.find(x => x.startsWith('service_role=')));
  }
  assert.equal(rows(), dataBefore);
  console.log('PASS blocker reproduced: grant-only own reads empty; create/reply 42501; close zero rows');
  console.log('PASS negative paths, admin JWT reads, unchanged service-role failures, probe idempotency and unchanged RLS/data');
  sql(undoProbe);
  assert.deepEqual(snapshot(), before);
  assert.equal(rows(), dataBefore);
  console.log('PASS diagnostic probe rollback: exact table/column ACL, RLS and data restored');
  console.log('BLOCKED B02 repair: missing own-row policies; no deployable migration produced');
} catch (error) {
  // Only synthetic assertion information; never print connection strings or JWTs.
  console.error('FAIL B02 diagnostic:', error.code ?? error.name, error.operator ?? '');
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
  console.log(`B02 cleanup: ${clean ? 'PASS' : 'FAIL'}`);
  if (!clean) process.exitCode = 1;
}
