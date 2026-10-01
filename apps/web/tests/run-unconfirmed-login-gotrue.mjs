/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local only: starts a disposable Postgres + GoTrue (staging's version) + mail catcher, runs
// src/lib/authFlow.gotrue.test.ts, src/lib/authLanding.gotrue.test.ts and src/lib/passwordRecovery.gotrue.test.ts
// against them, then removes everything.
// Usage: node apps/web/tests/run-unconfirmed-login-gotrue.mjs --local-only
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Staging reported GoTrue v2.197.0 on 2026-09-30. Tag and index digest are updated together.
const GOTRUE_IMAGE = 'ghcr.io/supabase/gotrue:v2.197.0@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b';
const MAILPIT_IMAGE = 'axllent/mailpit:v1.31.3@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d';
const POSTGRES_IMAGE = 'postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';

if (process.argv[2] !== '--local-only' || process.env.CI) {
  throw new Error('Usage: node apps/web/tests/run-unconfirmed-login-gotrue.mjs --local-only');
}
const web = resolve(import.meta.dirname, '..');
const run = (cmd, args, input) => execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const docker = (...args) => run('docker', args);
const endpoint = run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
if (!endpoint.startsWith('unix:///')) throw new Error('Local Docker only');

const tag = `graylum-unconfirmed-${randomUUID().slice(0, 8)}`;
const db = `${tag}-db`, mail = `${tag}-mail`, auth = `${tag}-auth`;
// Disposable: the password reset test signs a service_role token with it to ban a local test user.
const jwtSecret = `${randomUUID()}${randomUUID()}`;
const waitFor = async probe => {
  for (let i = 0; i < 150; i += 1) {
    try { if (await probe()) return; } catch {}
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('service did not become ready');
};
try {
  docker('network', 'create', tag);
  docker('run', '-d', '--name', db, '--network', tag, '-e', 'POSTGRES_DB=auth',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE);
  docker('run', '-d', '--name', mail, '--network', tag, '-p', '127.0.0.1::8025', MAILPIT_IMAGE);
  // TCP only opens once the image's init phase (which creates the database) has finished.
  await waitFor(() => docker('exec', db, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'auth').includes('accepting'));
  run('docker', ['exec', '-i', db, 'psql', '-X', '-U', 'postgres', '-d', 'auth', '-v', 'ON_ERROR_STOP=1'], `
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    CREATE ROLE supabase_auth_admin LOGIN SUPERUSER; ALTER ROLE supabase_auth_admin SET search_path = auth;
    CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;`);
  docker('run', '-d', '--name', auth, '--network', tag, '-p', '127.0.0.1::9999',
    '-e', 'GOTRUE_API_HOST=0.0.0.0', '-e', 'PORT=9999', '-e', 'GOTRUE_DB_DRIVER=postgres',
    '-e', `DATABASE_URL=postgres://supabase_auth_admin@${db}:5432/auth?sslmode=disable`,
    '-e', 'GOTRUE_SITE_URL=http://127.0.0.1:3000', '-e', 'API_EXTERNAL_URL=http://127.0.0.1:9999',
    '-e', 'GOTRUE_URI_ALLOW_LIST=http://127.0.0.1:3000/**',
    '-e', `GOTRUE_JWT_SECRET=${jwtSecret}`, '-e', 'GOTRUE_JWT_AUD=authenticated',
    '-e', 'GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated', '-e', 'GOTRUE_JWT_ADMIN_ROLES=service_role',
    '-e', 'GOTRUE_EXTERNAL_EMAIL_ENABLED=true', '-e', 'GOTRUE_MAILER_AUTOCONFIRM=false',
    '-e', 'GOTRUE_DISABLE_SIGNUP=false', '-e', 'GOTRUE_MAILER_OTP_EXP=2',
    '-e', 'GOTRUE_SMTP_MAX_FREQUENCY=1ns', '-e', 'GOTRUE_RATE_LIMIT_EMAIL_SENT=1000',
    '-e', `GOTRUE_SMTP_HOST=${mail}`, '-e', 'GOTRUE_SMTP_PORT=1025',
    '-e', 'GOTRUE_SMTP_ADMIN_EMAIL=noreply@example.test', GOTRUE_IMAGE);
  const port = (name, p) => docker('port', name, p).split(':').at(-1);
  const authUrl = `http://127.0.0.1:${port(auth, '9999')}`;
  const mailUrl = `http://127.0.0.1:${port(mail, '8025')}`;
  await waitFor(async () => (await fetch(`${authUrl}/health`)).ok);
  await waitFor(async () => (await fetch(`${mailUrl}/api/v1/info`)).ok);
  const files = ['src/lib/authFlow.gotrue.test.ts', 'src/lib/authLanding.gotrue.test.ts', 'src/lib/passwordRecovery.gotrue.test.ts'];
  execFileSync('pnpm', ['exec', 'vitest', 'run', ...files], {
    cwd: web, stdio: 'inherit',
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      UNCONFIRMED_LOGIN_GOTRUE_URL: authUrl, UNCONFIRMED_LOGIN_MAIL_URL: mailUrl,
      UNCONFIRMED_LOGIN_GOTRUE_JWT_SECRET: jwtSecret },
  });
  console.log('PASS unconfirmed sign-in and password reset against local GoTrue v2.197.0');
} catch (error) {
  console.error('FAIL unconfirmed sign-in diagnostic:', error.message);
  process.exitCode = 1;
} finally {
  for (const name of [auth, mail, db]) {
    try { docker('rm', '-f', '-v', name); } catch {}
  }
  try { docker('network', 'rm', tag); } catch {}
}
