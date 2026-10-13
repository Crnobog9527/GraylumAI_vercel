/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Signs a listed, existing staging test account in through official Supabase Auth admin endpoints
// (generate_link + verify, no password, no hCaptcha) and turns the session into a Playwright
// storageState in the cookie format @supabase/ssr reads on auth-staging.graylum.com.
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  assertListedExistingUser, RefusalError, STAGING_APP_ORIGIN, STAGING_PROJECT_REF, STAGING_SUPABASE_URL,
} from './guards.mjs';

export const AUTH_COOKIE_NAME = `sb-${STAGING_PROJECT_REF}-auth-token`;
const MAX_CHUNK_SIZE = 3180; // @supabase/ssr chunker
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // @supabase/ssr DEFAULT_COOKIE_OPTIONS.maxAge
const MAX_USER_PAGES = 10;

function adminHeaders(key) {
  const headers = { apikey: key, 'content-type': 'application/json' };
  if (!key.startsWith('sb_secret_')) headers.authorization = `Bearer ${key}`;
  return headers;
}

async function authRequest(fetchImpl, key, path, init = {}) {
  const response = await fetchImpl(`${STAGING_SUPABASE_URL}/auth/v1${path}`, {
    ...init, headers: adminHeaders(key), redirect: 'error',
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    // Only the status and GoTrue's error code are surfaced; bodies may echo request fields.
    const code = typeof body?.error_code === 'string' ? body.error_code : 'unknown';
    throw new RefusalError(`测试站登录接口返回 ${response.status}（${code}）。`);
  }
  return body;
}

export async function findUserByEmail(fetchImpl, key, email) {
  for (let page = 1; page <= MAX_USER_PAGES; page += 1) {
    const query = new URLSearchParams({ page: String(page), per_page: '200', filter: email });
    const body = await authRequest(fetchImpl, key, `/admin/users?${query}`, { method: 'GET' });
    const users = Array.isArray(body?.users) ? body.users : [];
    const match = users.find(user => typeof user?.email === 'string' && user.email.toLowerCase() === email);
    if (match) return match;
    if (users.length < 200) return null;
  }
  return null;
}

export async function createSession({ fetchImpl = fetch, key, email }) {
  // Refuse before generate_link: for an unknown address GoTrue would turn a magic link into a signup.
  const user = assertListedExistingUser(await findUserByEmail(fetchImpl, key, email), email);
  const link = await authRequest(fetchImpl, key, '/admin/generate_link', {
    method: 'POST', body: JSON.stringify({ type: 'magiclink', email: user.email }),
  });
  const tokenHash = link?.hashed_token ?? link?.properties?.hashed_token;
  if (typeof tokenHash !== 'string' || !tokenHash) {
    throw new RefusalError('测试站没有返回一次性登录凭据。');
  }
  const session = await authRequest(fetchImpl, key, '/verify', {
    method: 'POST', body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  if (!session?.access_token || !session?.refresh_token || session?.user?.id !== user.id) {
    throw new RefusalError('测试站返回的会话不完整或不属于名单账号。');
  }
  const expiresAt = Number(session.expires_at) || Math.floor(Date.now() / 1000) + Number(session.expires_in || 0);
  return {
    access_token: session.access_token,
    token_type: session.token_type ?? 'bearer',
    expires_in: session.expires_in,
    expires_at: expiresAt,
    refresh_token: session.refresh_token,
    user: session.user,
  };
}

export function sessionCookieChunks(session) {
  const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
  if (value.length <= MAX_CHUNK_SIZE) return [{ name: AUTH_COOKIE_NAME, value }];
  const chunks = [];
  for (let offset = 0, index = 0; offset < value.length; offset += MAX_CHUNK_SIZE, index += 1) {
    chunks.push({ name: `${AUTH_COOKIE_NAME}.${index}`, value: value.slice(offset, offset + MAX_CHUNK_SIZE) });
  }
  return chunks;
}

export function buildStorageState(session, nowSeconds = Math.floor(Date.now() / 1000)) {
  const host = new URL(STAGING_APP_ORIGIN).hostname;
  return {
    cookies: sessionCookieChunks(session).map(({ name, value }) => ({
      name, value, domain: host, path: '/', expires: nowSeconds + COOKIE_MAX_AGE_SECONDS,
      httpOnly: false, secure: true, sameSite: 'Lax',
    })),
    origins: [],
  };
}

export async function writeStorageState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
