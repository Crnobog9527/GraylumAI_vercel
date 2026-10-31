/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Turn budget guard (CORE-PATH-V2 plan 3.1, 7.1): runs the standard turns' database calls on a local Docker database built from the
// repository files and measures, per turn, what the plan budgets:
//   roundTrips      database round trips made by the turn (every counted call is one; setup and measurement queries are not),
//   dbTimeMs        time the database spent inside the turn's functions (pg_stat_user_functions, track_functions=all),
//   relationLocks   the most relations (tables and their indexes) one call holds at once, read from pg_locks before it commits,
//   hotSeqScans     sequential scans on the hot tables in a run with enable_seqscan=off (a scan then means no usable index at all).
// A scenario is a module under scripts/turn-budget/ that exports { name, path, tables, run({ call, setup }) }. The old path's
// scenarios are REPORTED against scripts/turn-budget-baseline.json (entries carry "enforce": false and never turn CI red); a
// scenario with "enforce": true must not exceed its baseline -- the baseline is a ratchet that only gets smaller, and raising it
// needs the Owner's approval. New-path scenarios (turn_open / turn_call_* / turn_close) are picked up from the same directory
// once V2-3 adds them; until then there is none and the check says so.
// Usage: node scripts/check-turn-budget.mjs --ci | --local-only [--update-baseline] [--only <name>] [--json]
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE = join(ROOT, 'scripts/turn-budget-baseline.json');
const WARMUP_RUNS = 7; // more than the five custom plans plpgsql builds before it settles on a cached one
const TIME_TOLERANCE = 1.5; // a timing ratchet needs room: wall noise on a shared machine is real; counts have none.

// Relation locks by whose they are (plan 7.1): the main path's own tables, the ledger leaves' tables (grants, packs, orders, billing),
// and everything else a kind needs (mentor: modules, skills, research_*, artifact_*, opc_*, library ...). Each class has its own ratchet.
const MAIN = new Set(['turns', 'turn_calls', 'turn_call_raw', 'runtime_sessions', 'profiles', 'daily_spend', 'session_messages',
  'catalog_versions', 'account_erasure_requests']);
const LEDGER = /^(credit_|billing_history$|payment_orders$|user_subscriptions$|subscription_|bill2_runs$)/;
export function lockClass(owner) {
  const name = owner.replace(/^public\./, '').replace(/_id_seq$/, '');
  return MAIN.has(name) ? 'main' : LEDGER.test(name) ? 'ledger' : 'mentor';
}

export function compare(measured, entry) {
  const problems = [];
  for (const key of ['roundTrips', 'relationLocks',
    'hotSeqScans']) if (measured[key] > entry[key]) problems.push(`${key} ${measured[key]} > baseline ${entry[key]}`);
  for (const [name, n] of Object.entries(measured.lockClasses ?? {})) {
    const allowed = entry.lockClasses?.[name];
    if (allowed !== undefined && n > allowed) problems.push(`${name} locks ${n} > baseline ${allowed}`);
  }
  if (measured.dbTimeMs > entry.dbTimeMs * TIME_TOLERANCE) {
    problems.push(`dbTimeMs ${measured.dbTimeMs} > baseline ${entry.dbTimeMs} x ${TIME_TOLERANCE}`);
  }
  return problems;
}

