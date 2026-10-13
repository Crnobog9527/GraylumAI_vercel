#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PUBLISH-MONITOR Post for Me read-only probe (2026-10-13). NOT RUN yet: an API key needs a paid
// subscription (see README.md in this folder). Run only after the Owner approves a budget and
// places the key in ~/.graylum/secrets/postforme.env as POSTFORME_API_KEY=...
//
// Safety: this script never publishes. It only calls GET endpoints and POST /social-accounts/auth-url
// (which creates a consent link, not a post). The key is never printed; captions and media URLs are
// not written to output, only field names, counts, dates and HTTP metadata.
//
// Usage:
//   node postforme-probe.mjs accounts
//   node postforme-probe.mjs auth-url <platform> [external_id]
//   node postforme-probe.mjs feed <platform>[#n] [max_pages]  (n = position shown by `accounts`, default 1;
//                                                              account IDs are looked up internally, never printed)
//   node postforme-probe.mjs smoke            (list endpoints, error shapes, rate-limit headers)
//   node postforme-probe.mjs burst [n]        (n sequential GET /social-accounts, to observe 429)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://api.postforme.dev/v1';
const ALLOWED = [/^GET \/social-accounts(\/[^/]+)?$/, /^POST \/social-accounts\/auth-url$/,
  /^GET \/social-account-feeds\/[^/]+$/, /^GET \/social-posts$/, /^GET \/social-post-results$/, /^GET \/webhooks$/];

function loadKey() {
  const file = join(homedir(), '.graylum', 'secrets', 'postforme.env');
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('POSTFORME_API_KEY='));
  const key = line?.slice('POSTFORME_API_KEY='.length).trim();
  if (!key) throw new Error(`POSTFORME_API_KEY missing in ${file}`);
  return key;
}

async function call(method, path, body, key = loadKey()) {
  if (!ALLOWED.some((re) => re.test(`${method} ${path.split('?')[0]}`))) {
    throw new Error(`refused: ${method} ${path} is not on the read-only allow list`);
  }
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  const headers = {};
  for (const [h, v] of res.headers) {
    if (/ratelimit|retry-after|x-request-id|content-type/i.test(h)) headers[h] = v;
  }
  return { status: res.status, ms: Date.now() - started, headers, json, errorText: json ? null : text.slice(0, 200) };
}

// Field paths with value kinds only (number / zero / null / string / ...), never the values themselves.
function kinds(value, prefix = '', out = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) kinds(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value === null ? 'null' : value === 0 ? 'zero' : Array.isArray(value) ? `array(${value.length})` : typeof value;
  }
  return out;
}

function shapeOf(post) {
  const metrics = post.metrics && typeof post.metrics === 'object' ? post.metrics : null;
  return {
    posted_at: post.posted_at ?? null,
    post_keys: Object.keys(post).sort(),
    has_caption: Boolean(post.caption),
    has_platform_url: Boolean(post.platform_url),
    media_count: Array.isArray(post.media) ? post.media.length : 0,
    metric_kinds: metrics ? kinds(metrics) : null,
  };
}

async function accounts() {
  const r = await call('GET', '/social-accounts');
  // Account IDs are user-linked identifiers: print platform and status only.
  const seen = {};
  const rows = (r.json?.data ?? []).map((a) => {
    seen[a.platform] = (seen[a.platform] ?? 0) + 1;
    return { select: `${a.platform}#${seen[a.platform]}`, platform: a.platform, status: a.status, name_hint: maskName(a.username) };
  });
  return { status: r.status, ms: r.ms, headers: r.headers, accounts: rows, error: r.errorText };
}

// First and last character only, so the Owner can tell two accounts apart without exposing the handle.
function maskName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  return name.length <= 2 ? '*'.repeat(name.length) : `${name[0]}***${name.at(-1)}`;
}

