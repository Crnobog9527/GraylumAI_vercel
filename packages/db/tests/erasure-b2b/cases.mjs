/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc, fixture, call, evidence, closeAccount, outcome} from '../erasure-b2a/cases.mjs';
import {createFixture, claim} from '../payg/fixture.mjs';

const scrub = (db, f, limit = 100) => rpc(db, 'account_erasure_scrub_receipts', f.actor, f.run, limit);
const rows = async (db, f) => (await db.query(`SELECT x.* FROM bill2_receipts x
  JOIN bill2_calls c ON c.id=x.call_id WHERE c.run_id=$1 ORDER BY x.id`, [f.run])).rows;
const money = async (db, f) => JSON.stringify((await db.query(`SELECT
  (SELECT to_jsonb(r) FROM bill2_runs r WHERE id=$1) AS run,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM bill2_calls c WHERE run_id=$1) AS calls,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM credit_transactions t WHERE user_id=$2) AS ledger,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM billing_history h WHERE user_id=$2) AS history,
  (SELECT credits FROM profiles WHERE id=$2) AS credits`, [f.run, f.actor])).rows);

// Seed historical malformed evidence by owner INSERT in a disposable database.
// All immutable triggers remain enabled. The small UUID prefix exercises early-row starvation.
export async function seedHistoricalReceipt(db, c, overrides) {
  const id = '00000000-' + randomUUID().slice(9);
  return (await db.query(`INSERT INTO bill2_receipts(id,call_id,payload,payload_hash,conflict)
    VALUES($1,$2,$3::jsonb,encode(sha256(convert_to($3::jsonb::text,'utf8')),'hex'),true)
    RETURNING *`, [id, c.id, JSON.stringify(evidence(c, null, overrides))])).rows[0];
}

