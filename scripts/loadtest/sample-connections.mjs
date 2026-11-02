/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Connection sampler for the Vercel-side 100-user validation: once a second, the client connections of the STAGING database grouped by
// role / application / state, plus how long the oldest "idle in transaction" session has waited. Once at the start: max_connections
// and (when SUPABASE_MANAGEMENT_TOKEN and SUPABASE_PROJECT_REF are in the environment) the pooler and PostgREST pool settings.
//   LOADTEST_DATABASE_URL   connection string of the STAGING database, a role that may read pg_stat_activity of other roles
//                           (pg_read_all_stats); environment only, never printed
//   LOADTEST_ALLOWED_HOST   the exact host of that string; the sampler refuses any other
//   SUPABASE_MANAGEMENT_TOKEN, SUPABASE_PROJECT_REF   optional; only GET requests, only the numbers below are kept, nothing is printed
// Usage: node scripts/loadtest/sample-connections.mjs --out <file outside the repository> --seconds 900 [--every 1]
//        node scripts/loadtest/sample-connections.mjs --summarize <file>      (summary and pass lines of a finished sample file)
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertOutsideRepo } from './reset-accounts.mjs';
import { assertAllowedDatabase } from './sample-waits.mjs';
import { summarizeConnections, judgeConnections } from './lib/connections.mjs';

const flag = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };

export async function sampleConnections(client) {
  const rows = (await client.query(`SELECT usename, application_name, state, backend_type, count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1, 2, 3, 4`)).rows;
  const idle = (await client.query(`SELECT coalesce(max(extract(epoch FROM now() - state_change)), 0)::float AS s FROM pg_stat_activity
    WHERE state LIKE 'idle in transaction%' AND pid <> pg_backend_pid()`)).rows[0];
  return { t: Date.now(), rows, idleInTxMaxSeconds: idle.s };
}

export async function readLimits(client) {
  const row = (await client.query(`SELECT current_setting('max_connections')::int AS max_connections,
    current_setting('superuser_reserved_connections')::int AS reserved`)).rows[0];
  return { maxConnections: row.max_connections, reserved: row.reserved, ...(await readManagedLimits()) };
}

// Best effort and read only; any failure leaves the numbers out, and the report then says "not read".
export async function readManagedLimits(env = process.env, fetchImpl = fetch) {
  const token = env.SUPABASE_MANAGEMENT_TOKEN, ref = env.SUPABASE_PROJECT_REF;
  if (!token || !ref || !/^[a-z0-9]{10,40}$/.test(ref)) return {};
  const get = async path => {
    try {
      const response = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  };
  const [pooler, postgrest] = await Promise.all([get('/config/database/pooler'), get('/postgrest')]);
  const first = Array.isArray(pooler) ? pooler[0] : pooler;
  const num = v => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : undefined);
  return { poolerMode: first?.pool_mode, poolerDefaultPoolSize: num(first?.default_pool_size), poolerMaxClientConn: num(first?.max_client_conn),
    postgrestPool: num(postgrest?.db_pool) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summarizeFile = flag('summarize', null);
  if (summarizeFile) {
    const lines = readFileSync(summarizeFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const limits = lines.find(l => l.limits)?.limits ?? {};
    const summary = summarizeConnections(lines.filter(l => l.rows), limits);
    console.log(JSON.stringify({ summary, checks: judgeConnections(summary) }, null, 1));
  } else {
    const out = flag('out', null);
    if (!out) throw new Error('--out <file outside the repository> is required');
    assertOutsideRepo(out);
    const url = process.env.LOADTEST_DATABASE_URL ?? '';
    assertAllowedDatabase(url, process.env.LOADTEST_ALLOWED_HOST);
    const { Client } = createRequire(join(import.meta.dirname, '../../package.json'))('pg');
    const client = new Client({ connectionString: url, statement_timeout: 3000 });
    await client.connect();
    try {
      appendFileSync(out, JSON.stringify({ t: Date.now(), limits: await readLimits(client) }) + '\n');
      const until = Date.now() + Number(flag('seconds', 900)) * 1000;
      while (Date.now() < until) {
        appendFileSync(out, JSON.stringify(await sampleConnections(client)) + '\n');
        await new Promise(r => setTimeout(r, Number(flag('every', 1)) * 1000));
      }
    } finally { await client.end(); }
  }
}
