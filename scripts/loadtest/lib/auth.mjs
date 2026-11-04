/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Fresh sign-ins for the load-test accounts before each stage (CORE-PATH-V2 V2-13). A whole --series run takes over an hour and a
// Supabase access token lives one hour, so tokens taken before the run would fail the last stages with 401. Before each stage every
// account's session is refreshed with its own refresh token (Supabase's token-refresh limit is far looser than password sign-in);
// only an account whose refresh token no longer works signs in again with its password, when a credentials file is given. A refresh
// token is used once: the rotated one is written back to the accounts file (mode 0600) right away, so a crash never leaves a used one.
// Nothing here prints or logs a token, cookie, password or email: only counts and fixed codes.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** @supabase/ssr's own cookie format: "base64-" + base64url(JSON session), split into name.0, name.1, ... above 3180 characters. */
export const COOKIE_CHUNK = 3180;
export const cookieName = authUrl => `sb-${new URL(authUrl).hostname.split('.')[0]}-auth-token`;

export function sessionCookie(name, session) {
  const value = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url');
  if (value.length <= COOKIE_CHUNK) return `${name}=${value}`;
  const parts = [];
  for (let i = 0; i * COOKIE_CHUNK < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * COOKIE_CHUNK, (i + 1) * COOKIE_CHUNK)}`);
  return parts.join('; ');
}

/** The session a cookie header carries (whole or chunked), or null. */
export function sessionFromCookie(header, name) {
  if (typeof header !== 'string' || !header) return null;
  const pairs = new Map(header.split(/;\s*/).map(pair => { const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));
  let value = pairs.get(name);
  if (value === undefined) {
    const chunks = [];
    for (let i = 0; pairs.has(`${name}.${i}`); i++) chunks.push(pairs.get(`${name}.${i}`));
    value = chunks.length ? chunks.join('') : undefined;
  }
  if (!value) return null;
  try {
    const json = value.startsWith('base64-') ? Buffer.from(value.slice(7), 'base64url').toString('utf8') : decodeURIComponent(value);
    const session = JSON.parse(json);
    return typeof session?.refresh_token === 'string' ? session : null;
  } catch { return null; }
}

/** The user id (JWT `sub`) of an access token, read without verifying it (only to match a credentials entry). */
export function tokenSubject(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).sub ?? null; } catch { return null; }
}

export function assertAuthHost(authUrl, allowedHost) {
  const parsed = new URL(authUrl);
  if (!allowedHost || parsed.hostname !== allowedHost) throw new Error('refusing: LOADTEST_AUTH_URL host is not LOADTEST_ALLOWED_AUTH_HOST');
  if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('refusing: https only');
  return parsed.origin;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One token request with backoff on 429 (rate limit) and 5xx; a 400/401 (a used or revoked refresh token) is not retried. */
async function tokenRequest(fetcher, origin, anonKey, grant, body, { attempts = 5, wait = sleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetcher(`${origin}/auth/v1/token?grant_type=${grant}`, { method: 'POST',
      headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (response.ok) {
      const session = await response.json();
      if (typeof session?.access_token === 'string' && typeof session?.refresh_token === 'string') return { session };
      return { code: 'AUTH_SESSION_INVALID' };
    }
    if ((response.status === 429 || response.status >= 500) && attempt < attempts) { await wait(2000 * attempt); continue; }
    return { code: `AUTH_HTTP_${response.status}` };
  }
}

/**
 * Refreshes every account in place (token, refreshToken, cookie) and writes the file after each success. Returns counts and the fixed
 * codes of the failures; the caller refuses to run a stage while any account failed (a stale token would read as a load failure).
 */
export async function refreshAccounts({ accounts, file, authUrl, anonKey, credentials = [], fetcher = fetch, concurrency = 5,
  wait = sleep, write = defaultWrite }) {
  const name = cookieName(authUrl), origin = new URL(authUrl).origin;
  const byId = new Map(credentials.map(entry => [entry.id, entry]));
  const result = { refreshed: 0, signedIn: 0, failed: 0, codes: {} };
  const fail = code => { result.failed++; result.codes[code] = (result.codes[code] ?? 0) + 1; };
  let next = 0;
  const save = () => write(file, accounts);
  async function one(account) {
    const refreshToken = account.refreshToken ?? sessionFromCookie(account.cookie, name)?.refresh_token;
    let outcome = refreshToken ? await tokenRequest(fetcher, origin, anonKey, 'refresh_token', { refresh_token: refreshToken }, { wait })
      : { code: 'AUTH_NO_REFRESH_TOKEN' };
    let how = 'refreshed';
    if (!outcome.session) {
      const entry = byId.get(tokenSubject(account.token)) ?? (account.userId ? byId.get(account.userId) : undefined);
      if (!entry) return fail(outcome.code);
      outcome = await tokenRequest(fetcher, origin, anonKey, 'password', { email: entry.email, password: entry.password }, { wait });
      how = 'signedIn';
      if (!outcome.session) return fail(outcome.code);
    }
    const { session } = outcome;
    account.token = session.access_token;
    account.refreshToken = session.refresh_token;
    account.userId = session.user?.id ?? tokenSubject(session.access_token);
    account.cookie = sessionCookie(name, session);
    result[how]++;
    // The used refresh token is dead from here on: the rotated one reaches the disk before the next account is touched.
    save();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, async () => {
    while (next < accounts.length) await one(accounts[next++]);
  }));
  return result;
}

function defaultWrite(file, accounts) {
  const current = JSON.parse(readFileSync(file, 'utf8'));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...current, accounts }, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
}
