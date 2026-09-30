/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only deterministic sessions test the real migrated functions, never a replacement scrub.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parentLocks } from './erasure-b1b-parent-locks.mjs';
import { localDatabase } from './erasure-b1b-barrier-local.mjs';
import { actorFixture, artifactFixture, pauseInsert } from './erasure-b1b-barrier-fixtures.mjs';

if (process.argv.slice(2).join(' ') !== '--local-only' || process.env.CI) {
  throw new Error('Usage: node packages/db/tests/run-erasure-b1b-barrier.mjs --local-only');
}
const db = await localDatabase();
const { q, sql, Session } = db;
const retry = { retry: true, reason: 'transactions_pending' };
const scrubbers = ['account_erasure_scrub_content', 'account_erasure_scrub_runtime'];
const service = input => `SET ROLE service_role; ${input}`;
const confirm = actor => q(service(`SELECT account_erasure_confirm('${actor}',gen_random_uuid())`));
const scrub = (name, actor) => JSON.parse(q(service(`SELECT ${name}('${actor}')`)));
function blocked(actor) {
  for (const name of scrubbers) assert.deepEqual(scrub(name, actor), retry, name);
}
function clear(actor) {
  for (const name of scrubbers) assert.equal(scrub(name, actor).retry, undefined, name);
}
const fingerprint = () => q(`SELECT md5(jsonb_build_array(
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM runtime_sessions s),
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM research_plans s),
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY actor_id,scope_key,name) FROM agent_confirmed_preferences s),
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY actor_id,account_project_id) FROM opc_account_ui s),
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM artifact_projects s),
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM conversations s))::text)`);
async function waitAdvisory(label) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (q(`SELECT EXISTS(SELECT FROM pg_stat_activity
      WHERE application_name='${label}' AND wait_event='advisory')`) === 't') return;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`${label}: actual writer did not reach its post-active advisory barrier`);
}
function fixture(kind) {
  const actor = actorFixture(q);
  const request = randomUUID();
  if (kind === 'runtime') {
    const draft = q(`SELECT bill2_create_draft('${actor}')`);
    return { actor, key: `hashtextextended('${actor}'||'${request}',106)`,
      call: `runtime_start('${actor}','${request}','{"scope":{"kind":"positioning_draft","draftId":"${draft}"}}')`,
      erased: `SELECT count(*) FROM runtime_sessions WHERE actor_id='${actor}' AND erased_at IS NOT NULL AND scope IS NULL`,
      denial: 'BILL2_ACTOR_DENIED' };
  }
  if (kind === 'agent') {
    return { actor, key: `hashtextextended('${actor}',413)`,
      call: `agent_preference('${actor}','confirm','{"scope":"user","name":"tone","value":"private tone",
        "confirmed":true,"requestId":"${request}","expectedVersion":0}')`,
      erased: `SELECT count(*) FROM agent_confirmed_preferences WHERE actor_id='${actor}'`,
      erasedCount: '0', denial: 'PREFERENCE_DENIED' };
  }
  if (kind === 'research') {
    const plan = randomUUID();
    return { actor, table: 'research_plans', key: '150150',
      call: `research_transition('create','${plan}','${actor}',NULL,
        '{"budgetUnits":1,"maxOperations":1,"operations":[{"query":"private query"}]}')`,
      erased: `SELECT count(*) FROM research_plans WHERE id='${plan}' AND erased_at IS NOT NULL AND operations IS NULL`,
      denial: 'research denied' };
  }
  const ids = artifactFixture(q, actor);
  if (kind === 'artifact') {
    return { actor, table: 'conversations', key: '150150',
      call: `artifact_chat('${actor}','attach',NULL,'{"projectId":"${ids.project}","roundId":"${ids.round}","requestId":"${request}"}')`,
      erased: `SELECT count(*) FROM conversations WHERE id='${request}' AND erased_at IS NOT NULL AND title IS NULL`,
      denial: 'artifact denied' };
  }
  q(`INSERT INTO opc_accounts(project_id,actor_id,platform,account_key,source_version_id)
    VALUES('${ids.project}','${actor}','test','barrier','${ids.version}')`);
  return { actor, table: 'opc_account_ui', key: '150150',
    call: `opc_account_ui_change('${actor}','${request}','${ids.project}',1,'private account name')`,
    erased: `SELECT count(*) FROM opc_account_ui WHERE actor_id='${actor}'`,
    erasedCount: '0', denial: 'BILL2_ACTOR_DENIED' };
}
async function lateWriter(kind, oldScrubTransaction = false) {
  const test = fixture(kind);
  const removePause = test.table ? pauseInsert(q, test.table) : () => {};
  const controller = new Session(`barrier-${kind}-controller`);
  const writer = new Session(`barrier-${kind}-writer`);
  try {
    await controller.exec(`SELECT pg_advisory_lock(${test.key})`);
    if (oldScrubTransaction) await controller.exec('BEGIN; SELECT count(*) FROM pg_stat_activity');
    const pending = writer.exec(`BEGIN; SET LOCAL ROLE service_role; SET LOCAL barrier.test_pause='on'; SELECT ${test.call}; COMMIT`);
    pending.catch(() => {});
    await waitAdvisory(writer.label);
    confirm(test.actor);
    const before = fingerprint();
    if (oldScrubTransaction) {
      assert.equal(await controller.exec('SELECT public.account_erasure_barrier()'), 'f',
        'Invocation clock cutoff must detect writer despite old transaction and cached statistics');
      for (const name of scrubbers) {
        assert.deepEqual(JSON.parse(await controller.exec(`SET LOCAL ROLE service_role; SELECT ${name}('${test.actor}'); RESET ROLE`)), retry);
      }
    } else blocked(test.actor);
    assert.equal(fingerprint(), before, `${kind}: retry must make no content change`);
    await controller.exec(`SELECT pg_advisory_unlock(${test.key})${oldScrubTransaction ? '; COMMIT' : ''}`);
    await pending;
    await writer.end();
    clear(test.actor);
    assert.equal(q(test.erased), test.erasedCount ?? '1', `${kind}: late content cleared`);
    const denial = sql(service(`SELECT ${test.call}`));
    assert.notEqual(denial.status, 0, `${kind}: a newly started post-close entry must fail`);
    assert.ok(denial.stderr.includes(test.denial), denial.stderr);
    console.log(`PASS ${kind}: real entry paused after active -> close -> both scrubs retry unchanged -> late commit -> erased; new entry denied`);
  } finally {
    await controller.end();
    if (writer.code === undefined) await writer.end();
    removePause();
  }
}
try {
  // Catalog safety contract, not extension integration: this local image has no real pg_net
  // or pg_cron job workers. Only the controller-approved maintenance/launcher types may bypass.
  const definition = q("SELECT pg_get_functiondef('public.account_erasure_barrier()'::regprocedure)");
  const excludedClause = definition.match(/a\.backend_type NOT IN \(([\s\S]*?)\)/)?.[1];
  assert.ok(excludedClause, 'Barrier must retain its explicit backend-type exclusion list');
  const excluded = [...excludedClause.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(excluded, ['archiver', 'autovacuum launcher', 'autovacuum worker',
    'background writer', 'checkpointer', 'logical replication launcher', 'walwriter', 'pg_cron launcher'].sort());
  for (const sqlWorker of ['pg_net', 'pg_net worker', 'pg_cron worker', 'pg_cron job',
    'parallel worker', 'logical replication worker']) {
    assert.ok(!excluded.includes(sqlWorker), `${sqlWorker} cannot bypass the transaction barrier`);
  }
  console.log('PASS catalog safety contract: exact eight maintenance/launcher exclusions; SQL-capable workers not excluded');
  const closed = actorFixture(q);
  confirm(closed);
  clear(closed);
  const idle = new Session('barrier-idle');
  try {
    await idle.exec('SELECT 1');
    clear(closed);
    console.log('PASS verified idle outside a transaction is allowed');
    await idle.exec('BEGIN; SELECT 1');
    blocked(closed);
    await idle.exec('ROLLBACK');
    clear(closed);
    console.log('PASS idle in transaction blocks both scrubs; release restores progress');
    await idle.exec('SET track_activities=off');
    blocked(closed);
    await idle.exec('SET track_activities=on');
    clear(closed);
    console.log('PASS disabled/unknown activity fails closed');
  } finally { await idle.end(); }
  q('CREATE ROLE barrier_without_stats; ALTER FUNCTION account_erasure_barrier() OWNER TO barrier_without_stats');
  try { blocked(closed); } finally { q('ALTER FUNCTION account_erasure_barrier() OWNER TO postgres; DROP ROLE barrier_without_stats'); }
  clear(closed);
  console.log('PASS no statistics privilege fails closed even with an otherwise empty activity view');
  for (const name of scrubbers) {
    const rr = sql(`BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE service_role; SELECT ${name}('${closed}')`);
    assert.notEqual(rr.status, 0);
    assert.ok(rr.stderr.includes('ACCOUNT_ERASURE_ISOLATION_DENIED'), rr.stderr);
  }
  console.log('PASS both scrubs reject REPEATABLE READ');
  q("BEGIN; SELECT 1; PREPARE TRANSACTION 'barrier_prepared'");
  try { blocked(closed); } finally { q("ROLLBACK PREPARED 'barrier_prepared'"); }
  clear(closed);
  console.log('PASS prepared transaction blocks both scrubs without a live backend; resolution restores progress');
  for (const nested of [false, true]) {
    const actor = actorFixture(q);
    q(service(`SELECT runtime_start('${actor}',gen_random_uuid(),'{"scope":{"kind":"positioning_draft"}}')`));
    const session = new Session(`barrier-confirm-same-transaction-${nested ? 'nested' : 'direct'}`);
    try {
      await session.exec('BEGIN; SET LOCAL ROLE service_role');
      const confirmation = `PERFORM account_erasure_confirm('${actor}',gen_random_uuid())`;
      await session.exec(nested
        ? `DO $$ BEGIN BEGIN ${confirmation}; EXCEPTION WHEN OTHERS THEN RAISE; END; END $$`
        : `SELECT account_erasure_confirm('${actor}',gen_random_uuid())`);
      for (const name of scrubbers) {
        assert.deepEqual(JSON.parse(await session.exec(`SELECT ${name}('${actor}')`)), retry,
          `${name}: closure must commit separately before scrub (${nested ? 'subtransaction' : 'direct'})`);
      }
      assert.equal(await session.exec(`RESET ROLE; SELECT count(*) FROM runtime_sessions
        WHERE actor_id='${actor}' AND erased_at IS NULL AND scope IS NOT NULL`), '1');
      await session.exec('COMMIT');
      await session.end();
      clear(actor);
      assert.equal(q(`SELECT count(*) FROM runtime_sessions
        WHERE actor_id='${actor}' AND erased_at IS NOT NULL AND scope IS NULL`), '1');
    } finally { if (session.code === undefined) await session.end(); }
    console.log(`PASS ${nested ? 'successful exception subtransaction' : 'direct'} confirm: both scrubs retry until separate commit`);
  }
  for (const kind of ['runtime', 'agent', 'research', 'artifact', 'opc']) {
    const normal = fixture(kind);
    q(service(`SELECT ${normal.call}`));
    console.log(`PASS ${kind}: real normal admission remains writable`);
    await lateWriter(kind, kind === 'runtime');
  }
  await parentLocks(db);
  console.log('PASS old scrub transaction still sees newer pre-close runtime writer using invocation clock cutoff');
} finally {
  await db.cleanup();
}
console.log('PASS barrier suite and local container cleanup');
