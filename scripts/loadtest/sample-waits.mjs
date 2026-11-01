/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Wait-event and lock sampler for the 100-user staging run (CORE-PATH-V2 plan 3.2 item 5): every 5 seconds, the wait events of the active
// backends and the lock counts by type, written as JSON lines. Read only: two SELECTs on pg_stat_activity and pg_locks.
//   LOADTEST_DATABASE_URL     connection string of the STAGING database for a read-only role, read from the environment only, never printed
//   LOADTEST_ALLOWED_HOST     the exact host of that string; the sampler refuses any other
// Usage: node scripts/loadtest/sample-waits.mjs --out <file outside the repository> --seconds 900 [--every 5]
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertOutsideRepo } from './reset-accounts.mjs';

const flag = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };

export function assertAllowedDatabase(url, allowedHost) {
  // A postgres URL is parsed with the URL class; the host (and only the host) must be the one named.
  const host = new URL(url).hostname;
  if (!allowedHost || host !== allowedHost) throw new Error('refusing: LOADTEST_DATABASE_URL host is not LOADTEST_ALLOWED_HOST');
  return host;
}

export async function sampleOnce(client) {
  const waits = {};
  for (const r of (await client.query(`SELECT coalesce(wait_event_type || ':' || wait_event, 'CPU') AS w, count(*)::int n FROM pg_stat_activity
    WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid() GROUP BY 1`)).rows) waits[r.w] = r.n;
  const locks = {};
  const held = await client.query(`SELECT locktype || CASE WHEN granted THEN '' ELSE ':waiting' END AS t, count(*)::int n FROM pg_locks GROUP BY 1`);
  for (const r of held.rows) locks[r.t] = r.n;
  return { t: Date.now(), waits, locks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = flag('out', null);
  if (!out) throw new Error('--out <file outside the repository> is required');
  assertOutsideRepo(out);
  const url = process.env.LOADTEST_DATABASE_URL ?? '';
  assertAllowedDatabase(url, process.env.LOADTEST_ALLOWED_HOST);
  const { Client } = createRequire(join(import.meta.dirname, '../../package.json'))('pg');
  const client = new Client({ connectionString: url, statement_timeout: 3000 });
  await client.connect();
  try {
    const until = Date.now() + Number(flag('seconds', 900)) * 1000;
    while (Date.now() < until) {
      appendFileSync(out, JSON.stringify(await sampleOnce(client)) + '\n');
      await new Promise(r => setTimeout(r, Number(flag('every', 5)) * 1000));
    }
  } finally { await client.end(); }
}