// The one-time consent URL goes to a private local file (mode 600) outside the repository, never to stdout.
function saveConsentUrl(platform, url) {
  const dir = join(homedir(), '.graylum', 'tmp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `postforme-consent-${platform.replace(/[^a-z0-9_-]/gi, '_')}.txt`);
  writeFileSync(file, `${url}\n`, { mode: 0o600 });
  return file;
}

// platformArg may carry a connection type, e.g. `instagram:facebook` or `instagram:instagram`.
function platformData(platform, type) {
  if (platform === 'linkedin') return { linkedin: { connection_type: type ?? 'organization' } };
  if (platform === 'instagram') {
    if (!type) throw new Error('instagram needs a connection type: instagram:instagram or instagram:facebook');
    return { instagram: { connection_type: type } };
  }
  return undefined;
}

async function authUrl(platformArg, externalId) {
  const [platform, type] = String(platformArg).split(':');
  const data = platformData(platform, type);
  const r = await call('POST', '/social-accounts/auth-url', {
    // Analytics-only scope. Publishing scope is a separate consent and is not requested by this probe.
    platform, external_id: externalId ?? 'graylum-probe', permissions: ['feeds'],
    // Quickstart LinkedIn must use `organization`; Instagram must choose its login flow when both are enabled.
    ...(data ? { platform_data: data } : {}),
  });
  // The URL is a consent link for the Owner's own test account; print host and the private file path only.
  const url = r.json?.url ?? null;
  return {
    status: r.status, ms: r.ms, consent_host: url ? new URL(url).host : null,
    consent_url_file: url ? saveConsentUrl(String(platformArg), url) : null, error: r.json?.message ?? r.errorText,
  };
}

async function feed(selector, maxPages = 3) {
  const [platform, nth = '1'] = String(selector).split('#');
  const list = await call('GET', '/social-accounts');
  const matches = (list.json?.data ?? []).filter((a) => a.platform === platform);
  const accountId = matches[Number(nth) - 1]?.id;
  if (!accountId) return { selector, error: `no connected account ${selector} (found ${matches.length} for ${platform})` };
  const pages = [];
  let cursor = null;
  for (let i = 0; i < Number(maxPages); i += 1) {
    const q = new URLSearchParams({ expand: 'metrics', limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const r = await call('GET', `/social-account-feeds/${encodeURIComponent(accountId)}?${q}`);
    const data = r.json?.data ?? [];
    const dates = data.map((p) => p.posted_at).filter(Boolean).sort();
    pages.push({
      status: r.status, ms: r.ms, headers: r.headers, count: data.length,
      oldest: dates[0] ?? null, newest: dates.at(-1) ?? null,
      has_more: r.json?.meta?.has_more ?? null, sample: data.slice(0, 3).map(shapeOf),
      error: r.json?.message ?? r.errorText,
    });
    cursor = r.json?.meta?.cursor ?? null;
    if (!r.json?.meta?.has_more || !cursor) break;
  }
  return { selector: `${platform}#${nth}`, of: matches.length, pages };
}

function brief(r) {
  const data = r.json?.data;
  return { status: r.status, ms: r.ms, headers: r.headers, count: Array.isArray(data) ? data.length : null,
    meta: r.json?.meta ?? null, body_keys: r.json ? Object.keys(r.json) : null,
    error: r.status >= 400 ? (r.json ?? r.errorText) : null };
}

// Read-only reachability, list endpoints and error shapes. No account is required.
async function smoke() {
  const out = {};
  for (const path of ['/social-accounts', '/social-posts', '/social-post-results', '/webhooks']) {
    out[`GET ${path}`] = brief(await call('GET', path));
  }
  out['bad key'] = brief(await call('GET', '/social-accounts', undefined, 'pfm_live_invalid_probe_key'));
  out['unknown account feed'] = brief(await call('GET', '/social-account-feeds/spc_does_not_exist?expand=metrics'));
  out['invalid limit'] = brief(await call('GET', '/social-account-feeds/spc_does_not_exist?limit=1000'));
  return out;
}

// Sequential burst to observe the per-second / per-minute limits (all requests are GET /social-accounts).
async function burst(n = 12) {
  const rows = [];
  for (let i = 0; i < Number(n); i += 1) {
    const r = await call('GET', '/social-accounts');
    rows.push({ i, status: r.status, ms: r.ms, headers: r.headers, error: r.status >= 400 ? (r.json ?? r.errorText) : null });
  }
  return rows;
}

const [cmd, a, b] = process.argv.slice(2);
const run = {
  accounts: () => accounts(), 'auth-url': () => authUrl(a, b), feed: () => feed(a, b), smoke: () => smoke(), burst: () => burst(a),
}[cmd];
if (!run) {
  console.error('usage: accounts | auth-url <platform>[:type] [external_id] | feed <platform>[#n] [max_pages] | smoke | burst [n]');
  process.exit(2);
}
console.log(JSON.stringify({ at: new Date().toISOString(), cmd, result: await run() }, null, 2));
