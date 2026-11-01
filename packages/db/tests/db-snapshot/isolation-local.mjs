/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The database build snapshot (runtime-view-perf/local-db.mjs, run-local-suites.mjs) must behave like a fresh build:
//   1. the structure and the seed rows of a database started from the snapshot are exactly those of a database built from the files;
//   2. what one suite writes (rows, a role, a database setting, a server setting) never reaches another container started from the
//      same snapshot, whether that one is running at the same time or starts afterwards.
// Usage: node packages/db/tests/db-snapshot/isolation-local.mjs --ci | --local-only
import assert from 'node:assert/strict';
import { buildSnapshot, localDb, snapshotFromEnv } from '../runtime-view-perf/local-db.mjs';

// One hash over every function body, column, index, constraint and trigger outside the system schemas, plus the row count of every table.
const FINGERPRINT = `
  select md5(string_agg(x, E'\\n' order by x)) from (
    select 'f ' || p.oid::regprocedure || ' ' || md5(pg_get_functiondef(p.oid)) as x from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind in ('f', 'p')
    union all select 'c ' || c.oid::regclass || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) from pg_attribute a
      join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and c.relkind in ('r', 'v', 'm') and a.attnum > 0 and not a.attisdropped
    union all select 'i ' || i.indexrelid::regclass || ' ' || pg_get_indexdef(i.indexrelid) from pg_index i
      join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema')
    union all select 'k ' || k.conrelid::regclass || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid) from pg_constraint k
      join pg_namespace n on n.oid = k.connamespace where n.nspname not in ('pg_catalog', 'information_schema')
    union all select 't ' || t.tgrelid::regclass || ' ' || t.tgname from pg_trigger t where not t.tgisinternal
    union all select 'r ' || c.oid::regclass || ' ' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %s', c.oid::regclass), false, true, '')))[1]::text
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and c.relkind = 'r'
  ) parts`;

const own = snapshotFromEnv() ? null : await buildSnapshot();
const snapshot = snapshotFromEnv() ?? own;
const open = [];
const start = async options => { const db = await localDb({ snapshot, ...options }); open.push(db); return db; };
const report = { checks: [], failed: null };
try {
  const first = await start();
  const second = await start(); // started while the first one is still running
  assert.equal(first.fromSnapshot && second.fromSnapshot, true, 'both containers must start from the snapshot');
  assert.deepEqual(first.build, snapshot.build);

  const fresh = await start({ snapshot: null }); // the full replay of the repository files, for comparison
  assert.equal(fresh.fromSnapshot, false);
  const hash = async db => (await db.client.query(FINGERPRINT)).rows[0].md5;
  const [snapshotHash, freshHash] = [await hash(first), await hash(fresh)];
  assert.match(snapshotHash, /^[0-9a-f]{32}$/, 'the catalog hash must exist');
  assert.equal(snapshotHash, freshHash, 'structure and seed rows of the snapshot differ from a fresh build');
  assert.equal(first.build.passed, fresh.build.passed);
  report.checks.push(`snapshot and fresh build agree on ${first.build.passed} applied files and on the catalog hash`);

  const writes = ["create table isolation_probe(v int)", "insert into isolation_probe values (1)", "create role isolation_probe_role",
    "alter database perf set statement_timeout = '13s'", "alter system set work_mem = '7MB'", "select pg_reload_conf()"];
  for (const statement of writes) await first.client.query(statement);
  const probe = async db => ({
    table: (await db.client.query("select to_regclass('public.isolation_probe') as t")).rows[0].t,
    role: (await db.client.query("select count(*)::int as n from pg_roles where rolname = 'isolation_probe_role'")).rows[0].n,
    timeout: (await db.client.query('show statement_timeout')).rows[0].statement_timeout,
    workMem: (await db.client.query('show work_mem')).rows[0].work_mem,
  });
  const written = await probe(first);
  assert.deepEqual([written.table, written.role], ['isolation_probe', 1]);
  const clean = { table: null, role: 0, timeout: '0', workMem: '4MB' };
  assert.deepEqual(await probe(second), clean, 'a container running at the same time saw the first one\'s writes');
  assert.deepEqual(await probe(fresh), clean);
  await first.close(); open.splice(open.indexOf(first), 1);
  const later = await start();
  assert.deepEqual(await probe(later), clean, 'a container started after the first one ended saw its writes');
  report.checks.push('rows, a role, a database setting and a server setting written in one container reach no other, running or started later');
} catch (error) {
  report.failed = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  for (const db of open) await db.close().catch(() => {});
  await own?.remove();
  console.log(JSON.stringify(report, null, 2));
}
