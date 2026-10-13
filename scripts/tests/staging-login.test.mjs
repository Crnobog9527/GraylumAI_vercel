/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertStagingServiceKey, assertStagingSupabaseUrl, emailForRole, parseAccounts, RefusalError,
} from '../staging-login/guards.mjs';
import { keyFromEnvFile, pickServiceKey } from '../staging-login/service-key.mjs';
import { AUTH_COOKIE_NAME, buildStorageState, createSession } from '../staging-login/session.mjs';
import { defaultPaths, run } from '../staging-login/cli.mjs';

const STAGING = 'gvcpmcunmfrbxuwimxfa';
const PRODUCTION = 'fhmshnqjjnnlvplojktv';

function fakeJwt(payload) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.synthetic-signature`;
}

const STAGING_KEY = fakeJwt({ ref: STAGING, role: 'service_role', iss: 'supabase' });
const ACCESS_TOKEN = 'synthetic-access-token-SHOULD-NOT-BE-PRINTED';
const REFRESH_TOKEN = 'synthetic-refresh-token-SHOULD-NOT-BE-PRINTED';
const USER = { id: 'u-1', email: 'listed@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' };

function fakeAuth({ users = [USER] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    const path = new URL(url).pathname;
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (path.endsWith('/admin/users')) return json({ users });
    if (path.endsWith('/admin/generate_link')) return json({ properties: { hashed_token: 'synthetic-hash' } });
    if (path.endsWith('/verify')) {
      return json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: 'bearer',
        expires_in: 3600, expires_at: 1_900_000_000, user: { id: USER.id, email: USER.email } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('refuses the production Supabase project and any non-staging project', () => {
  assert.throws(() => assertStagingSupabaseUrl(`https://${PRODUCTION}.supabase.co`), /正式环境/);
  for (const url of ['https://abcdefghijklmnopqrst.supabase.co', `http://${STAGING}.supabase.co`,
    `https://${STAGING}.supabase.co.attacker.test`, `https://${STAGING}.supabase.co:8443`,
    'https://auth-staging.graylum.com', 'not a url']) {
    assert.throws(() => assertStagingSupabaseUrl(url), RefusalError, url);
  }
  assert.equal(assertStagingSupabaseUrl(`https://${STAGING}.supabase.co/`), `https://${STAGING}.supabase.co`);
});

test('refuses service keys issued for production or other projects', () => {
  assert.throws(() => assertStagingServiceKey(fakeJwt({ ref: PRODUCTION, role: 'service_role' })), /正式环境/);
  assert.throws(() => assertStagingServiceKey(fakeJwt({ ref: 'abcdefghijklmnopqrst', role: 'service_role' })),
    /不属于测试站/);
  assert.throws(() => assertStagingServiceKey(fakeJwt({ ref: STAGING, role: 'anon' })), /不是管理/);
  assert.throws(() => assertStagingServiceKey('sb_publishable_synthetic_value'), /公开密钥/);
  assert.equal(assertStagingServiceKey(STAGING_KEY), STAGING_KEY);
});

test('env-file fallback refuses a production URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'staging-login-'));
  const file = join(dir, 'supabase-staging.env');
  await writeFile(file, `SUPABASE_URL=https://${PRODUCTION}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=${STAGING_KEY}\n`);
  await assert.rejects(keyFromEnvFile(file), /正式环境/);
  await writeFile(file, `SUPABASE_URL="https://${STAGING}.supabase.co"\nSUPABASE_SERVICE_ROLE_KEY='${STAGING_KEY}'\n`);
  assert.equal(await keyFromEnvFile(file), STAGING_KEY);
});

test('picks the service_role key from Supabase CLI output', () => {
  assert.equal(pickServiceKey([{ name: 'anon', api_key: 'a' }, { name: 'service_role', api_key: STAGING_KEY }]),
    STAGING_KEY);
  assert.equal(pickServiceKey([{ name: 'anon', api_key: 'a' }]), null);
});

