/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { actorFixture } from './erasure-b1b-barrier-fixtures.mjs';

export async function databaseScope({ q, Session }) {
  q('CREATE DATABASE b1b_other');
  const other = new Session('barrier-other-database', 'b1b_other');
  const current = new Session('barrier-current-database');
  const actor = actorFixture(q);
  q(`SET ROLE service_role; SELECT runtime_start('${actor}',gen_random_uuid(),
    '{"scope":{"kind":"positioning_draft"}}')`);
  const scrubs = () => ['account_erasure_scrub_content', 'account_erasure_scrub_runtime']
    .map(name => JSON.parse(q(`SET ROLE service_role; SELECT ${name}('${actor}')`)));
  try {
    await other.exec('BEGIN; SELECT 1');
    assert.equal(q(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${other.label}'
      AND datname='b1b_other' AND state='idle in transaction' AND xact_start IS NOT NULL`), '1');
    q(`SET ROLE service_role; SELECT account_erasure_confirm('${actor}',gen_random_uuid())`);
    for (const result of scrubs()) assert.equal(result.retry, undefined, 'Other database must not block either scrub');
    assert.equal(q(`SELECT count(*) FROM runtime_sessions WHERE actor_id='${actor}'
      AND erased_at IS NOT NULL AND scope IS NULL AND start_payload IS NULL`), '1');
    console.log('PASS another database old transaction stays open while both scrubs pass and content is erased');
    await current.exec('BEGIN; SELECT 1');
    for (const result of scrubs()) assert.deepEqual(result, { retry: true, reason: 'transactions_pending' });
    await current.exec('ROLLBACK');
    for (const result of scrubs()) assert.equal(result.retry, undefined);
    assert.equal(q(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${other.label}'
      AND state='idle in transaction'`), '1');
    console.log('PASS same database old transaction still blocks both scrubs; release restores progress');
  } finally {
    await current.end();
    await other.end();
    q('DROP DATABASE b1b_other');
  }
  // Exercise the actual scan SELECT on constructed database-less rows. Do not replace the
  // production function or system view. This is a row/scan contract, not a live databaseless worker.
  const definition = q("SELECT pg_get_functiondef('public.account_erasure_barrier()'::regprocedure)");
  const statement = definition.match(/SELECT coalesce\(bool_and[\s\S]+?;(?=\s*IF NOT activity_safe)/)?.[0];
  assert.ok(statement, 'One activity scan must produce both decision and candidate PIDs');
  const scan = statement.replace(/INTO activity_safe, candidate_pids/, '')
    .replace(/\bcutoff\b/g, 'clock_timestamp()').replace('FROM pg_stat_activity a', 'FROM activity_fixture a');
  for (const [type, expected] of [["'future SQL worker'", 't|{987654}'], ['NULL', 'f|']]) {
    assert.equal(q(`WITH activity_fixture AS (SELECT 987654 AS pid,NULL::oid AS datid,
      ${type}::text AS backend_type,NULL::text AS state,NULL::timestamptz AS xact_start,
      NULL::xid AS backend_xid,NULL::xid AS backend_xmin) ${scan}`), expected);
  }
  console.log('PASS database-less worker rows retained by actual scan; named candidate preserved and invisible type refused');
}