export async function receiptCases(db, report) {
  const f = await fixture(db);
  const c = await call(db, f);
  const raw = evidence(c);
  await rpc(db, 'bill2_record', f.actor, f.run, c.id, raw);
  const before = await rows(db, f);
  for (const role of ['anon', 'authenticated']) {
    await db.query('SET ROLE ' + role);
    await assert.rejects(scrub(db, f), /permission denied/);
    const visible = await db.query('SELECT payload FROM bill2_receipts WHERE id=$1', [before[0].id])
      .catch(error => { assert.match(error.message, /permission denied/); return {rows: []}; });
    assert.equal(visible.rows.length, 0, role + ' cannot read receipt evidence');
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(scrub(db, f), /ACCOUNT_ERASURE_NOT_CLOSED/);
  await assert.rejects(rpc(db, 'bill2_erasure_receipt_projection', {}, null), /permission denied/);
  await assert.rejects(db.query('UPDATE bill2_receipts SET payload=payload'), /permission denied/);
  await db.query('RESET ROLE');
  await assert.rejects(db.query('DELETE FROM bill2_receipts WHERE id=$1', [before[0].id]), /IMMUTABLE/);
  for (const status of ['disabled', 'banned', 'deleted']) {
    await db.query("UPDATE profiles SET status=$2,is_deleted='true' WHERE id=$1", [f.actor, status]);
    await assert.rejects(scrub(db, f), /ACCOUNT_ERASURE_NOT_CLOSED/);
  }
  await db.query("UPDATE profiles SET status='active',is_deleted='false' WHERE id=$1", [f.actor]);
  await closeAccount(db, f);
  await db.query('SET ROLE service_role');
  await assert.rejects(scrub(db, {...f, actor: randomUUID()}), /RUN_DENIED/);
  for (const limit of [0, 101, null]) await assert.rejects(scrub(db, f, limit), /BATCH_LIMIT_INVALID/);
  await db.query('RESET ROLE');
  // Even a privileged fixture cannot use the one-way allowance to change financial facts.
  await assert.rejects(db.query(`UPDATE bill2_receipts x SET conflict=NOT x.conflict,
    payload=bill2_erasure_receipt_projection(x.payload,c),financial_projection_version=1,
    financial_projection_hash=encode(sha256(convert_to(bill2_erasure_receipt_projection(x.payload,c)::text,'utf8')),'hex'),
    financial_projected_at=clock_timestamp() FROM bill2_calls c WHERE c.id=x.call_id AND x.id=$1`,
  [before[0].id]), /IMMUTABLE/);
  const originalMoney = await money(db, f);
  await db.query('SET ROLE service_role');
  assert.deepEqual(await scrub(db, f), {processed: 1, remaining: 0, manualReview: 0});
  assert.deepEqual(await scrub(db, f), {processed: 0, remaining: 0, manualReview: 0});
  await db.query('RESET ROLE');
  assert.equal(await money(db, f), originalMoney);
  const cleaned = (await rows(db, f))[0];
  assert.equal(cleaned.payload_hash, before[0].payload_hash);
  assert.notEqual(cleaned.payload_hash, cleaned.financial_projection_hash);
  assert.equal(cleaned.payload.cost, raw.cost);
  assert.equal(cleaned.payload.sourceHash, raw.sourceHash);
  assert.deepEqual(cleaned.payload.usage, {inputTokens: 10});
  assert.doesNotMatch(JSON.stringify(cleaned), /B2A_PRIVATE|QjJBX1|sdkResponse|rawBody|transport/);
  await assert.rejects(db.query('UPDATE bill2_receipts SET payload=$1 WHERE id=$2', [raw, cleaned.id]), /IMMUTABLE/);
  await assert.rejects(db.query('UPDATE bill2_receipts SET conflict=NOT conflict WHERE id=$1', [cleaned.id]), /IMMUTABLE/);
  await assert.rejects(db.query('DELETE FROM bill2_receipts WHERE id=$1', [cleaned.id]), /IMMUTABLE/);
  await rpc(db, 'bill2_record', f.actor, f.run, c.id, raw);
  assert.equal((await rows(db, f)).length, 1);
  await rpc(db, 'bill2_close', f.actor, f.run, 'delivered', outcome);
  assert.equal((await rpc(db, 'bill2_finalize', f.actor, f.run)).chargedCredits, 1);
  await rpc(db, 'bill2_record', f.actor, f.run, c.id, evidence(c, '0.0002'));
  assert.equal((await rpc(db, 'bill2_read', f.actor, f.run)).conflict, true);
  assert.equal((await rpc(db, 'bill2_finalize', f.actor, f.run)).chargedCredits, 1);
  report.checks.push('v1: role/actor/limit denial; no financial mutation; exact replay; no refill/delete; late conflict');

  const unknown = await fixture(db);
  const uc = await call(db, unknown);
  await rpc(db, 'bill2_record', unknown.actor, unknown.run, uc.id, evidence(uc, null, {providerId: null}));
  await closeAccount(db, unknown);
  await rpc(db, 'bill2_cancel', unknown.actor, unknown.run);
  const held = await money(db, unknown);
  assert.equal((await scrub(db, unknown)).processed, 1);
  assert.equal(await money(db, unknown), held);
  assert.equal(await rpc(db, 'bill2_recovery_claim', unknown.actor, unknown.run, uc.id), null);
  assert.equal((await rpc(db, 'bill2_finalize', unknown.actor, unknown.run)).chargedCredits, null);
  report.checks.push('unknown without ID retains original hold and unknown cost, no invented lookup/refund');

  const v2 = await createFixture(db);
  const vc = await claim(db, v2);
  const ve = evidence(vc, '0.001', {model: v2.claimPayload.model, usage: {inputTokens: 1000, sdkResponse: {body: 'PRIVATE'}}});
  await rpc(db, 'bill2_record', v2.actor, v2.run, vc.id, ve);
  await closeAccount(db, v2);
  const v2Money = await money(db, v2);
  assert.equal((await scrub(db, v2)).processed, 1);
  assert.equal(await money(db, v2), v2Money);
  await rpc(db, 'bill2_record', v2.actor, v2.run, vc.id, ve);
  assert.equal((await rows(db, v2)).length, 1);
  await rpc(db, 'bill2_close', v2.actor, v2.run, 'delivered', outcome);
  await rpc(db, 'bill2_finalize', v2.actor, v2.run);
  const v2Final = await money(db, v2);
  await rpc(db, 'bill2_finalize', v2.actor, v2.run);
  assert.equal(await money(db, v2), v2Final);
  report.checks.push('v2 original call hold and nominal accounting unchanged; finalization once');

  const batch = await fixture(db);
  const bc = await call(db, batch);
  for (let n = 0; n < 3; n++) await rpc(db, 'bill2_record', batch.actor, batch.run, bc.id,
    evidence(bc, '0.0001', {sourceHash: String(n).repeat(64)}));
  await closeAccount(db, batch);
  assert.deepEqual(await scrub(db, batch, 1), {processed: 1, remaining: 2, manualReview: 0});
  assert.deepEqual(await scrub(db, batch, 1), {processed: 1, remaining: 1, manualReview: 0});
  assert.deepEqual(await scrub(db, batch, 1), {processed: 1, remaining: 0, manualReview: 0});
  report.checks.push('bounded batches report remaining; repeated progress converges');

  for (const contract of ['v1', 'v2']) {
    const mixed = contract === 'v1' ? await fixture(db) : await createFixture(db);
    const mixedCall = contract === 'v1' ? await call(db, mixed) : await claim(db, mixed);
    const model = contract === 'v1' ? 'b2a-fixture' : mixed.claimPayload.model;
    for (const sourceHash of ['a'.repeat(64), 'b'.repeat(64)]) {
      await rpc(db, 'bill2_record', mixed.actor, mixed.run, mixedCall.id,
        evidence(mixedCall, '0.0001', {model, sourceHash}));
    }
    const rejected = [];
    for (const invalid of [
      {provider: 'unexpected-provider'}, {account: 'unexpected-namespace'},
      {protocol: {body: 'B2B_PRIVATE_REJECTED'}}, {currency: 'invalid-currency'},
      {observedAt: 'not-a-date'}, {observedAt: '2026-99-99'},
      {cost: 'invalid-cost'}, {includedDetails: {}}, {source: 'unknown-source'},
    ]) rejected.push(await seedHistoricalReceipt(db, mixedCall, {model, ...invalid}));
    await closeAccount(db, mixed);
    const beforeMoney = await money(db, mixed);
    const count = rejected.length;
    await db.query('SET ROLE service_role');
    const first = await scrub(db, mixed, 1);
    const second = await scrub(db, mixed, 1);
    const repeated = await scrub(db, mixed, 1);
    await db.query('RESET ROLE');
    assert.deepEqual(first, {processed: 1, remaining: count + 1, manualReview: count});
    assert.deepEqual(second, {processed: 1, remaining: count, manualReview: count});
    assert.deepEqual(repeated, {processed: 0, remaining: count, manualReview: count});
    assert.equal(await money(db, mixed), beforeMoney, 'all original financial facts remain unchanged');
    const after = await rows(db, mixed);
    for (const original of rejected) {
      assert.deepEqual(after.find(row => row.id === original.id), original,
        'untrusted evidence is neither rewritten nor reported as erased');
    }
    const projectedRows = after.filter(row => row.financial_projection_version !== null);
    assert.equal(projectedRows.length, 2);
    assert.doesNotMatch(JSON.stringify(projectedRows), /B2A_PRIVATE|sdkResponse|rawBody/);
    for (const role of ['anon', 'authenticated']) {
      await db.query('SET ROLE ' + role);
      const visible = await db.query('SELECT payload FROM bill2_receipts WHERE id=$1', [rejected[0].id])
        .catch(error => { assert.match(error.message, /permission denied/); return {rows: []}; });
      assert.equal(visible.rows.length, 0);
      await db.query('RESET ROLE');
    }
    report.checks.push(contract + ': early untrusted/invalid rows do not starve valid batches; remaining/manualReview persist; evidence/money unchanged');
  }
  const atomic = await fixture(db);
  const ac = await call(db, atomic);
  for (let n = 0; n < 2; n++) await rpc(db, 'bill2_record', atomic.actor, atomic.run, ac.id,
    evidence(ac, '0.0001', {sourceHash: String(n).repeat(64)}));
  await closeAccount(db, atomic);
  const atomicRows = await rows(db, atomic);
  await db.query(`CREATE FUNCTION b2b_injected_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id::text = TG_ARGV[0] THEN RAISE EXCEPTION 'B2B_INJECTED_FAULT'; END IF; RETURN NEW; END $$`);
  // UUID comes only from our local synthetic fixture. Trigger keeps all real guards enabled.
  await db.query(`CREATE TRIGGER b2b_injected_fault AFTER UPDATE ON bill2_receipts
    FOR EACH ROW EXECUTE FUNCTION b2b_injected_fault('${atomicRows[1].id}')`);
  try {
    await assert.rejects(scrub(db, atomic), /B2B_INJECTED_FAULT/);
    assert.deepEqual(await rows(db, atomic), atomicRows, 'first update rolls back when second fails');
  } finally {
    await db.query('DROP TRIGGER b2b_injected_fault ON bill2_receipts; DROP FUNCTION b2b_injected_fault()');
  }
  assert.equal((await scrub(db, atomic)).processed, 2);
  report.checks.push('unexpected second-row write failure rolls back first-row cleanup');
}
