/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';

const rpc = async (db, name, ...args) =>
  (await db.query(`SELECT public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) v`, args)).rows[0].v;
const fixture = async (db, { weighted, q, runM, modelM, upper = '0.02', maxCalls = 4, unitQ = null }) =>
  (await db.query('SELECT bill_unit_test.fixture($1,$2,$3,$4,$5,$6,$7) v', [weighted, q, runM, modelM, upper, maxCalls, unitQ])).rows[0].v;

function callPayload(f, index, overrides = {}) {
  const model = f.models[index];
  return {
    provider: 'fixture', account: 'sandbox', model: model.model, protocol: 'fixture-cost-v1', phase: 'reply',
    requestHash: 'b'.repeat(64), upperUsd: '0.005', inputLimit: 1000, outputLimit: 1000,
    automaticRetry: false, hiddenTools: false, lookupSupported: true, ...overrides,
  };
}
const unit = (f, index, multiplier = f.models[index].multiplier) =>
  ({ billingUnit: { modelId: f.models[index].id, multiplier, source: 'model' } }); // the exact TS call shape

async function claim(db, f, sequence, payload) {
  const c = await rpc(db, 'bill2_claim', f.actor, f.run, sequence, payload);
  assert.equal((await rpc(db, 'bill2_dispatch', f.actor, f.run, c.id, c.dispatchToken)).dispatch, true);
  return c;
}
const evidence = (c, model, cost) => ({
  provider: 'fixture', account: 'sandbox', model, protocol: 'fixture-cost-v1', providerId: 'generation-' + c.id,
  source: 'response', sourceHash: 'c'.repeat(64), observedAt: '2026-10-02T00:00:00.000Z', coverage: 'request_total',
  final: true, cost, currency: 'USD', usage: { inputTokens: 10 },
});
const outcome = { kind: 'usable_result', evidenceRef: 'fixture', evidenceHash: 'd'.repeat(64) };

async function settle(db, f, calls) {
  const claimed = [];
  for (const [index, { payload, cost }] of calls.entries()) {
    const c = await claim(db, f, index + 1, payload);
    await rpc(db, 'bill2_record', f.actor, f.run, c.id, evidence(c, payload.model, cost));
    claimed.push(c);
  }
  await rpc(db, 'bill2_close', f.actor, f.run, 'delivered', outcome);
  return rpc(db, 'bill2_finalize', f.actor, f.run);
}

async function rejects(promise, pattern, message) {
  await assert.rejects(promise, pattern, message);
}

