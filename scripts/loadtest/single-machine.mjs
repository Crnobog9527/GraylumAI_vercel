/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Single-machine run for the 500 / 2000 / 5000 extrapolation (CORE-PATH-V2 plan 3.3.3). It builds the repository's database in a fresh
// local Docker PostgreSQL (fixed cores and memory), then drives N virtual users through the real turn functions with the model replaced by a
// timer (the stub's timing: first byte 1.5 s, one chunk per 50 ms, 90 chunks). No staging, no network, no model money, no credential.
// It measures what the extrapolation needs: container CPU core-seconds per completed turn (k), wait events and lock counts every second,
// WAL bytes and written rows per turn, pg_stat_statements time per turn, and the table sizes it ran with.
// Usage: node scripts/loadtest/single-machine.mjs --local-only --users 500 --out <dir outside the repository>
//   [--rhythm load|human] [--minutes 3] [--cpus 2] [--memory 1g] [--shared-buffers 256MB] [--pool 16] [--mix chat:5,mentor:3] [--stub-scale 1]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { localDb, root } from '../../packages/db/tests/runtime-view-perf/local-db.mjs';
import { mentorFixtures, mentorActor, mentorTurn } from '../turn-budget/lib/mentor.mjs';
import { assertOutsideRepo } from './reset-accounts.mjs';
import { sampleOnce } from './sample-waits.mjs';
import { thinkMs, percentile, summarizeWaits } from './lib/core.mjs';
import { coreSecondsPerTurn } from './lib/extrapolate.mjs';

