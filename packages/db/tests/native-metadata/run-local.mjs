/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Reuse the existing disposable, Unix-socket-only database harness. No remote URL accepted.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
const db = await localDb();
const c = db.client;
const migration = read('packages/db/migrations/0170_runtime_native_metadata.sql');
const definition = async () => (await c.query("SELECT pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure) v")).rows[0].v;
const fp = read('packages/db/tests/baseline/fingerprint.sql');
const catalogSql = fp.slice(0, fp.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
const catalog = async () => (await c.query(catalogSql)).rows[0].v;
const keys = ['completeness', 'organized', 'summaryOmitted', 'messageFirst', 'envelopeCompact'];
const strip = row => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const metadata = row => Object.fromEntries(Object.entries(row).filter(([key]) => keys.includes(key)));
const view = async (f, actor = f.actor) => (await c.query('SELECT runtime_view($1,$2) v', [actor, f.session])).rows[0].v;
const seed = async (n, material = false) => (await c.query('SELECT runtime_perf_test.seed($1,$2) f', [n, material])).rows[0].f;
const report = { build: db.build, checks: [], samples: [], failed: null };
try {
  const target = await definition();
  const old = migration.match(/\$old\$([\s\S]*?)\$old\$/)[1];
  const replacement = migration.match(/\$new\$([\s\S]*?)\$new\$/)[1];
  assert.ok(target.includes(replacement));
  const source = target.replace(replacement, old);
  assert.equal(createHash('md5').update(source).digest('hex'), 'e7ee4aa5d28b6984a57f4fff78e98782');
  const finalCatalog = await catalog();
  await c.query(source);
  const sourceCatalog = await catalog();
  assert.deepEqual(Object.keys(finalCatalog).filter(k => finalCatalog[k] !== sourceCatalog[k]), ['fn:runtime_view(uuid,uuid)']);
  // Rollback is transactional: an error after CREATE OR REPLACE changes nothing.
  await assert.rejects(c.query(migration.replace(/COMMIT;\s*$/, () => "DO $$ BEGIN RAISE EXCEPTION 'LOCAL_ROLLBACK'; END $$; COMMIT;")), /LOCAL_ROLLBACK/);
  await c.query('ROLLBACK');
  assert.deepEqual(await catalog(), sourceCatalog);
  await c.query(migration);
  assert.deepEqual(await catalog(), finalCatalog);
  await c.query(migration);
  assert.deepEqual(await catalog(), finalCatalog);
  for (const original of [source, target]) {
    const drift = original.replace('AS $function$', 'AS $function$\n-- local test drift');
    await c.query(drift);
    const driftCatalog = await catalog();
    await assert.rejects(c.query(migration), /NATIVE_METADATA_VIEW_SOURCE_MISMATCH/);
    await c.query('ROLLBACK');
    assert.deepEqual(await catalog(), driftCatalog);
  }
  await c.query(source);
  const invalidTarget = migration.replace("'organized',CASE", "'organizedBroken',CASE");
  await assert.rejects(c.query(invalidTarget), /NATIVE_METADATA_VIEW_TARGET_MISMATCH/);
  await c.query('ROLLBACK');
  assert.deepEqual(await catalog(), sourceCatalog);
  await c.query(migration);
  report.checks.push('0168 source MD5; two applies identical; source/target drift refusal; transaction rollback; only function body changes, ACL/owner unchanged');

  await c.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
  const f = await seed(8, true), foreign = await seed(1);
  const ids = (await c.query('SELECT id FROM runtime_executions WHERE session_id=$1 ORDER BY created_at,id', [f.session])).rows.map(r => r.id);
  const scenarios = [
    {},
    { completeness: 'complete', organized: true, summaryOmitted: false, messageFirst: true, envelopeCompact: false },
    { completeness: 'length_limit', organized: false, summaryOmitted: true, messageFirst: false, envelopeCompact: true },
    { completeness: 'length_limit' },
    { completeness: 'stopped', organized: 'false', summaryOmitted: 1, messageFirst: {}, envelopeCompact: null },
    { completeness: null, organized: null, summaryOmitted: null, messageFirst: null },
    { completeness: ['complete'], organized: [], summaryOmitted: 'true' },
    { completeness: 'complete', organized: false },
  ];
  for (let i = 0; i < ids.length; i++) {
    await c.query(`UPDATE runtime_executions SET result=result || $2::jsonb WHERE id=$1`,
      [ids[i], { ...scenarios[i], privateResult: 'never public', reasoning: 'never public', tool: 'never public' }]);
  }
  const facts = async () => (await c.query(`SELECT to_jsonb(e) e,to_jsonb(b) b FROM runtime_executions e
    JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.session_id=$1 ORDER BY e.id`, [f.session])).rows;
  const beforeFacts = await facts();
  await c.query(source);
  const before = await view(f);
  await c.query(migration);
  const after = await view(f);
  assert.deepEqual({ ...after, executions: after.executions.map(strip) }, before, 'legacy response fields identical');
  assert.deepEqual(after.executions.map(metadata), [scenarios[0], scenarios[1], scenarios[2], scenarios[3], {}, {}, {}, scenarios[7]]);
  assert.equal(JSON.stringify(after).includes('never public'), false);
  assert.deepEqual(await view(f), after, 'refresh retains earlier truncation and compact-envelope flags');
  assert.deepEqual(await facts(), beforeFacts, 'no changes to saved execution or billing facts');
  await c.query(source);
  assert.deepEqual(await view(f), before, 'rollback restores old response with all data retained');
  await c.query(migration);
  assert.deepEqual(await view(f), after);
  report.checks.push('complete/length_limit/compact historical results; missing/null/invalid types omitted; only whitelist exposed; legacy fields and stored facts unchanged; populated rollback/reapply');

  await c.query('SET ROLE service_role');
  assert.deepEqual(await view(f), after);
  await assert.rejects(view(f, foreign.actor), /RUNTIME_SCOPE_DENIED/);
  await assert.rejects(view({ ...f, session: randomUUID() }), /RUNTIME_SCOPE_DENIED/);
  await c.query('RESET ROLE');
  for (const role of ['anon', 'authenticated']) {
    await c.query('SET ROLE ' + role);
    await c.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [f.actor]);
    await assert.rejects(view(f), /permission denied/);
    await c.query('RESET ROLE');
  }
  await c.query("SELECT set_config('request.jwt.claim.sub','',false)");
  for (const sql of [
    "UPDATE profiles SET status='inactive' WHERE id=$1",
    "UPDATE profiles SET is_deleted=true WHERE id=$1",
    'UPDATE bill2_drafts SET revoked=true WHERE actor_id=$1',
  ]) {
    await c.query('BEGIN');
    await c.query(sql, [f.actor]);
    await assert.rejects(view(f), /BILL2_ACTOR_DENIED|RUNTIME_SCOPE_DENIED|ACCOUNT_CLOSED/);
    await c.query('ROLLBACK');
  }
  for (const sql of [
    'UPDATE runtime_scope_material SET revoked=true WHERE session_id=$1',
    "UPDATE runtime_executions SET unavailable_reason='source_revoked' WHERE session_id=$1 AND history_revision=0",
  ]) {
    await c.query('BEGIN');
    await c.query(sql, [f.session]);
    const hidden = await view(f);
    assert.ok(hidden.executions.every(row => !row.contentAvailable && row.body === null));
    assert.ok(hidden.executions.every(row => Object.keys(metadata(row)).length === 0));
    await c.query('ROLLBACK');
  }
  // A held view transaction must not block a second connection's execution update.
  await c.query('BEGIN');
  await view(f);
  db.sql(`BEGIN; SET LOCAL lock_timeout='200ms'; UPDATE runtime_executions SET state=state WHERE id='${ids[0]}'; ROLLBACK;`);
  await c.query('ROLLBACK');
  report.checks.push('service actor allow/foreign and missing session deny; direct anon/authenticated deny; inactive/deleted/revoked deny; hidden history omits metadata; concurrent execution update not locked');

  for (const n of [15, 100, 300, 1000]) {
    const f = await seed(n);
    await c.query(`UPDATE runtime_executions SET result=result || '{"completeness":"length_limit","organized":false,"summaryOmitted":true}'::jsonb WHERE session_id=$1`, [f.session]);
    await c.query('ANALYZE');
    const times = { before: [], after: [] };
    for (let round = 0; round < 6; round++) {
      // Alternate order to reduce cache/order bias; omit the first paired warm-up.
      for (const kind of round % 2 ? ['after', 'before'] : ['before', 'after']) {
        await c.query(kind === 'before' ? source : target);
        const plan = (await c.query('EXPLAIN (ANALYZE,FORMAT JSON) SELECT runtime_view($1,$2)', [f.actor, f.session])).rows[0]['QUERY PLAN'];
        if (round) times[kind].push(plan[0]['Execution Time']);
      }
    }
    await c.query(target);
    const projected = await view(f);
    assert.equal(projected.executions.length, n);
    assert.ok(projected.executions.every(row => row.completeness === 'length_limit'));
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const beforeMs = median(times.before), afterMs = median(times.after);
    // A bounded per-row JSON projection is expected; fail on a material slowdown.
    const limitMs = beforeMs * 1.25 + 15;
    report.samples.push({ executions: n, history: n * 5, times, beforeMedianMs: beforeMs, afterMedianMs: afterMs, limitMs });
    assert.ok(afterMs <= limitMs, `material history regression at ${n}: ${afterMs} > ${limitMs}`);
    if (n <= 100) assert.ok(afterMs < 1000, 'existing interactive history budget');
    console.log('PASS history', n, 'before/after ms', beforeMs, afterMs);
  }
  report.checks.push('paired warm-cache SQL timings at 15/100/300/1000 turns; one view query; every old truncation marker retained');
} catch (error) {
  report.failed = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await c.query('ROLLBACK');
  await c.query('RESET ROLE');
  await db.close();
  report.cleanup = 'PASS';
  console.log(JSON.stringify(report, null, 2));
}
