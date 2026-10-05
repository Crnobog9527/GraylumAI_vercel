/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture, claim, receipt } from '../payg/fixture.mjs';
import { fixture, call, evidence, rpc, closeAccount } from '../erasure-b2a/cases.mjs';
const view = (db, f) => rpc(db, 'runtime_view', f.actor, f.session);
const row = async (db, f) => {
  const item = (await view(db, f)).executions.find(e => e.executionId === f.execution);
  const { expected } = (await db.query(`SELECT coalesce((b.paused_reason='user_stop' AND NOT b.cancel_requested
    AND e.result IS NULL AND runtime_history_available(e.id)
    AND NOT bill2_erasure_closed(b.actor_id,coalesce(b.pre_deduct_id,b.id))),false) expected
    FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.id=$1`, [f.execution])).rows[0];
  assert.equal(item.userStopPending, expected, 'batched projection equals the 0171 predicate');
  return item;
};
const stop = (db, f) => rpc(db, 'runtime_execution', f.actor, f.execution, 'stop', { stopAt: 2, source: 'assistant' });
async function setup(db, version) {
  const f = version === 'bill2.v1' ? await fixture(db) : await createFixture(db);
  const session = await rpc(db, 'runtime_start', f.actor, randomUUID(), { scope: f.payload.scope });
  const context = { version: 'runtime.v1', sdkVersion: '0.18.0', role: 'ordinary', input: 'synthetic input',
    instructions: 'Answer', model: f.payload.callPolicy[0].model, modelId: f.payload.modelId,
    maxOutputTokens: 1000, maxTurns: 1, historyItems: 0, tools: [], network: 'deny',
    nativeOutput: 'native-output-v1', providerRequestFormat: 'agent-turn-v5-stream' };
  const admitted = await rpc(db, 'runtime_admit', f.actor, session.sessionId, randomUUID(),
    context, { ...f.payload, input: context });
  const begin = await rpc(db, 'runtime_execution', f.actor, admitted.executionId, 'begin', null);
  return { ...f, run: admitted.runId, execution: admitted.executionId, session: session.sessionId,
    version, epoch: begin.epoch };
}
const facts = async (db, f) => (await db.query(`SELECT to_jsonb(e) execution,to_jsonb(b) billing,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.revision) FROM runtime_session_history h WHERE h.execution_id=e.id) history,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM credit_transactions t WHERE t.user_id=e.actor_id) ledger
  FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.id=$1`, [f.execution])).rows[0];


export { setup, view, stop, facts };
export async function stopViewCase(db, version) {
  const f = await setup(db, version);
  const c = version === 'bill2.v1' ? await call(db, f) : await claim(db, f);
  await stop(db, f);
  assert.equal((await row(db, f)).userStopPending, true, version + ' stopped history must expose pending intent');
  if (version === 'bill2.v1') assert.equal('pausedReason' in (await row(db, f)).billing, false);
  const snapshot = await facts(db, f);
  assert.deepEqual(await view(db, f), await view(db, f), 'refresh remains stable');
  assert.deepEqual(await facts(db, f), snapshot, 'reading does not write billing or history');
  if (version === 'bill2.v1') await rpc(db, 'bill2_record', f.actor, f.run, c.id, evidence(c));
  else await receipt(db, f, c);
  const result = { kind: 'usable_result', body: JSON.stringify({ message: 'ok' }), stopped: true,
    completeness: 'stopped', evidenceRef: 'synthetic-stop-view', evidenceHash: 'a'.repeat(64) };
  await rpc(db, 'runtime_execution', f.actor, f.execution, 'complete',
    version === 'bill2.v2' ? { epoch: f.epoch, value: result } : result);
  assert.equal((await row(db, f)).userStopPending, false);
  assert.equal((await row(db, f)).stopped, true, 'existing saved-result marker retained');
  assert.ok((await row(db, f)).body);

  const cancelled = await setup(db, version);
  await stop(db, cancelled);
  assert.equal((await row(db, cancelled)).userStopPending, true);
  await rpc(db, 'runtime_cancel', cancelled.actor, cancelled.execution);
  assert.equal((await row(db, cancelled)).userStopPending, false);

  const pending = await setup(db, version);
  assert.equal((await row(db, pending)).userStopPending, false, 'ordinary unfinished turn');
  await stop(db, pending);
  const baseline = await row(db, pending);
  assert.equal(baseline.userStopPending, true);
  for (const reason of [null, 'http_budget', 'insufficient_credits']) {
    await db.query('BEGIN');
    await db.query('UPDATE bill2_runs SET paused_reason=$2 WHERE id=$1', [pending.run, reason]);
    assert.equal((await row(db, pending)).userStopPending, false);
    await db.query('ROLLBACK');
  }
  await db.query('BEGIN');
  await db.query("UPDATE runtime_executions SET unavailable_reason='source_revoked' WHERE id=$1", [pending.execution]);
  assert.equal((await row(db, pending)).userStopPending, false);
  assert.equal((await row(db, pending)).contentAvailable, false);
  await db.query('ROLLBACK');
  await db.query('SET ROLE service_role');
  assert.equal((await view(db, pending)).executions[0].userStopPending, true);
  await assert.rejects(view(db, { ...pending, actor: f.actor }), /RUNTIME_SCOPE_DENIED/);
  await db.query('RESET ROLE');
  for (const role of ['anon', 'authenticated']) {
    await db.query('SET ROLE ' + role);
    await assert.rejects(view(db, pending), /permission denied/);
    await db.query('RESET ROLE');
  }
  const erased = await setup(db, version);
  await stop(db, erased);
  await closeAccount(db, erased);
  await assert.rejects(view(db, erased), /BILL2_ACTOR_DENIED|ACCOUNT_CLOSED/);
}