const { Pool, Client } = createRequire(join(root, 'package.json'))('pg');
const flag = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
export const options = () => ({
  users: Number(flag('users', 500)), minutes: Number(flag('minutes', 3)), rhythm: flag('rhythm', 'load'), cpus: flag('cpus', '2'),
  memory: flag('memory', '1g'), sharedBuffers: flag('shared-buffers', '256MB'), pool: Number(flag('pool', 16)), stubScale: Number(flag('stub-scale', 1)),
  mix: Object.fromEntries(flag('mix', 'chat:1').split(',').map(p => { const [k, w] = p.split(':'); return [k, Number(w)]; })), out: flag('out', null),
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = text => createHash('sha256').update(text).digest('hex');
// The stub's timing (scripts/loadtest/openrouter-stub.mjs): first byte, then chunks. A model call lasts about 6 s; the human rhythm waits ~3 minutes.
const STUB = { firstByteMs: 1500, intervalMs: 50, chunks: 90 };
const thinkFor = (rhythm, random) => (rhythm === 'human' ? (0.5 + random()) * 194_000 : thinkMs(random));
const policy = { q: 100, uTurnUsd: 0.1, gCredits: 60, minCredits: 10, uModelCredits: 30, historyItems: 100, inputBytes: 1000,
  limits: { model: 3, paidTools: 0, freeTools: 1 }, stopLoss: { limitUsd: 1000, p: 8, poolSize: 8, uFastUsd: 1, uBigUsd: 5 } };

// A free-chat turn: the two fixed calls of every request, open, one model call's three writes, close.
async function chatTurn(call, user, wait) {
  await call('catalog_versions_snapshot', []);
  const { turnId } = await call('turn_open', [user.actor, user.session, randomUUID(), 'chat', JSON.stringify(policy)]);
  await call('turn_call_begin', [user.actor, turnId, 1, 'model', randomUUID(), null, null, hash('r' + turnId), 0.02, 6]);
  await wait();
  await call('turn_call_identity', [user.actor, turnId, 1, 'gen-' + turnId]);
  await call('turn_call_record', [user.actor, turnId, 1, 'ok', 0.001, 0.001, '{}', null, hash('p' + turnId), 'body']);
  await call('turn_close', [user.actor, turnId, 'completed', JSON.stringify([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]),
    true, false, null]);
}

async function seedChatUsers(db, count) {
  // One statement for all accounts: profiles, the opening-grant ledger row and a session each (the rows turn_open reads and locks).
  return (await db.client.query(`WITH ids AS (SELECT gen_random_uuid() actor, gen_random_uuid() session, gen_random_uuid() req FROM generate_series(1, $1)),
    p AS (INSERT INTO profiles(id, credits) SELECT actor, 1000 FROM ids),
    l AS (INSERT INTO credit_transactions(user_id, amount, type, ledger_type, reason_code, source_type, idempotency_key, balance_before, balance_after)
      SELECT actor, 1000, 'addition', 'grant', 'opening_grant', 'system', 'opening_grant:' || actor, 0, 1000 FROM ids)
    INSERT INTO runtime_sessions(id, actor_id, scope, start_request_id, start_payload)
    SELECT session, actor, jsonb_build_object('kind', 'positioning_draft', 'probe', req), req, '{}' FROM ids
    RETURNING actor_id AS actor, id AS session`, [count])).rows;
}

const cgroupCpuSeconds = db => Number(/usage_usec (\d+)/.exec(db.exec(['cat', '/sys/fs/cgroup/cpu.stat']))[1]) / 1e6;

async function sampler(address, stop, samples) {
  const c = new Client({ connectionString: `postgres://postgres@${address}/perf` });
  await c.connect();
  while (!stop.done) { samples.push(await sampleOnce(c)); await sleep(1000); }
  await c.end();
}

export async function run(opts) {
  if (opts.out) assertOutsideRepo(join(opts.out, 'x'));
  const mentor = (opts.mix.mentor ?? 0) > 0;
  const db = await localDb({
    dockerArgs: ['--cpus', opts.cpus, '--memory', opts.memory],
    postgresArgs: ['-c', 'shared_preload_libraries=pg_stat_statements', '-c', `shared_buffers=${opts.sharedBuffers}`, '-c', 'max_connections=200'],
  });
  try {
    await db.client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    if (mentor) await mentorFixtures(db.client);
    const plan = Object.entries(opts.mix).flatMap(([kind, w]) => Array(w).fill(kind));
    const kinds = Array.from({ length: opts.users }, (_, i) => plan[i % plan.length]);
    const users = [];
    const chatCount = kinds.filter(k => k === 'chat').length;
    const chatUsers = chatCount ? await seedChatUsers(db, chatCount) : [];
    let c = 0;
    for (const kind of kinds) users.push(kind === 'chat' ? chatUsers[c++] : await mentorActor(db.client, { accountBound: false }));
    await db.client.query('ANALYZE');
    // The same role PostgREST runs a call as; a pool of the size Supavisor would give (transaction mode: one call, one connection).
    const pool = new Pool({ connectionString: `postgres://postgres@${db.address}/perf`, max: opts.pool, options: '-c role=service_role' });
    let calls = 0;
    const call = async (name, args = []) => {
      calls++;
      const marks = args.map((_, i) => `$${i + 1}`).join(',');
      return (await pool.query(`SELECT ${name}(${marks}) AS v`, args)).rows[0]?.v;
    };
    const wait = ms => () => sleep(ms * opts.stubScale);
    const modelMs = STUB.firstByteMs + STUB.chunks * STUB.intervalMs;
    const records = [];
    const deadline = Date.now() + opts.minutes * 60_000;
    const samples = [], stop = { done: false };
    await db.client.query('SELECT pg_stat_statements_reset()');
    const cpu0 = cgroupCpuSeconds(db);
    const wal0 = (await db.client.query('SELECT pg_current_wal_lsn() l')).rows[0].l;
    const rows0 = (await db.client.query(`SELECT sum(n_tup_ins + n_tup_upd + n_tup_del)::bigint n FROM pg_stat_user_tables`)).rows[0].n;
    const sampling = sampler(db.address, stop, samples);
    const started = Date.now();
    await Promise.all(users.map(async (user, i) => {
      await sleep((i / users.length) * 10_000); // ramp over 10 s
      while (Date.now() < deadline) {
        const t0 = Date.now();
        try {
          if (kinds[i] === 'chat') await chatTurn(call, user, wait(modelMs));
          else await mentorTurn(call, user, { accountBound: false, between: wait(modelMs) });
          records.push({ kind: kinds[i], ok: true, ms: Date.now() - t0 });
        } catch (error) { records.push({ kind: kinds[i], ok: false, ms: Date.now() - t0, code: String(error.code ?? error.message).slice(0, 60) }); }
        // Thinking never runs past the end of the measurement: after the deadline only the turns already started are waited for.
        await sleep(Math.min(thinkFor(opts.rhythm, Math.random) * opts.stubScale, Math.max(0, deadline - Date.now())));
      }
    }));
    const seconds = (Date.now() - started) / 1000;
    stop.done = true;
    await sampling;
    const cpuSeconds = cgroupCpuSeconds(db) - cpu0;
    const walBytes = Number((await db.client.query('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1) b', [wal0])).rows[0].b);
    const rows = Number((await db.client.query(`SELECT sum(n_tup_ins + n_tup_upd + n_tup_del)::bigint n FROM pg_stat_user_tables`)).rows[0].n) - Number(rows0);
    const statementMs = Number((await db.client.query(`SELECT coalesce(sum(total_exec_time), 0) t FROM pg_stat_statements`)).rows[0].t);
    const sizes = (await db.client.query(`SELECT relname, pg_total_relation_size(oid)::bigint bytes FROM pg_class
      WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY 2 DESC LIMIT 8`)).rows;
    await pool.end();
    const done = records.filter(r => r.ok);
    const byKind = {};
    for (const kind of new Set(kinds)) {
      const mine = done.filter(r => r.kind === kind);
      byKind[kind] = { turns: mine.length, p95Ms: percentile(mine.map(r => r.ms), 95) };
    }
    const result = { users: opts.users, rhythm: opts.rhythm, minutes: opts.minutes, seconds: Number(seconds.toFixed(1)), cpus: opts.cpus, memory: opts.memory,
      sharedBuffers: opts.sharedBuffers, pool: opts.pool, stubScale: opts.stubScale, mix: opts.mix, turns: done.length, failed: records.length - done.length,
      failureCodes: records.filter(r => !r.ok).reduce((m, r) => ({ ...m, [r.code]: (m[r.code] ?? 0) + 1 }), {}), calls,
      turnsPerUserMinute: Number((done.length / opts.users / (seconds / 60)).toFixed(2)), cpuSeconds: Number(cpuSeconds.toFixed(1)),
      k: coreSecondsPerTurn({ cpuSeconds, turns: done.length }), statementMsPerTurn: done.length ? Number((statementMs / done.length).toFixed(2)) : null,
      walBytesPerTurn: done.length ? Math.round(walBytes / done.length) : null,
      rowsWrittenPerTurn: done.length ? Number((rows / done.length).toFixed(1)) : null,
      waits: summarizeWaits(samples), byKind, tableSizes: sizes, completedAt: new Date().toISOString() };
    if (opts.out) {
      mkdirSync(opts.out, { recursive: true });
      writeFileSync(join(opts.out, `single-${opts.users}-${opts.rhythm}.json`), JSON.stringify(result, null, 1) + '\n');
    }
    return result;
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await run(options()), null, 1));
}
