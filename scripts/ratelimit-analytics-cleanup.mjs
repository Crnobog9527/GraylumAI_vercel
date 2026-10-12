#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DATA-ERASURE E7: removes Upstash ratelimit analytics buckets written while `analytics: true` was on.
// @upstash/core-analytics stores `<limiter prefix>:events:<hour bucket>` sorted sets whose members are
// JSON with the limiter identifier (user ids, IP-derived geo) and sets no expiry. Rate-limit counters
// themselves are untouched: they live under other keys and expire with their window.
//
// Default is a dry run that only counts keys (never prints members). `--delete` unlinks them.
// Credentials come from UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN of the target environment.
import process from 'node:process';

export const ANALYTICS_PATTERN = 'graylum:*:events:*';
const ANALYTICS_KEY = /^graylum:[a-z_:]+:events:\d+$/;

export function isAnalyticsKey(key) {
  return ANALYTICS_KEY.test(key);
}

async function command(url, token, args) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`UPSTASH_${args[0]}_FAILED`);
  return body.result;
}

export async function run({ url, token, remove, call = command }) {
  let cursor = '0';
  const keys = [];
  do {
    const [next, batch] = await call(url, token, ['SCAN', cursor, 'MATCH', ANALYTICS_PATTERN, 'COUNT', '500']);
    cursor = String(next);
    for (const key of batch) if (isAnalyticsKey(key)) keys.push(key);
  } while (cursor !== '0');
  let noExpiry = 0;
  for (const key of keys) if (Number(await call(url, token, ['TTL', key])) === -1) noExpiry++;
  let removed = 0;
  if (remove) {
    for (let i = 0; i < keys.length; i += 100) removed += Number(await call(url, token, ['UNLINK', ...keys.slice(i, i + 100)]));
  }
  return { found: keys.length, noExpiry, removed, dryRun: !remove };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    console.error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
    process.exit(2);
  }
  run({ url, token, remove: process.argv.includes('--delete') })
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error) => { console.error(String(error.message ?? error)); process.exit(1); });
}
