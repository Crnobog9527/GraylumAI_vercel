/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import pg from 'pg';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const db = await localDb(), c = db.client;
const report = { build: db.build, proposalOnly: true, checks: [] };
const limits = { admissionPerMinute: 10, admissionPer24Hours: 200, callsPerMinute: 30, callsPer24Hours: 600 };
const config = { version: 1, userDailyUsd: null, siteDailyUsd: null, siteAlertUsd: null,
  providerBalanceAlertUsd: null, notificationChannel: null };
const call = async (client, sql, args = []) => (await client.query(sql, args)).rows[0]?.v;
const stop = (client, value) => call(client, 'SELECT runtime_set_stop_new_calls($1) v', [value]);
const quota = (client, value = limits) => call(client, 'SELECT runtime_update_rate_limits($1) v', [value]);
const save = (client, value, revision) => call(client, 'SELECT runtime_update_stop_loss($1,$2) v', [value, revision]);
const setting = key => call(c, 'SELECT value v FROM system_settings WHERE key=$1', [key]);
const reset = () => c.query("DELETE FROM system_settings WHERE key IN ('runtime_rate_limits','runtime_stop_loss')");

/** Prove overlap by observing the second backend blocked by the first, not a timing guess. */
async function overlap(first, second) {
  const a = new pg.Client(c.connectionParameters), b = new pg.Client(c.connectionParameters);
  await a.connect(); await b.connect();
  let pending;
  try {
    await a.query("BEGIN; SET LOCAL statement_timeout='10s'; SELECT pg_advisory_xact_lock(201,1)");
    await b.query("SET statement_timeout='10s'");
    const pa = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pb = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    assert.notEqual(pa, pb);
    pending = second(b).then(value => ({ value }), error => ({ error }));
    let blocked = false;
    for (let i = 0; i < 150; i++) {
      const row = (await c.query('SELECT pg_blocking_pids($1) blockers', [pb])).rows[0];
      if (row.blockers.includes(pa)) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'second connection must wait on the first');
    const value = await first(a);
    await a.query('COMMIT');
    return { value, other: await pending };
  } finally {
    await a.query('ROLLBACK');
    await pending;
    await a.end(); await b.end();
  }
}
try {
  const proposal = read('packages/db/tests/runtime-settings-concurrency/proposed-migration.sql');
  // No numbered migration has been allocated yet. Never run this against a shared database.
  await c.query(proposal);
  const definition = await call(c, "SELECT pg_get_functiondef('runtime_update_stop_loss(jsonb,bigint)'::regprocedure) v");
  await c.query(proposal);
  assert.equal(await call(c, "SELECT pg_get_functiondef('runtime_update_stop_loss(jsonb,bigint)'::regprocedure) v"), definition);
  report.checks.push('proposal reapplied twice without definition drift');
  await reset();
  for (const role of ['anon', 'authenticated']) {
    for (const signature of ['runtime_set_stop_new_calls(boolean)', 'runtime_update_rate_limits(jsonb)',
      'runtime_update_stop_loss(jsonb,bigint)', 'runtime_rate_limits_patch(jsonb)']) {
      assert.equal(await call(c, 'SELECT has_function_privilege($1,$2,\'execute\') v', [role, signature]), false);
    }
  }
  assert.equal(await call(c, "SELECT has_function_privilege('service_role','runtime_rate_limits_patch(jsonb)','execute') v"), false);
  await c.query('SET ROLE service_role');
  assert.equal((await stop(c, true)).stopNewCalls, true);
  assert.equal((await quota(c)).stopNewCalls, true);
  assert.equal((await save(c, config, 0)).revision, 1);
  await c.query('RESET ROLE');
  report.checks.push('service role can use dedicated RPCs; public roles cannot; arbitrary patch RPC is private');

  for (const legacyString of [false, true]) {
    for (const stopped of [true, false]) {
      for (const stopFirst of [true, false]) {
        await reset();
        const initial = { version: 1, ...limits, stopNewCalls: !stopped };
        await c.query('INSERT INTO system_settings VALUES($1,$2)', ['runtime_rate_limits',
          JSON.stringify(legacyString ? JSON.stringify(initial) : initial)]);
        const first = stopFirst ? a => stop(a, stopped) : a => quota(a, { ...limits, callsPerMinute: 40 });
        const second = stopFirst ? b => quota(b, { ...limits, callsPerMinute: 40 }) : b => stop(b, stopped);
        const result = await overlap(first, second);
        assert.equal(result.other.error, undefined);
        assert.deepEqual(await setting('runtime_rate_limits'), { ...initial, callsPerMinute: 40, stopNewCalls: stopped });
      }
    }
  }
  report.checks.push('8 real two-connection stop/resume/quota races, both orders, legacy string and object values');
  for (const stopFirst of [true, false]) {
    await reset();
    const result = await overlap(stopFirst ? a => stop(a, true) : a => quota(a, { ...limits, callsPerMinute: 50 }),
      stopFirst ? b => quota(b, { ...limits, callsPerMinute: 50 }) : b => stop(b, true));
    assert.equal(result.other.error, undefined);
    assert.deepEqual(await setting('runtime_rate_limits'), { version: 1, ...limits, callsPerMinute: 50, stopNewCalls: true });
  }
  report.checks.push('first insertion race preserves stop and quotas in both orders');
  for (const stored of [undefined, config, JSON.stringify(config)]) {
    await reset();
    if (stored !== undefined) await c.query('INSERT INTO system_settings VALUES($1,$2)', ['runtime_stop_loss', JSON.stringify(stored)]);
    const race = await overlap(a => save(a, { ...config, siteDailyUsd: '11' }, 0),
      b => save(b, { ...config, siteDailyUsd: '22' }, 0));
    assert.equal(race.value.revision, 1);
    assert.equal(race.other.error?.code, 'PT409');
    assert.equal((await setting('runtime_stop_loss')).siteDailyUsd, '11');
    const second = await save(c, { ...config, siteDailyUsd: '22' }, 1);
    assert.equal(second.revision, 2);
    // A -> B -> A still conflicts with a stale editor's original revision (ABA).
    await save(c, config, 2);
    await assert.rejects(save(c, config, 0), error => error.code === 'PT409');
  }
  report.checks.push('two stop-loss saves: one commits, stale one PT409; absence/string/object, refresh retry and ABA');
  for (const stopFirst of [true, false]) {
    await reset();
    const result = await overlap(stopFirst ? a => stop(a, true) : a => save(a, { ...config, siteDailyUsd: '8' }, 0),
      stopFirst ? b => save(b, { ...config, siteDailyUsd: '8' }, 0) : b => stop(b, true));
    assert.equal(result.other.error, undefined);
    assert.equal((await setting('runtime_rate_limits')).stopNewCalls, true);
    assert.equal((await setting('runtime_stop_loss')).siteDailyUsd, '8');
    await assert.rejects(c.query('SELECT runtime_stop_loss_assert(NULL,false)'), /RUNTIME_NEW_CALLS_STOPPED/);
    await stop(c, false);
    await c.query('SELECT runtime_stop_loss_assert(NULL,false)');
  }
  report.checks.push('stop and dollar cap overlap in both orders; existing runtime gate blocks and resumes');
  const before = await setting('runtime_stop_loss');
  await assert.rejects(save(c, { ...config, siteDailyUsd: '-1' }, 1), /INVALID/);
  assert.deepEqual(await setting('runtime_stop_loss'), before);
  await assert.rejects(save(c, { ...config, revision: 55 }, 1), /INVALID/);
  await assert.rejects(save(c, config, null), /INVALID/);
  await assert.rejects(quota(c, { ...limits, stopNewCalls: false }), /INVALID/);
  await assert.rejects(quota(c, { ...limits, callsPerMinute: 181 }), /INVALID/);
  await assert.rejects(stop(c, null), /INVALID/);
  report.checks.push('invalid config, revision injection, missing version, quota pause injection and bad limits roll back');
  console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