test('only listed roles resolve to an email, and role names cannot escape the sessions directory', () => {
  const accounts = parseAccounts(JSON.stringify({ _note: 'x', user: 'Listed@Example.test' }));
  assert.equal(emailForRole(accounts, 'user'), 'listed@example.test');
  assert.throws(() => emailForRole(accounts, 'admin'), /没有角色 admin/);
  for (const role of ['../user', 'User', 'a/b', '']) {
    assert.throws(() => emailForRole(accounts, role), RefusalError, role);
  }
});

test('refuses an email that has no confirmed staging account before generating any link', async () => {
  const unknown = fakeAuth({ users: [{ ...USER, email: 'other@example.test' }] });
  await assert.rejects(createSession({ fetchImpl: unknown.fetchImpl, key: STAGING_KEY, email: USER.email }), /不创建账号/);
  assert.ok(!unknown.calls.some(call => call.url.includes('generate_link')));

  const unconfirmed = fakeAuth({ users: [{ ...USER, email_confirmed_at: null }] });
  await assert.rejects(createSession({ fetchImpl: unconfirmed.fetchImpl, key: STAGING_KEY, email: USER.email }),
    /还没验证/);
  assert.ok(!unconfirmed.calls.some(call => call.url.includes('generate_link')));
});

test('only calls the staging Supabase project', async () => {
  const auth = fakeAuth();
  await createSession({ fetchImpl: auth.fetchImpl, key: STAGING_KEY, email: USER.email });
  assert.deepEqual(auth.calls.map(call => new URL(call.url).host), Array(3).fill(`${STAGING}.supabase.co`));
});

test('storageState uses the @supabase/ssr cookie for auth-staging and chunks long sessions', () => {
  const short = buildStorageState({ access_token: 'a', refresh_token: 'r', user: {} }, 0);
  assert.equal(short.cookies.length, 1);
  assert.equal(short.cookies[0].name, AUTH_COOKIE_NAME);
  assert.equal(short.cookies[0].domain, 'auth-staging.graylum.com');
  assert.ok(short.cookies[0].value.startsWith('base64-'));
  const long = buildStorageState({ access_token: 'x'.repeat(3000), user: {} }, 0);
  assert.deepEqual(long.cookies.map(c => c.name), [`${AUTH_COOKIE_NAME}.0`, `${AUTH_COOKIE_NAME}.1`]);
  const joined = long.cookies.map(c => c.value).join('').slice('base64-'.length);
  assert.equal(JSON.parse(Buffer.from(joined, 'base64url').toString()).access_token.length, 3000);
});

test('end to end: writes a 600 storageState and never logs the key or tokens', async () => {
  const home = await mkdtemp(join(tmpdir(), 'staging-login-home-'));
  const paths = defaultPaths(home);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, '.graylum', 'secrets'), { recursive: true });
  await writeFile(paths.accountsFile, JSON.stringify({ user: USER.email }));
  const auth = fakeAuth();
  const lines = [];
  const runCommand = async () => ({ stdout: JSON.stringify([{ name: 'service_role', api_key: STAGING_KEY }]) });
  const code = await run(['user'], { paths, fetchImpl: auth.fetchImpl, runCommand, log: line => lines.push(line) });
  assert.equal(code, 0);
  const output = lines.join('\n');
  for (const secret of [STAGING_KEY, ACCESS_TOKEN, REFRESH_TOKEN, 'synthetic-hash', USER.email]) {
    assert.ok(!output.includes(secret), `log leaked ${secret.slice(0, 12)}`);
  }
  assert.match(output, /角色 user/);
  assert.match(output, /2030-03-17T17:46:40\.000Z/);
  const file = join(paths.sessionsDir, 'user.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.sessionsDir)).mode & 0o777, 0o700);
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.cookies[0].name, AUTH_COOKIE_NAME);
});

test('refusals surface no secrets even when the auth API errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401,
    json: async () => ({ error_code: 'bad_jwt', msg: `echo ${STAGING_KEY}` }) });
  await assert.rejects(createSession({ fetchImpl, key: STAGING_KEY, email: USER.email }), error => {
    assert.ok(error instanceof RefusalError);
    assert.ok(!error.message.includes(STAGING_KEY));
    assert.match(error.message, /401（bad_jwt）/);
    return true;
  });
});
