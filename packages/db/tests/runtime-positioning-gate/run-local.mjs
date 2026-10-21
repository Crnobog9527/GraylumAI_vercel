/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb, read} from '../runtime-view-perf/local-db.mjs';

const db = await localDb(), c = db.client;
const migration = read('packages/db/migrations/0332_runtime_positioning_gate_transaction.sql');
const report = {checks: [], failed: null};
const one = async (sql, args = []) => (await c.query(sql, args)).rows[0]?.v;
const signature = 'public.runtime_positioning_gate(uuid)';
// PostgREST chooses READ ONLY for a STABLE RPC, READ WRITE for VOLATILE (including
// POST requests). Reproduce that transaction boundary, not just a bare SQL SELECT.
async function rpc(actor) {
  const volatility = await one('SELECT provolatile v FROM pg_proc WHERE oid=$1::regprocedure', [signature]);
  await c.query(volatility === 'v' ? 'BEGIN READ WRITE' : 'BEGIN READ ONLY');
  try {
    await c.query('SET LOCAL ROLE service_role');
    return await one('SELECT runtime_positioning_gate($1) v', [actor]);
  } finally { await c.query('ROLLBACK'); }
}
try {
  await c.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
  await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
  const f = await one('SELECT runtime_perf_test.seed(1) v');
  const p = await one("SELECT ws_test.positioning($1,'Synthetic studio','CANARY') v", [f.actor]);
  const round = await one('SELECT round_id v FROM artifact_versions WHERE id=$1', [p.version]);
  const evidence = randomUUID();
  // Local synthetic report points at an actual Runtime/BILL2 execution. The old
  // fixture used [] evidence, so it never reached runtime_history_available's locks.
  await c.query('SET session_replication_role=replica');
  try {
    await c.query("INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash) VALUES($1,$2,'user',$3,$4)",
      [evidence, p.project, {executionId: f.execution}, 'a'.repeat(64)]);
    await c.query('INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES($1)', [evidence]);
    await c.query("INSERT INTO opc_result_links(evidence_id,execution_id,round_id,step_id) VALUES($1,$2,$3,'s1')",
      [evidence, f.execution, round]);
    await c.query('UPDATE artifact_versions SET evidence_ids=$2 WHERE id=$1', [p.version, JSON.stringify([evidence])]);
  } finally { await c.query('SET session_replication_role=origin'); }
  assert.equal(await one('SELECT runtime_history_available($1) v', [f.execution]), true);
  const original = await one('SELECT pg_get_functiondef($1::regprocedure) v', [signature]);
  const acl = await one('SELECT proacl::text v FROM pg_proc WHERE oid=$1::regprocedure', [signature]);
  await c.query(`ALTER FUNCTION ${signature} STABLE`);
  await assert.rejects(rpc(f.actor), error => error.code === '25006' && /FOR SHARE/.test(error.message));
  report.checks.push('before: STABLE/PostgREST READ ONLY rejects the real billing shared lock with 25006');
  await c.query(migration);
  assert.deepEqual(await rpc(f.actor), {positioned: true, refusals24h: 0});
  assert.equal(await one('SELECT pg_get_functiondef($1::regprocedure) v', [signature]), original);
  assert.equal(await one('SELECT proacl::text v FROM pg_proc WHERE oid=$1::regprocedure', [signature]), acl);
  await c.query(migration);
  assert.deepEqual(await rpc(f.actor), {positioned: true, refusals24h: 0});
  report.checks.push('after/repeat: same confirmed source passes; function body and ACL unchanged');
  const other = await one('SELECT ws_test.actor() v');
  assert.deepEqual(await rpc(other), {positioned: false, refusals24h: 0});
  await c.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1', [f.draft]);
  assert.deepEqual(await rpc(f.actor), {positioned: false, refusals24h: 0});
  report.checks.push('deny: another actor and a revoked Runtime source never count as confirmed positioning');
  await c.query('UPDATE bill2_drafts SET revoked=false WHERE id=$1', [f.draft]);
  await c.query('UPDATE bill2_drafts SET revoked=true WHERE id=$1', [p.draft]);
  assert.deepEqual(await rpc(f.actor), {positioned: false, refusals24h: 0});
  report.checks.push('deny: revoked positioning draft still excludes the business');
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await one('SELECT has_function_privilege($1,$2,\'execute\') v', [role, signature]), false);
  }
  report.checks.push('anon/authenticated still have no direct EXECUTE privilege');
} catch (error) { report.failed = String(error.stack ?? error); process.exitCode = 1; }
finally { await db.close(); console.log(JSON.stringify(report, null, 2)); }