// Measures one scenario on an open database client. `harness` supplies the counted call wrapper.
export async function measure(scenario, client, { noSeqScan = false } = {}) {
  let roundTrips = 0, relationLocks = 0;
  const lockClasses = {};
  const functions = async () => Object.fromEntries(
    (await client.query('SELECT funcname, total_time FROM pg_stat_user_functions')).rows.map(r => [r.funcname, Number(r.total_time)]));
  const scans = async () => Object.fromEntries((await client.query('SELECT relname, seq_scan FROM pg_stat_user_tables WHERE relname = ANY($1)',
    [scenario.tables])).rows.map(r => [r.relname, Number(r.seq_scan)]));
  const counted = new Set();
  const call = async (name, args = []) => {
    counted.add(name);
    roundTrips++;
    await client.query('BEGIN');
    try {
      const marks = args.map((_, i) => `$${i + 1}`).join(',');
      const result = (await client.query(`SELECT ${name}(${marks}) AS v`, args)).rows[0]?.v;
      const held = (await client.query(`SELECT DISTINCT l.relation, coalesce(i.indrelid::regclass::text, k.relname) AS owner
        FROM pg_locks l JOIN pg_class k ON k.oid = l.relation LEFT JOIN pg_index i ON i.indexrelid = k.oid
        WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND k.relnamespace = 'public'::regnamespace`)).rows;
      relationLocks = Math.max(relationLocks, held.length);
      const byClass = {};
      for (const row of held) byClass[lockClass(row.owner)] = (byClass[lockClass(row.owner)] ?? 0) + 1;
      for (const [name, n] of Object.entries(byClass)) lockClasses[name] = Math.max(lockClasses[name] ?? 0, n);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  };
  const state = await scenario.setup({ client });
  await client.query('ANALYZE');
  if (noSeqScan) await client.query('SET enable_seqscan = off');
  await client.query('SELECT pg_stat_force_next_flush()');
  const beforeFunctions = await functions(), beforeScans = await scans();
  await scenario.run({ call, state, client });
  await client.query('SELECT pg_stat_force_next_flush()');
  const afterFunctions = await functions(), afterScans = await scans();
  await client.query('RESET enable_seqscan');
  let dbTimeMs = 0;
  const byFunction = {};
  for (const name of counted) {
    byFunction[name] = Number(((afterFunctions[name] ?? 0) - (beforeFunctions[name] ?? 0)).toFixed(1));
    dbTimeMs += byFunction[name];
  }
  const hotSeqScans = scenario.tables.reduce((sum, table) => sum + ((afterScans[table] ?? 0) - (beforeScans[table] ?? 0)), 0);
  return { roundTrips, dbTimeMs: Number(dbTimeMs.toFixed(1)), relationLocks, lockClasses, hotSeqScans, byFunction };
}

export async function loadScenarios(dir = join(ROOT, 'scripts/turn-budget')) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()) out.push((await import(pathToFileURL(join(dir, file)).href)).default);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
  const scenarios = (await loadScenarios()).filter(s => !only || s.name === only);
  if (!scenarios.length) { console.log('check-turn-budget: no scenario to run'); process.exit(0); }
  const { localDb } = await import('../packages/db/tests/runtime-view-perf/local-db.mjs');
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  const db = await localDb();
  const results = {};
  const failures = [];
  try {
    for (const scenario of scenarios) {
      const started = Date.now();
      // Warm-up runs first: a plpgsql statement is planned afresh (locking every index of its tables) for its first five executions on a
      // connection and reuses a cached plan after (locking the indexes it uses), so the lock counts read 136, 139, 124 on three runs in a
      // row. Then best of three on time (the counts are identical once warm); the scenario sets up its own data each run.
      for (let i = 0; i < WARMUP_RUNS; i++) await measure(scenario, db.client);
      let best = null;
      for (let i = 0; i < 3; i++) {
        const m = await measure(scenario, db.client);
        if (!best || m.dbTimeMs < best.dbTimeMs) best = m;
      }
      // One more run with sequential scans switched off: a scan that still happens has no index to use at all.
      best.hotSeqScans = (await measure(scenario, db.client, { noSeqScan: true })).hotSeqScans;
      const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      results[scenario.name] = { path: scenario.path, ...best, seconds };
      const entry = baseline[scenario.name];
      const line = `${scenario.name} (${scenario.path}): ${best.roundTrips} round trips, ${best.dbTimeMs} ms in the database, `
        + `${best.relationLocks} relations locked at most (${Object.entries(best.lockClasses).map(([c, n]) => `${c} ${n}`).join(', ')}), `
        + `${best.hotSeqScans} hot sequential scans`;
      if (!entry) console.log(`${line} -- no baseline yet`);
      else if (!entry.enforce) {
        console.log(`${line} -- report only (baseline ${entry.roundTrips}/${entry.dbTimeMs}/${entry.relationLocks}/${entry.hotSeqScans})`);
      }
      else {
        const problems = compare(best, entry);
        console.log(`${line} -- ${problems.length ? 'OVER BUDGET' : 'within baseline'}`);
        failures.push(...problems.map(p => `${scenario.name}: ${p}`));
      }
    }
  } finally { await db.close(); }
  if (args.includes('--update-baseline')) {
    const next = { ...baseline };
    for (const [name, m] of Object.entries(results)) {
      const old = baseline[name];
      // A baseline only moves down; a first value, or a report-only entry, may be set freely.
      const lower = !old || !old.enforce ? m : Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number'
        && typeof old[k] === 'number' ? Math.min(v, old[k]) : k === 'lockClasses' && old[k] ? Object.fromEntries(Object.entries(v).map(([c, n]) => [c,
          Math.min(n, old[k][c] ?? n)])) : v]));
      next[name] = { ...lower, enforce: old?.enforce ?? false, path: m.path };
      delete next[name].seconds; delete next[name].byFunction;
    }
    writeFileSync(BASELINE, JSON.stringify(next, null, 1) + '\n');
  }
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 1));
  if (failures.length) { for (const f of failures) console.error(`BUDGET ${f}`); process.exit(1); }
}
