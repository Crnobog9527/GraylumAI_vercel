/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only DATA-ERASURE 0242 verification: erasure finishes for accounts with a positioning draft.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localDb, read } from '../runtime-view-perf/local-db.mjs';

const migrationPath = 'packages/db/migrations/0242_erasure_opc_draft_delete.sql';
const db = await localDb(), c = db.client;
const report = { build: db.build, migration: '0242', checks: [] };
const v = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const count = (table, column, id) => v(`SELECT count(*)::int v FROM ${table} WHERE ${column}=$1`, [id]);
const errorOf = promise => promise.then(() => null, error => error);

async function draftAccount() {
  const actor = await v('SELECT ws_test.actor() v');
  const made = await v("SELECT ws_test.positioning($1,'Biz fixture','PRIVATE_CANARY') v", [actor]);
  await c.query("INSERT INTO credit_transactions(idempotency_key,user_id,amount,type,description) VALUES('fixture:'||gen_random_uuid(),$1,25,'addition','fixture grant')", [actor]);
  return { actor, ...made };
}
async function erase(f) {
  await c.query('SELECT account_erasure_confirm($1,$2)', [f.actor, randomUUID()]);
  await c.query('SELECT account_erasure_scrub_content($1)', [f.actor]);
  await c.query('SELECT account_erasure_scrub_runtime($1)', [f.actor]);
  return v('SELECT account_erasure_local_cleanup($1,true) v', [f.actor]);
}

try {
  await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
  const fingerprint = read('packages/db/tests/baseline/fingerprint.sql');
  const catalogSql = fingerprint.slice(0, fingerprint.indexOf('-- FINAL')) + 'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
  const after0242 = await v(catalogSql);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), after0242);
  report.checks.push('0242 reapplication after the full chain preserves the complete catalog');

  // The bug: with the pre-0242 guard, local cleanup aborts on the draft.
  await c.query(read('packages/db/tests/erasure-opc-draft/rollback.sql'));
  const broken = await draftAccount();
  await c.query('SELECT account_erasure_confirm($1,$2)', [broken.actor, randomUUID()]);
  await c.query('SELECT account_erasure_scrub_content($1)', [broken.actor]);
  await c.query('SELECT account_erasure_scrub_runtime($1)', [broken.actor]);
  assert.match((await errorOf(c.query('SELECT account_erasure_local_cleanup($1,true)', [broken.actor])))?.message ?? '', /OPC_IMMUTABLE_DRAFT/);
  await c.query(read(migrationPath));
  assert.deepEqual(await v(catalogSql), after0242);
  report.checks.push('without 0242 local cleanup aborts with OPC_IMMUTABLE_DRAFT; rollback then reapply restores the catalog');

  // Deny: an open account's draft stays undeletable, and updates stay immutable even after closure.
  const open = await draftAccount();
  assert.match((await errorOf(c.query('DELETE FROM opc_drafts WHERE draft_id=$1', [open.draft])))?.message ?? '', /OPC_IMMUTABLE_DRAFT/);
  assert.equal(await count('opc_drafts', 'draft_id', open.draft), 1);
  report.checks.push('deny: an open account cannot delete its draft');

  // Allow: erasure of an account with a draft now runs through and clears drafts and business leaves.
  const f = await draftAccount();
  const credits = await v('SELECT credits v FROM profiles WHERE id=$1', [f.actor]);
  let cleanup = await erase(f);
  for (let pass = 0; pass < 5 && cleanup.remaining > 0; pass++) cleanup = await v('SELECT account_erasure_local_cleanup($1,true) v', [f.actor]);
  assert.equal(await count('opc_drafts', 'actor_id', f.actor), 0, 'draft removed');
  assert.equal(await count('opc_draft_businesses', 'draft_id', f.draft), 0, 'draft link removed');
  assert.equal(await count('opc_businesses', 'actor_id', f.actor), 0, 'business removed');
  assert.equal(await count('runtime_sessions', 'actor_id', f.actor), 0, 'draft session removed');
  assert.equal(await count('artifact_projects', 'actor_id', f.actor), 0, 'positioning project removed');
  // The only business work left is the library storage proof, which the executor's storage step records.
  assert.equal(await v(`SELECT account_erasure_business_remaining($1)::int
    - (SELECT count(*)::int FROM account_erasure_requests WHERE profile_id=$1 AND library_storage_verified_at IS NULL) v`, [f.actor]), 0);
  assert.equal(await v('SELECT credits v FROM profiles WHERE id=$1', [f.actor]), credits, 'balance kept');
  assert.equal(await count('credit_transactions', 'user_id', f.actor), 1, 'ledger row kept');
  assert.equal(await count('opc_drafts', 'draft_id', open.draft), 1, "another account's draft untouched");
  assert.match((await errorOf(c.query("UPDATE opc_drafts SET mode='changed' WHERE draft_id=$1", [open.draft])))?.message ?? '',
    /OPC_IMMUTABLE_DRAFT/, 'updates stay immutable');
  report.checks.push('allow: erasure with a draft finishes local cleanup; drafts and business leaves cleared; accounting kept');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
