/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// V2-13: a --series run outlasts the one-hour tokens, so the driver refreshes every account before each stage (scripts/loadtest/lib/auth.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { COOKIE_CHUNK, cookieName, refreshAccounts, sessionCookie, sessionFromCookie, tokenSubject } from '../loadtest/lib/auth.mjs';

const AUTH = 'https://abcdefghijklmnop.supabase.co';
const jwt = sub => ['e30', Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'sig'].join('.');
const session = (sub, refresh, extra = {}) => ({ access_token: jwt(sub), refresh_token: refresh, token_type: 'bearer', expires_in: 3600,
  user: { id: sub }, ...extra });

test('the session cookie is @supabase/ssr format, whole or in chunks, and reads back', () => {
  const name = cookieName(AUTH);
  assert.equal(name, 'sb-abcdefghijklmnop-auth-token');
  const small = sessionCookie(name, session('u1', 'r1'));
  assert.match(small, /^sb-abcdefghijklmnop-auth-token=base64-[A-Za-z0-9_-]+$/);
  assert.equal(sessionFromCookie(small, name).refresh_token, 'r1');
  const big = sessionCookie(name, session('u2', 'r2', { user: { id: 'u2', padding: 'x'.repeat(5000) } }));
  const parts = big.split('; ');
  assert.ok(parts.length >= 2);
  parts.forEach((part, i) => assert.ok(part.startsWith(`${name}.${i}=`) && part.length - `${name}.${i}=`.length <= COOKIE_CHUNK));
  assert.equal(sessionFromCookie(`other=1; ${big}`, name).refresh_token, 'r2');
  assert.equal(sessionFromCookie('other=1', name), null);
  assert.equal(tokenSubject(jwt('who')), 'who');
});

function fakeAuth(script) {
  const posted = [];
  const fetcher = async (url, init) => {
    const grant = new URL(url).searchParams.get('grant_type'), body = JSON.parse(init.body);
    posted.push({ grant, key: body.refresh_token ?? body.email });
    const answer = script(grant, body, posted.length);
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  };
  return { fetcher, posted };
}

test('each account refreshes with its own refresh token once; rotated tokens reach the file after every success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-')), file = join(dir, 'accounts.json'), name = cookieName(AUTH);
  const accounts = [{ kind: 'chat', sessionId: 's1', token: jwt('u1'), cookie: sessionCookie(name, session('u1', 'old1')) },
    { kind: 'coach', sessionId: 's2', moduleId: 'm', token: jwt('u2'), refreshToken: 'old2' }];
  writeFileSync(file, JSON.stringify({ note: 'kept', accounts }));
  let busy = 0;
  const { fetcher, posted } = fakeAuth((grant, body, n) => {
    // One 429 first: retried, not counted as a failure.
    if (n === 1) return { status: 429 };
    busy++;
    return { body: session(body.refresh_token === 'old1' ? 'u1' : 'u2', `new-${body.refresh_token}`) };
  });
  const result = await refreshAccounts({ accounts, file, authUrl: AUTH, anonKey: 'anon', fetcher, concurrency: 1, wait: async () => {} });
  assert.deepEqual(result, { refreshed: 2, signedIn: 0, failed: 0, codes: {} });
  assert.equal(busy, 2);
  assert.deepEqual(posted.map(p => p.key), ['old1', 'old1', 'old2'], 'only the 429 is retried; no refresh token is sent after it worked');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.note, 'kept');
  assert.deepEqual(saved.accounts.map(a => a.refreshToken), ['new-old1', 'new-old2']);
  assert.equal(sessionFromCookie(saved.accounts[0].cookie, name).refresh_token, 'new-old1');
  assert.equal(tokenSubject(saved.accounts[1].token), 'u2');
  assert.deepEqual(saved.accounts.map(a => [a.kind, a.sessionId]), [['chat', 's1'], ['coach', 's2']], 'the sessions and drafts are kept');
});

