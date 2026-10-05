/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { stopViewCase, setup, view, stop, facts } from './cases.mjs';

const database = await localDb(), db = database.client;
const report = { checks: [], failed: null };
const signature = 'public.runtime_view(uuid,uuid)';
const definition = async () => (await db.query('SELECT pg_get_functiondef($1::regprocedure) v', [signature])).rows[0].v;
const digest = text => createHash('md5').update(text).digest('hex');

try {
  await db.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
  for (const version of ['bill2.v1', 'bill2.v2']) {
    await stopViewCase(db, version);
    report.checks.push(version + ': stop/save/cancel; read-only refresh; hidden/foreign/client/erased denied');
  }

  const migration = read('packages/db/migrations/0173_runtime_user_stop_view.sql');
  const rollback = read('packages/db/tests/native-stop-view/rollback.sql');
  const target = await definition();
  const old = migration.match(/\$old\$([\s\S]*?)\$old\$/)[1];
  const replacement = migration.match(/\$new\$([\s\S]*?)\$new\$/)[1];
  assert.ok(target.includes(replacement));
  const source = target.replace(replacement, old);
  assert.equal(digest(source), 'bc60c8e82b1f58419246504dc7fcd0ca');
  const fp = read('packages/db/tests/baseline/fingerprint.sql');
  const catalog = async () => (await db.query(fp.slice(0, fp.indexOf('-- FINAL'))
    + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;')).rows[0].v;
  const afterCatalog = await catalog();
  const f = await setup(db, 'bill2.v1');
  await stop(db, f);
  const data = await facts(db, f), after = await view(db, f);
  await db.query(rollback);
  await db.query(rollback);
  assert.equal(await definition(), source);
  const beforeCatalog = await catalog(), before = await view(db, f);
  assert.deepEqual(Object.keys(afterCatalog).filter(k => afterCatalog[k] !== beforeCatalog[k]),
    ['fn:runtime_view(uuid,uuid)'], 'only runtime_view body changes; billing helpers, ACL and owner unchanged');
  assert.deepEqual({ ...after, executions: after.executions.map(({ userStopPending, ...rest }) => rest) }, before);
  await db.query(migration);
  assert.deepEqual(await view(db, f), after);
  await db.query(migration);
  assert.deepEqual(await catalog(), afterCatalog);
  assert.deepEqual(await facts(db, f), data, 'populated rollback/reapply preserves all durable facts');
  await db.query(source);
  await assert.rejects(db.query(migration.replace(/COMMIT;\s*$/, () =>
    "DO $$ BEGIN RAISE EXCEPTION 'LOCAL_ROLLBACK'; END $$; COMMIT;")), /LOCAL_ROLLBACK/);
  await db.query('ROLLBACK');
  assert.deepEqual(await catalog(), beforeCatalog);
  for (const original of [source, target]) {
    const drift = original.replace('AS $function$', 'AS $function$\n-- synthetic drift');
    await db.query(drift);
    await assert.rejects(db.query(migration), /USER_STOP_VIEW_SOURCE_MISMATCH/);
    await db.query('ROLLBACK');
    assert.equal(await definition(), drift);
    await assert.rejects(db.query(rollback), /USER_STOP_VIEW_ROLLBACK_SOURCE_MISMATCH/);
    await db.query('ROLLBACK');
    assert.equal(await definition(), drift);
  }
  await db.query(source);
  await assert.rejects(db.query(migration.replace("'userStopPending',", "'invalidField',")), /USER_STOP_VIEW_TARGET_MISMATCH/);
  await db.query('ROLLBACK');
  assert.deepEqual(await catalog(), beforeCatalog);
  await db.query(migration);
  report.checks.push('source/target MD5 guards; second apply no-op; source and target drift rejected; '
    + 'failed transaction rolls back; populated reverse/reapply preserves data; exact legacy response equality');
} catch (error) {
  report.failed = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await db.query('ROLLBACK');
  await db.query('RESET ROLE');
  await database.close();
  report.cleanup = 'PASS';
  console.log(JSON.stringify(report, null, 2));
}
