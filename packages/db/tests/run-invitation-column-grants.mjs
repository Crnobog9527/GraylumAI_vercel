/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local Supabase components, synthetic schema fixture; NOT a full migration replay.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { POSTGRES_IMAGE, POSTGREST_IMAGE, GOTRUE_IMAGE } from './v3/images.mjs';

const root = resolve(import.meta.dirname, '../../..');
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
if (process.argv.slice(2).join(' ') !== '--local-only') throw new Error('Require --local-only');
for (const path of ['.env.local', 'apps/web/.env.local', 'packages/api/.env.local']) {
  if (existsSync(resolve(root, path))) throw new Error('Use a credential-free worktree');
}
const run = (cmd, args, options = {}) => execFileSync(cmd, args, {
  cwd: root, env: cleanEnv, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options,
});
const endpoint = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).trim();
if (!endpoint.startsWith('unix:///') || endpoint.includes('\n')) throw new Error('Local Docker only');
const docker = (...args) => run('docker', ['--host', endpoint, ...args]).trim();
for (const image of [POSTGRES_IMAGE, POSTGREST_IMAGE, GOTRUE_IMAGE]) docker('image', 'inspect', image);
const tag = `graylum-c4b-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, rest = `${tag}-rest`, auth = `${tag}-auth`;
const temp = mkdtempSync(resolve(tmpdir(), 'graylum-c4b-'));
const secret = randomUUID() + randomUUID();
const jwt = role => {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url');
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
};
const sql = input => run('docker', ['--host', endpoint, 'exec', '-i', db, 'psql',
  '-X', '-U', 'postgres', '-d', 'c4b', '-v', 'ON_ERROR_STOP=1'], { input });
const read = path => readFileSync(resolve(root, path), 'utf8');
const apply = name => sql(read(`packages/db/migrations/${name}`));
const port = (name, internal) => {
  const address = docker('port', name, internal);
  if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error('Non-loopback binding');
  return address.split(':')[1];
};
let gateway;
const sqlContracts = phase => {
  for (const name of ['atomic_claim_invitation_code.sql', 'atomic_apply_invitation_rebate.sql']) {
    try {
      sql(read(`packages/db/tests/${name}`));
      console.log(`PASS existing SQL test (${phase}): ${name}`);
    } catch (error) {
      console.error(`FAIL existing SQL test (${phase}): ${name}`);
      console.error(String(error.stderr ?? '').trim().split('\n').slice(0, 2).join('\n'));
      process.exitCode = 1;
    }
  }
};
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--pull=never', '--name', db, '--network', tag,
    '-p', '127.0.0.1::5432', '-e', 'POSTGRES_DB=c4b',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      docker('exec', db, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'c4b', '-c', 'SELECT 1');
      ready = true;
      break;
    } catch { await new Promise(resolveWait => setTimeout(resolveWait, 200)); }
  }
  if (!ready) throw new Error('Database did not become ready');
  // Exact ordered-replay prerequisite check. A failure stays BLOCKED; never skip
  // the failure then describe the following fixture as a full migrated database.
  try {
    apply('0001_ai_billing_tables.sql');
    throw new Error('Unexpected empty-baseline success: review the replay prerequisite');
  } catch (error) {
    const diagnostic = String(error.stderr ?? '');
    if (!diagnostic.includes('relation "conversations" does not exist')) throw error;
    console.log('BLOCKED full migration replay prerequisite: 0001 references missing conversations; later files NOT_RUN');
    process.exitCode = 1;
  }
  const platform = read('packages/db/tests/v3/bootstrap.sql').split('CREATE TABLE public.profiles')[0];
  sql(platform);
  sql('CREATE ROLE c4b_auth LOGIN SUPERUSER; ALTER ROLE c4b_auth SET search_path=auth,public;');
  const dbUrl = `postgres://postgres@127.0.0.1:${port(db, '5432/tcp')}/c4b`;
  const config = resolve(temp, 'drizzle.config.cjs');
  writeFileSync(config, `module.exports=${JSON.stringify({ schema: resolve(root, 'packages/db/schema.ts'),
    dialect: 'postgresql', dbCredentials: { url: dbUrl } })};`, { mode: 0o600 });
  run('pnpm', ['exec', 'drizzle-kit', 'push', `--config=${config}`]);
  apply('0001_ai_billing_tables.sql');
  // Copy these existing policy definitions exactly, without applying the failing
  // unrelated boolean/text policies in 0002. Fixture provenance is explicit.
  const rls = read('packages/db/migrations/0002_enable_rls_all_tables.sql');
  for (const table of ['profiles', 'invitations', 'invitation_records', 'system_settings']) {
    sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
  for (const policy of ['profiles_select_own', 'invitations_select_own', 'invitations_insert_own',
    'invitation_records_select_own', 'system_settings_select_all']) {
    const statement = rls.match(new RegExp(`CREATE POLICY "${policy}"[\\s\\S]*?;`));
    if (!statement) throw new Error(`Missing policy source: ${policy}`);
    sql(statement[0]);
  }
  sql(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT SELECT ON profiles, invitations, invitation_records, system_settings TO authenticated;
    GRANT SELECT ON invitation_records TO anon;
    GRANT INSERT ON invitations TO authenticated;`);
  for (const name of ['0024_atomic_apply_credit_ledger_entry.sql', '0025_atomic_claim_invitation_code.sql',
    '0026_atomic_apply_invitation_rebate.sql', '0028_restore_staging_helper_functions.sql']) apply(name);
  const policies = read('packages/db/migrations/0032_admin_policy_shape_reconciliation.sql');
  sql(policies.slice(policies.indexOf('-- invitation_records\n'), policies.indexOf('-- membership_plans\n')));
  apply('0044_credit_transactions_v2_semantics.sql');
  apply('0050_sec1_privileged_rpc_execute_posture_closure.sql');
  sqlContracts('before C4b');
  docker('run', '-d', '--pull=never', '--name', rest, '--network', tag, '-p', '127.0.0.1::3000',
    '-e', `PGRST_DB_URI=postgres://authenticator@${db}:5432/c4b`, '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, POSTGREST_IMAGE);
  docker('run', '-d', '--pull=never', '--name', auth, '--network', tag, '-p', '127.0.0.1::9999',
    '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'PORT=9999', '-e', 'GOTRUE_DB_DRIVER=postgres',
    '-e', `DATABASE_URL=postgres://c4b_auth@${db}:5432/c4b?sslmode=disable`,
    '-e', 'GOTRUE_SITE_URL=http://127.0.0.1', '-e', 'API_EXTERNAL_URL=http://127.0.0.1',
    '-e', `GOTRUE_JWT_SECRET=${secret}`, '-e', 'GOTRUE_JWT_AUD=authenticated',
    '-e', 'GOTRUE_JWT_EXP=3600', '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated',
    '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role', '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true',
    '-e', 'GOTRUE_MAILER_AUTOCONFIRM=false', '-e', 'GOTRUE_DISABLE_SIGNUP=true', GOTRUE_IMAGE);
  const restUrl = `http://127.0.0.1:${port(rest, '3000/tcp')}`;
  const authUrl = `http://127.0.0.1:${port(auth, '9999/tcp')}`;
  for (const url of [restUrl, `${authUrl}/health`]) {
    let ok = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(url)).ok) { ok = true; break; } } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    if (!ok) throw new Error('Local Supabase component not ready');
  }
  gateway = createServer(async (req, res) => {
    const base = req.url?.startsWith('/rest/v1/') ? restUrl
      : req.url?.startsWith('/auth/v1/') ? authUrl : null;
    if (!base) { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = { ...req.headers };
    for (const key of ['host', 'connection', 'content-length']) delete headers[key];
    try {
      const response = await fetch(base + req.url.slice('/rest/v1'.length), {
        method: req.method, headers, redirect: 'error',
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
  });
  await new Promise(resolveListen => gateway.listen(0, '127.0.0.1', resolveListen));
  const apiUrl = `http://127.0.0.1:${gateway.address().port}`;
  const child = spawn('pnpm', ['--filter', '@repo/api', 'exec', 'vitest', 'run',
    '--config', 'vitest.integration.config.ts', 'src/services/__tests__/invitationColumnGrants.integration.ts'], {
    cwd: root, stdio: 'inherit', env: { ...cleanEnv, CI: 'true', NODE_ENV: 'test',
      C4B_LOCAL_DB: dbUrl, C4B_LOCAL_ONLY: 'true', NEXT_PUBLIC_SUPABASE_URL: apiUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: jwt('anon'), SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'),
      NEXT_PUBLIC_APP_URL: apiUrl },
  });
  const code = await new Promise(resolveExit => child.on('exit', resolveExit));
  if (code !== 0) throw new Error(`Invitation integration exit ${code}`);
  sqlContracts('after C4b');
} catch (error) {
  // Keep database diagnostics local; never dump auth logs, process env or tokens.
  console.error(String(error.stderr ?? error.message).slice(0, 5000));
  process.exitCode = 1;
} finally {
  if (gateway) { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)); }
  let cleanup = true;
  for (const name of [auth, rest, db]) {
    try { docker('container', 'inspect', name); } catch { continue; }
    try { docker('rm', '-f', '-v', name); } catch { cleanup = false; }
  }
  try { docker('network', 'rm', tag); } catch { cleanup = false; }
  rmSync(temp, { recursive: true, force: true });
  console.log(`C4b cleanup: ${cleanup ? 'PASS' : 'FAIL'}`);
  if (!cleanup) process.exitCode = 1;
}