test('a dead refresh token signs in with the password of the same user; without one the account fails and nothing is guessed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-')), file = join(dir, 'accounts.json');
  const accounts = [{ token: jwt('u1'), refreshToken: 'used' }, { token: jwt('u3'), refreshToken: 'used' }];
  writeFileSync(file, JSON.stringify({ accounts }));
  const { fetcher } = fakeAuth(grant => grant === 'refresh_token' ? { status: 400 } : { body: session('u1', 'fresh') });
  const result = await refreshAccounts({ accounts, file, authUrl: AUTH, anonKey: 'anon', fetcher, wait: async () => {},
    credentials: [{ id: 'u1', email: 'one@example.test', password: 'p' }, { id: 'u2', email: 'two@example.test', password: 'p' }] });
  assert.deepEqual(result, { refreshed: 0, signedIn: 1, failed: 1, codes: { AUTH_HTTP_400: 1 } });
  assert.equal(accounts[0].refreshToken, 'fresh');
  assert.equal(accounts[1].refreshToken, 'used');
});

test('a --series run refuses to start without the auth settings, before anything is sent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-')), file = join(dir, 'accounts.json');
  writeFileSync(file, JSON.stringify({ accounts: Array.from({ length: 100 }, () => ({ token: 't', sessionId: 's' })) }));
  const root = resolve(import.meta.dirname, '../..');
  const run = spawnSync(process.execPath, ['scripts/loadtest/core-path-load.mjs', '--out', join(dir, 'out'), '--series', '--go'], { cwd: root,
    encoding: 'utf8', env: { PATH: process.env.PATH, LOADTEST_BASE_URL: 'https://app.example.test', LOADTEST_ALLOWED_HOST: 'app.example.test',
      LOADTEST_ACCOUNTS_FILE: file } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /outlasts the one-hour tokens/);
});

// Independent review before push: a calibrate or single-stage run must not cut the file down to the accounts it used.
test('only the first `count` accounts refresh, and the file keeps every account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-')), file = join(dir, 'accounts.json');
  const accounts = Array.from({ length: 5 }, (_, i) => ({ kind: 'chat', sessionId: `s${i}`, token: jwt(`u${i}`), refreshToken: `r${i}` }));
  writeFileSync(file, JSON.stringify({ accounts }));
  const { fetcher, posted } = fakeAuth((grant, body) => ({ body: session(body.refresh_token.replace('r', 'u'), `new-${body.refresh_token}`) }));
  const result = await refreshAccounts({ accounts, count: 1, file, authUrl: AUTH, anonKey: 'anon', fetcher, wait: async () => {} });
  assert.equal(result.refreshed, 1);
  assert.deepEqual(posted.map(p => p.key), ['r0']);
  const saved = JSON.parse(readFileSync(file, 'utf8')).accounts;
  assert.equal(saved.length, 5);
  assert.deepEqual(saved.map(a => a.refreshToken), ['new-r0', 'r1', 'r2', 'r3', 'r4']);
});

test('a network error is one failed account, not a crash, and the others still save; a refresh 5xx is never resent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-')), file = join(dir, 'accounts.json');
  const accounts = [{ token: jwt('u0'), refreshToken: 'r0' }, { token: jwt('u1'), refreshToken: 'r1' }, { token: jwt('u2'), refreshToken: 'r2' }];
  writeFileSync(file, JSON.stringify({ accounts }));
  const sent = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.refresh_token);
    if (body.refresh_token === 'r0') throw new Error('ECONNRESET');
    if (body.refresh_token === 'r1') return new Response('{}', { status: 502 });
    return new Response(JSON.stringify(session('u2', 'new-r2')));
  };
  const result = await refreshAccounts({ accounts, file, authUrl: AUTH, anonKey: 'anon', fetcher, wait: async () => {} });
  assert.deepEqual(result, { refreshed: 1, signedIn: 0, failed: 2, codes: { AUTH_NETWORK: 1, AUTH_HTTP_502: 1 } });
  assert.deepEqual(sent.sort(), ['r0', 'r1', 'r2'], 'a refresh token that got a 5xx is sent once only');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).accounts[2].refreshToken, 'new-r2');
});
