/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only DATA-ERASURE 0227 verification: off-database manifest outbox (pending sync rows).
// No database URL, environment secret, Redis or remote host is accepted or contacted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';
import { fixture, rpc } from '../erasure-b2a/cases.mjs';
import { runtimeFixture, erase, preview } from '../content-erasure/cases.mjs';

const migrationPath = 'packages/db/migrations/0227_erasure_offdb_manifest.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0227', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const rows = async actor => (await c.query('SELECT kind,target_id,profile_id,confirmed_at,synced_at'
  + ' FROM erasure_manifest_outbox WHERE profile_id=$1 ORDER BY kind,target_id', [actor])).rows;
const asService = async fn => { await c.query('SET ROLE service_role'); try { return await fn(); } finally { await c.query('RESET ROLE'); } };
const close = a => v('SELECT account_erasure_confirm($1,$2) v', [a, randomUUID()]);
const artifacts = async () => (await c.query('SELECT d7_test.artifacts($1) v', [(await fixture(c)).actor])).rows[0].v;
const libraryDoc = async a => (await c.query("INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename,status)"
  + " VALUES($1,gen_random_uuid(),'document','txt','reference','PRIVATE_FILENAME.txt','ready') RETURNING id", [a])).rows[0].id;
const libraryDelete = (a, did, closed = false) => asService(() => rpc(c, 'library_delete', a, did, closed, false, false));
try {
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const before = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), before);
  const confirmSource = await v("SELECT prosrc v FROM pg_proc WHERE oid='public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure");
  assert.equal(confirmSource.split('-- 0227 erasure manifest').length, 2, 'confirm patched exactly once');
  report.checks.push('0227 reapplication after the full chain preserves the complete catalog; confirm patched once');
  await c.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
  await c.query(read('packages/db/tests/content-erasure/fixture.sql'));

  const service = ['erasure_manifest_pending(integer)', 'erasure_manifest_mark_synced(uuid[])', 'erasure_manifest_cleanup()'];
  const internal = ['erasure_manifest_note(text,uuid,uuid,timestamptz)', 'erasure_manifest_account_trigger()',
    'erasure_manifest_library_trigger()'];
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const f of [...service, ...internal]) {
      const expected = role === 'service_role' && service.includes(f);
      assert.equal(await v('SELECT has_function_privilege($1,$2,\'execute\') v', [role, f]), expected, `${role} ${f}`);
    }
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await v('SELECT has_table_privilege($1,\'erasure_manifest_outbox\',$2) v', [role, p]), false, `${role} ${p}`);
    }
  }
  assert.equal(await v("SELECT relrowsecurity v FROM pg_class WHERE oid='erasure_manifest_outbox'::regclass"), true);
  for (const f of [...service, ...internal]) {
    const fn = (await c.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', ['public.' + f])).rows[0];
    assert.equal(fn.prosecdef, true, f); assert.deepEqual(fn.proconfig, ['search_path=public, pg_temp'], f);
  }
  assert.deepEqual((await c.query("SELECT attname FROM pg_attribute WHERE attrelid='erasure_manifest_outbox'::regclass"
    + ' AND attnum>0 AND NOT attisdropped ORDER BY attnum')).rows.map(r => r.attname),
  ['id', 'kind', 'target_id', 'profile_id', 'confirmed_at', 'synced_at']);
  report.checks.push('RLS on; no client or service_role table access; only 3 service RPCs; definer + fixed search_path; ID-only columns');

  const answer = await runtimeFixture(c, { settled: true });
  await assert.rejects(erase(c, answer, 'answer', answer.execution, 'a'.repeat(64)), /PREVIEW_CHANGED/);
  assert.deepEqual(await rows(answer.actor), [], 'failed confirmation records nothing');
  assert.equal((await erase(c, answer)).status, 'deleted');
  assert.equal((await erase(c, answer)).alreadyDeleted, true);
  const stamp = await v('SELECT content_deleted_at v FROM runtime_executions WHERE id=$1', [answer.execution]);
  assert.deepEqual(await rows(answer.actor), [{ kind: 'answer', target_id: answer.execution, profile_id: answer.actor,
    confirmed_at: stamp, synced_at: null }]);
  report.checks.push('answer deletion: exactly one row with the deletion stamp; failed and repeated confirms add none');

  const session = await runtimeFixture(c, { settled: true });
  assert.equal((await erase(c, session, 'session', session.session)).status, 'deleted');
  assert.deepEqual((await rows(session.actor)).map(r => [r.kind, r.target_id]), [['session', session.session]],
    'session closure marks its executions but records only the chosen session');
  const artifact = await artifacts();
  const artifactPreview = await preview(c, artifact, 'artifact', artifact.project);
  assert.ok(artifactPreview.affectedExecutions >= 0);
  assert.equal((await erase(c, artifact, 'artifact', artifact.project)).status, 'deleted');
  assert.deepEqual((await rows(artifact.actor)).map(r => [r.kind, r.target_id]), [['artifact', artifact.project]]);
  const content = await artifacts();
  assert.equal((await erase(c, content, 'content', content.content)).status, 'deleted');
  assert.deepEqual((await rows(content.actor)).map(r => [r.kind, r.target_id]), [['content', content.content]]);
  report.checks.push('session/artifact/content deletion: exactly one row each, for the chosen target only');

  const account = await artifacts();
  const libraryClosed = await libraryDoc(account.actor);
  const closed = await close(account.actor);
  assert.equal(closed.created, true);
  assert.equal((await close(account.actor)).created, false);
  await rpc(c, 'account_erasure_scrub_runtime', account.actor);
  await rpc(c, 'account_erasure_scrub_content', account.actor);
  assert.equal((await libraryDelete(account.actor, libraryClosed, true)).status, 'deleting');
  assert.ok(await v('SELECT erased_at v FROM opc_content_versions WHERE id=$1', [account.content]), 'scrub ran');
  const confirmedAt = await v('SELECT confirmed_at v FROM account_erasure_requests WHERE profile_id=$1', [account.actor]);
  assert.deepEqual(await rows(account.actor), [{ kind: 'account', target_id: account.actor, profile_id: account.actor,
    confirmed_at: confirmedAt, synced_at: null }]);
  report.checks.push('account erasure: one account row (repeat idempotent); scrub and closed library cleanup add no single rows');

  const reader = (await fixture(c)).actor;
  const doc = await libraryDoc(reader);
  assert.equal((await libraryDelete(reader, doc)).status, 'deleting');
  assert.equal((await libraryDelete(reader, doc)).status, 'deleting');
  const deletedAt = await v('SELECT deleted_at v FROM library_documents WHERE id=$1', [doc]);
  assert.deepEqual(await rows(reader), [{ kind: 'library_document', target_id: doc, profile_id: reader,
    confirmed_at: deletedAt, synced_at: null }]);
  assert.doesNotMatch(JSON.stringify(await asService(() => rpc(c, 'erasure_manifest_pending', 500))), /PRIVATE_FILENAME|KEEP_USER_QUESTION|D7_/);
  report.checks.push('library deletion: one row with deleted_at; repeat deletion adds none; pending output has no content');

  // A broken outbox must never block or undo the deletion it records.
  const blocked = (await fixture(c)).actor, blockedDoc = await libraryDoc(blocked);
  await c.query('BEGIN');
  try {
    await c.query('ALTER TABLE erasure_manifest_outbox ADD CONSTRAINT erasure_manifest_test_block CHECK(false) NOT VALID');
    assert.equal((await libraryDelete(blocked, blockedDoc)).status, 'deleting');
    assert.ok(await v('SELECT deleted_at v FROM library_documents WHERE id=$1', [blockedDoc]));
    assert.deepEqual(await rows(blocked), []);
    const blockedAnswer = await runtimeFixture(c, { settled: true });
    assert.equal((await erase(c, blockedAnswer)).status, 'deleted');
    assert.equal((await close(blocked)).created, true);
  } finally { await c.query('ROLLBACK'); }
  assert.equal(await v("SELECT count(*)::int v FROM pg_constraint WHERE conname='erasure_manifest_test_block'"), 0);
  report.checks.push('failing outbox insert (forced CHECK) never blocks library, answer or account deletion');

  const old = randomUUID(), recent = randomUUID();
  await c.query("INSERT INTO erasure_manifest_outbox(kind,target_id,profile_id,confirmed_at,synced_at) VALUES"
    + " ('answer',gen_random_uuid(),$1,now()-interval '36 days',NULL),('session',gen_random_uuid(),$1,now()-interval '40 days',now()),"
    + " ('artifact',gen_random_uuid(),$2,now()-interval '34 days',NULL)", [old, recent]);
  const pending = await asService(() => rpc(c, 'erasure_manifest_pending', 500));
  assert.ok(pending.every(r => r.profileId !== old), 'rows older than 35 days are never synced again');
  assert.ok(pending.some(r => r.profileId === recent));
  assert.equal((await asService(() => rpc(c, 'erasure_manifest_pending', 1))).length, 1);
  assert.equal((await asService(() => rpc(c, 'erasure_manifest_cleanup'))), 2);
  assert.deepEqual(await rows(old), []);
  assert.equal((await rows(recent)).length, 1);
  const ids = pending.map(r => r.id);
  assert.equal(await asService(() => rpc(c, 'erasure_manifest_mark_synced', ids)), ids.length);
  assert.equal(await asService(() => rpc(c, 'erasure_manifest_mark_synced', ids)), 0);
  assert.deepEqual(await asService(() => rpc(c, 'erasure_manifest_pending', 500)), []);
  await assert.rejects(asService(() => rpc(c, 'erasure_manifest_mark_synced', Array.from({ length: 501 }, randomUUID))),
    /BATCH_TOO_LARGE/);
  report.checks.push('35-day cleanup removes synced and unsynced old rows only; pending is bounded; mark synced is idempotent');
  assert.equal(db.sql(read('packages/db/tests/account-open-policy-audit.sql')), '');
  report.checks.push('account-open policy audit still returns zero rows');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
