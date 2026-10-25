/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only PUBLISH-MONITOR (0399, provisional) verification: a function that locks the profile (through
// publish_monitor_actor) must not be STABLE, because PostgREST runs STABLE functions in a READ ONLY transaction.
// Run: node packages/db/tests/publish-monitor/connect-pending-volatile-local.mjs --local-only
import assert from 'node:assert/strict';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0399_publish_monitor_connect_pending_volatile.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0399', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;

try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  report.checks.push('0399 reapplication preserves the complete catalog');

  // The actor helper takes a row lock, so nothing that calls it may be STABLE or IMMUTABLE (read-only transaction).
  assert.match(await v("SELECT pg_get_functiondef('publish_monitor_actor(uuid)'::regprocedure) v"), /FOR UPDATE/);
  const wrong = (await c.query(`SELECT p.oid::regprocedure::text fn FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'publish_monitor_%' AND p.proname<>'publish_monitor_actor' AND p.provolatile<>'v'
    AND pg_get_functiondef(p.oid) LIKE '%publish_monitor_actor(%' ORDER BY 1`)).rows.map(row => row.fn);
  assert.deepEqual(wrong, [], 'these call publish_monitor_actor but are not VOLATILE');
  assert.equal(await v("SELECT provolatile v FROM pg_proc WHERE proname='publish_monitor_connect_pending'"), 'v');
  report.checks.push('every publish_monitor function that calls publish_monitor_actor is VOLATILE, connect_pending included');

  // Still callable by the server role only, and still returns an expired/unknown attempt as the same refusal.
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await v('SELECT has_function_privilege($1,\'publish_monitor_connect_pending(uuid,uuid)\',\'EXECUTE\') v', [role]), false, role);
  }
  assert.equal(await v('SELECT has_function_privilege(\'service_role\',\'publish_monitor_connect_pending(uuid,uuid)\',\'EXECUTE\') v'), true);
  report.checks.push('grants unchanged: only the server role may call it');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
