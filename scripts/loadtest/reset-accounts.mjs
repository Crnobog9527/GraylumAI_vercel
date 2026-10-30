/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Registers a fresh batch of load-test accounts on a STAGING project so every batch of the
// 100-user acceptance (CORE-PATH-V2 plan 3.2) starts from new profiles and short histories. It holds no address, key, email or id:
//   SUPABASE_URL                 the staging project URL (must contain the host named in LOADTEST_ALLOWED_HOST)
//   SUPABASE_SERVICE_ROLE_KEY    read from the environment only, never printed
//   LOADTEST_ALLOWED_HOST        the exact staging host; the script refuses any other
//   LOADTEST_EMAIL_TEMPLATE      e.g. "name{n}@example.test" -- {n} is replaced by the account number
// Usage: node scripts/loadtest/reset-accounts.mjs --from 1 --count 100 [--out <file>] [--ban-previous <file>]
// The profile and the opening test credits are created by the app on each account's first authenticated request (the load driver
// makes it). The credentials of the created accounts are written only to --out (mode 0600), which must live outside the repository.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep, basename } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function emailFor(template, n) {
  if (!/\{n\}/.test(template ?? '')) throw new Error('LOADTEST_EMAIL_TEMPLATE needs {n}');
  return template.replace('{n}', String(n).padStart(3, '0'));
}

export function assertStaging(url, allowedHost) {
  const host = new URL(url).hostname;
  if (!allowedHost || host !== allowedHost) throw new Error('refusing: SUPABASE_URL host is not LOADTEST_ALLOWED_HOST');
  return host;
}

// The repository root comes from this script's own location, never from the working directory; symlinks in the target's folder are
// resolved, and "outside" means a whole parent path segment (".." or "../x"), not a name that merely starts with two dots.
const REPO = resolve(import.meta.dirname, '../..');
export function assertOutsideRepo(file, repo = REPO) {
  // The file itself must not be a symlink (a link outside the repository can still point into it); a missing file is fine.
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('--out must not be a symbolic link'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const folder = resolve(dirname(file));
  let real = folder;
  try { real = realpathSync(folder); } catch { /* a folder that does not exist yet is judged by its written path */ }
  const rel = relative(realpathSync(repo), join(real, basename(file)));
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) throw new Error('--out must be outside the repository');
}

export async function resetAccounts({ env = process.env, fetchImpl = fetch, from, count, out, banPrevious, log = console.log }) {
  const base = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  // The credentials file is checked before any account exists, and is created exclusively (never through a link, never over a file).
  if (out) { assertOutsideRepo(out); if (existsSync(out)) throw new Error('--out already exists; remove it first'); }
  if (!base || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  assertStaging(base, env.LOADTEST_ALLOWED_HOST);
  const headers = { apikey: key, 'content-type': 'application/json', ...(key.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${key}` }) };
  const admin = (path, init = {}) => fetchImpl(`${base}/auth/v1/admin/${path}`, { headers, ...init });
  const tally = { banned: 0, created: 0, failed: 0 };
  if (banPrevious && existsSync(banPrevious)) {
    for (const account of JSON.parse(readFileSync(banPrevious, 'utf8')).accounts ?? []) {
      const r = await admin(`users/${account.id}`, { method: 'PUT', body: JSON.stringify({ ban_duration: '87600h' }) });
      if (r.ok) tally.banned++;
    }
  }
  const accounts = [];
  for (let n = from; n < from + count; n++) {
    const email = emailFor(env.LOADTEST_EMAIL_TEMPLATE, n);
    const password = randomBytes(18).toString('base64url');
    const r = await admin('users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { loadtest: true } }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { tally.failed++; log(`account ${n}: ${r.status} ${body.error_code ?? ''}`); continue; }
    accounts.push({ email, id: body.id, password });
    tally.created++;
  }
  if (out) writeFileSync(out, JSON.stringify({ accounts }, null, 1), { flag: 'wx', mode: 0o600 });
  return { tally, accounts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
  const out = arg('out');
  if (out) assertOutsideRepo(out);
  const { tally } = await resetAccounts({ from: Number(arg('from', 1)), count: Number(arg('count', 100)), out, banPrevious: arg('ban-previous') });
  console.log(JSON.stringify(tally));
}
