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
//   node postforme-probe.mjs feed <social_account_id> [max_pages]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://api.postforme.dev/v1';
const ALLOWED = [/^GET \/social-accounts(\/[^/]+)?$/, /^POST \/social-accounts\/auth-url$/,
  /^GET \/social-account-feeds\/[^/]+$/];

function loadKey() {
  const file = join(homedir(), '.graylum', 'secrets', 'postforme.env');
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('POSTFORME_API_KEY='));
  const key = line?.slice('POSTFORME_API_KEY='.length).trim();
  if (!key) throw new Error(`POSTFORME_API_KEY missing in ${file}`);
  return key;
}

async function call(method, path, body) {
  if (!ALLOWED.some((re) => re.test(`${method} ${path.split('?')[0]}`))) {
    throw new Error(`refused: ${method} ${path} is not on the read-only allow list`);
  }
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${loadKey()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  const headers = {};
  for (const h of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    if (res.headers.get(h)) headers[h] = res.headers.get(h);
  }
  return { status: res.status, ms: Date.now() - started, headers, json, errorText: json ? null : text.slice(0, 200) };
}

function shapeOf(post) {
  const metrics = post.metrics && typeof post.metrics === 'object' ? post.metrics : null;
  return {
    posted_at: post.posted_at ?? null,
    has_caption: Boolean(post.caption),
    media_count: Array.isArray(post.media) ? post.media.length : 0,
    metric_fields: metrics ? Object.keys(metrics).sort() : [],
    metric_nulls: metrics ? Object.keys(metrics).filter((k) => metrics[k] === null).sort() : [],
  };
}

async function accounts() {
  const r = await call('GET', '/social-accounts');
  const rows = (r.json?.data ?? []).map((a) => ({ id: a.id, platform: a.platform, status: a.status }));
  return { status: r.status, ms: r.ms, headers: r.headers, accounts: rows, error: r.errorText };
}

async function authUrl(platform, externalId) {
  const r = await call('POST', '/social-accounts/auth-url', {
    platform, external_id: externalId ?? 'graylum-probe', permissions: ['posts', 'feeds'],
  });
  // The URL is a consent link for the Owner's own test account; print host only.
  const url = r.json?.url ? new URL(r.json.url).host : null;
  return { status: r.status, ms: r.ms, consent_host: url, error: r.json?.message ?? r.errorText };
}

async function feed(accountId, maxPages = 3) {
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
  return { accountId, pages };
}

const [cmd, a, b] = process.argv.slice(2);
const run = { accounts: () => accounts(), 'auth-url': () => authUrl(a, b), feed: () => feed(a, b) }[cmd];
if (!run) {
  console.error('usage: accounts | auth-url <platform> [external_id] | feed <social_account_id> [max_pages]');
  process.exit(2);
}
console.log(JSON.stringify({ at: new Date().toISOString(), cmd, result: await run() }, null, 2));