export async function cases(db, report) {
  // Old contract: unchanged ceil(Σcost × q × m) with one run-level multiplier.
  const v1 = await fixture(db, { weighted: false, q: '1000', runM: '1.5', modelM: ['1.5'] });
  const v1Result = await settle(db, v1, [
    { payload: callPayload(v1, 0), cost: '0.0001' }, { payload: callPayload(v1, 0), cost: '0.0001' },
  ]);
  assert.equal(v1Result.chargedCredits, 1, 'old contract: ceil(0.0002 × 1000 × 1.5) = 1');
  const v1b = await fixture(db, { weighted: false, q: '1000', runM: '1.5', modelM: ['1.5'] });
  assert.equal((await settle(db, v1b, [{ payload: callPayload(v1b, 0), cost: '0.0021' }])).chargedCredits, 4,
    'old contract: ceil(0.0021 × 1500) = 4');
  report.checks.push('old contract (no billingUnit) charges ceil(Σcost × q × m) exactly as before');

  // New contract, mixed multipliers: ceil(100 × (0.002 × 2 + 0.002 × 3)) = 1; per-call ceil would be 2.
  const mixed = await fixture(db, { weighted: true, q: '100', runM: '3', modelM: ['2', '3'] });
  const mixedResult = await settle(db, mixed, [
    { payload: { ...callPayload(mixed, 0), ...unit(mixed, 0) }, cost: '0.002' },
    { payload: { ...callPayload(mixed, 1), ...unit(mixed, 1) }, cost: '0.002' },
  ]);
  assert.equal(mixedResult.chargedCredits, 1, 'new contract rounds once over Σ(cost × m_i)');
  const replay = await rpc(db, 'bill2_finalize', mixed.actor, mixed.run);
  assert.equal(replay.chargedCredits, 1, 'finalize replay is idempotent');
  // Same costs under one uniform m=3 would charge 2: the per-call multiplier really is used.
  const uniform = await fixture(db, { weighted: true, q: '100', runM: '3', modelM: ['3', '3'] });
  assert.equal((await settle(db, uniform, [
    { payload: { ...callPayload(uniform, 0), ...unit(uniform, 0) }, cost: '0.002' },
    { payload: { ...callPayload(uniform, 1), ...unit(uniform, 1) }, cost: '0.002' },
  ])).chargedCredits, 2);
  report.checks.push('new contract charges ceil(q × Σ(cost_i × m_i)) once: mixed 2/3 → 1, uniform 3 → 2; replay idempotent');

  // Tampering with the frozen per-call multiplier or identity is refused before any call row exists.
  const t = await fixture(db, { weighted: true, q: '100', runM: '3', modelM: ['2', '3'] });
  const base = callPayload(t, 0);
  await rejects(rpc(db, 'bill2_claim', t.actor, t.run, 1, { ...base, ...unit(t, 0, '1') }), /BILL2_CALL_BUDGET_OR_CONTRACT/,
    'a cheaper multiplier than the frozen policy is refused');
  await rejects(rpc(db, 'bill2_claim', t.actor, t.run, 1, { ...base, ...unit(t, 0, '3') }), /BILL2_CALL_BUDGET_OR_CONTRACT/,
    'another model\'s multiplier is refused');
  await rejects(rpc(db, 'bill2_claim', t.actor, t.run, 1, base), /BILL2_UNIT_MULTIPLIER_INVALID/, 'missing billingUnit');
  await rejects(rpc(db, 'bill2_claim', t.actor, t.run, 1, { ...base, ...unit(t, 0, '0') }), /BILL2_UNIT_MULTIPLIER_INVALID/);
  await rejects(rpc(db, 'bill2_claim', t.actor, t.run, 1, { ...base, ...unit(t, 0, '2.000') }), /BILL2_UNIT_MULTIPLIER_INVALID/);
  await rejects(rpc(db, 'bill2_claim', t.actor, t.run, 1,
    { ...base, billingUnit: { ...unit(t, 0).billingUnit, modelId: t.models[1].id } }), /BILL2_CALL_BUDGET_OR_CONTRACT/,
    'modelId must be the policy entry\'s own');
  assert.equal(Number((await db.query('SELECT count(*) c FROM bill2_calls WHERE run_id=$1', [t.run])).rows[0].c), 0);
  report.checks.push('claim refuses changed, foreign, missing, invalid or over-precise per-call multipliers');

  // Weighted reservation at the exact boundary: reserved = ceil(0.01 × 100 × 3) = 3 and two calls of
  // upper 0.005 at m=3 use exactly 3. (prepare's ceil(b × q × max m) ≤ reserved makes the weighted check a
  // second guard; it cannot be exceeded without breaking the policy or budget checks first.)
  const tight = await fixture(db, { weighted: true, q: '100', runM: '3', modelM: ['3'], upper: '0.005', maxCalls: 2 });
  assert.equal(tight.reserved, 3);
  await claim(db, tight, 1, { ...callPayload(tight, 0), ...unit(tight, 0) });
  await claim(db, tight, 2, { ...callPayload(tight, 0), ...unit(tight, 0) });
  report.checks.push('claim admits weighted upper bounds up to the run reservation');

  // rules.billingUnit must agree with the run's q, and m_i may not exceed the run's (maximum) multiplier.
  const mismatch = await fixture(db, { weighted: true, q: '100', runM: '2', modelM: ['3'] });
  await rejects(rpc(db, 'bill2_claim', mismatch.actor, mismatch.run, 1, { ...callPayload(mismatch, 0), ...unit(mismatch, 0) }),
    /BILL2_CALL_BUDGET_OR_CONTRACT/, 'm_i above the run multiplier used for the reservation');
  const qDiffers = await fixture(db, { weighted: true, q: '100', runM: '3', modelM: ['3'], unitQ: '1000' });
  await rejects(rpc(db, 'bill2_claim', qDiffers.actor, qDiffers.run, 1, { ...callPayload(qDiffers, 0), ...unit(qDiffers, 0) }),
    /BILL2_CALL_BUDGET_OR_CONTRACT/, 'rules.billingUnit.creditsPerUsd must equal the run q');
  report.checks.push('claim refuses m_i above the run reservation multiplier and a billingUnit q that differs from the run q');

  // Finalize marks a conflict and charges nothing when q × Σ(cost × m_i) exceeds the reservation.
  // Admission bounds make this unreachable with honest costs, so the recorded cost is raised directly here.
  const over = await fixture(db, { weighted: true, q: '100', runM: '3', modelM: ['3'], upper: '0.005', maxCalls: 1 });
  const overCall = await claim(db, over, 1, { ...callPayload(over, 0), ...unit(over, 0) });
  await rpc(db, 'bill2_record', over.actor, over.run, overCall.id, evidence(overCall, over.models[0].model, '0.005'));
  await rpc(db, 'bill2_close', over.actor, over.run, 'delivered', outcome);
  await db.query('UPDATE bill2_calls SET selected_cost_usd = 0.01 WHERE id = $1', [overCall.id]);
  const conflicted = await rpc(db, 'bill2_finalize', over.actor, over.run);
  assert.equal(conflicted.conflict, true, 'ceil(100 × 0.01 × 3) = 3 > reserved 2 → conflict');
  assert.equal(conflicted.chargedCredits, null);
  const runRow = (await db.query('SELECT state, charged, conflict FROM bill2_runs WHERE id = $1', [over.run])).rows[0];
  assert.deepEqual([runRow.charged, runRow.conflict], [null, true]);
  report.checks.push('new-contract finalize above the reservation marks a conflict and charges nothing');

  // The report function sees the frozen multiplier and returns numbers as text.
  await db.query('SET ROLE service_role');
  const rows = (await db.query(`SELECT model, selected_cost_usd, run_multiplier, call_multiplier
    FROM public.bill2_admin_call_report(now() - interval '1 hour', now() + interval '1 hour', 5000) WHERE run_id = $1
    ORDER BY call_sequence`, [mixed.run])).rows;
  await db.query('RESET ROLE');
  assert.deepEqual(rows.map((r) => [r.selected_cost_usd, r.run_multiplier, r.call_multiplier]), [['0.002', '3', '2'], ['0.002', '3', '3']]);
  for (const role of ['anon', 'authenticated']) {
    await db.query('SET ROLE ' + role);
    await rejects(db.query(`SELECT * FROM public.bill2_admin_call_report(now() - interval '1 hour', now(), 10)`), /permission denied/);
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await rejects(db.query(`SELECT public.bill2_unit_multiplier('"2"')`), /permission denied/);
  await rejects(db.query('SELECT count(*) FROM public.bill2_calls'), /permission denied/);
  await db.query('RESET ROLE');
  report.checks.push('report returns frozen m_i and text numbers to service_role only; helper and tables stay private');

  // ai_models.price_multiplier: CHECK boundaries, no rounding, no client column access.
  const model = mixed.models[0].id;
  for (const ok of [null, '1', '1.5', '19.99', '20', '20.00']) {
    await db.query('UPDATE ai_models SET price_multiplier=$2 WHERE id=$1', [model, ok]);
  }
  for (const bad of ['0', '0.99', '-1', '20.01', '21', '1.234', '3.100']) {
    await rejects(db.query('UPDATE ai_models SET price_multiplier=$2 WHERE id=$1', [model, bad]), /ai_models_price_multiplier_check/, bad);
  }
  await db.query('UPDATE ai_models SET price_multiplier=NULL WHERE id=$1', [model]);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`SELECT has_column_privilege('${role}','public.ai_models','price_multiplier','SELECT') v`)).rows[0].v, false);
    assert.equal((await db.query(`SELECT has_column_privilege('${role}','public.ai_models','price_multiplier','UPDATE') v`)).rows[0].v, false);
  }
  report.checks.push('price_multiplier CHECK accepts NULL/1..20 (≤2 decimals) and rejects the rest; no client column privilege');
}
