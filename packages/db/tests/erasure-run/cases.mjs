/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc, fixture, call, evidence, closeAccount, outcome} from '../erasure-b2a/cases.mjs';
import {createFixture, claim} from '../payg/fixture.mjs';
export const scrub = (db, f) => rpc(db, 'account_erasure_scrub_run', f.actor, f.run);
export const row = async (db, f) => (await db.query('SELECT * FROM bill2_runs WHERE id=$1', [f.run])).rows[0];
const bodyFields = ['payload','scope','result','content_erased_at',
  'result_financial_projection_hash','result_financial_projection_version'];
const financial = value => Object.fromEntries(Object.entries(value).filter(([k]) => !bodyFields.includes(k)));
const ledger = async (db, f) => JSON.stringify((await db.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM bill2_calls c WHERE run_id=$1) calls,
  (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM credit_transactions c WHERE user_id=$2) ledger,
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM billing_history h WHERE user_id=$2) history,
  (SELECT credits FROM profiles WHERE id=$2) credits`, [f.run, f.actor])).rows);

export async function runCases(db, report) {
  for (const contract of ['v1','v2']) {
    const f = contract === 'v1' ? await fixture(db) : await createFixture(db);
    const c = contract === 'v1' ? await call(db, f) : await claim(db, f);
    const original = evidence(c, '0.001', {model: contract === 'v1' ? 'b2a-fixture' : f.claimPayload.model});
    for (const role of ['anon','authenticated']) {
      await db.query('SET ROLE ' + role);
      await assert.rejects(scrub(db, f), /permission denied/);
      await db.query('RESET ROLE');
    }
    await db.query('SET ROLE service_role');
    await assert.rejects(scrub(db, f), /ACCOUNT_ERASURE_NOT_CLOSED/);
    await assert.rejects(rpc(db, 'bill2_erasure_run_payload', f.payload), /permission denied/);
    await assert.rejects(db.query('UPDATE bill2_runs SET payload=payload WHERE id=$1', [f.run]), /permission denied/);
    await db.query('RESET ROLE');
    for (const status of ['disabled','banned','deleted']) {
      await db.query("UPDATE profiles SET status=$2,is_deleted='true' WHERE id=$1", [f.actor,status]);
      await assert.rejects(scrub(db, f), /ACCOUNT_ERASURE_NOT_CLOSED/);
    }
    await db.query("UPDATE profiles SET status='active',is_deleted='false' WHERE id=$1", [f.actor]);
    // Nested bodies cannot hitchhike under financial objects. Valid scalars remain byte-identical.
    await db.query(`UPDATE bill2_runs SET payload=payload || '{"extra":{"body":"PRIVATE_RUN"}}'::jsonb,
      scope=scope || '{"body":"PRIVATE_RUN"}'::jsonb WHERE id=$1`, [f.run]);
    await db.query(`UPDATE bill2_runs SET payload=jsonb_set(payload,'{rules}',
      payload->'rules' || '{"extra":{"body":"PRIVATE_RUN"}}') WHERE id=$1`, [f.run]);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,original);
    await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);
    await closeAccount(db,f);
    await assert.rejects(scrub(db,{...f,actor:randomUUID()}), /RUN_DENIED/);
    const before = await row(db,f), money = await ledger(db,f);
    await db.query('SET ROLE service_role');
    assert.deepEqual(await scrub(db,f), {processed:1,remaining:0});
    assert.deepEqual(await scrub(db,f), {processed:0,remaining:0});
    await db.query('RESET ROLE');
    const after = await row(db,f);
    assert.deepEqual(financial(after),financial(before));
    assert.equal(await ledger(db,f),money);
    assert.deepEqual(after.scope,{});
    assert.deepEqual({sourceHash:after.payload.sourceHash,originalHash:after.original_payload_hash},
      {sourceHash:undefined,originalHash:undefined},'content-derived fingerprints must not survive erasure');
    assert.deepEqual(after.payload,f.payload.input ? Object.fromEntries(Object.entries(f.payload)
      .filter(([key])=>!['input','scope','sessionRef','sourceHash'].includes(key))) : after.payload);
    assert.doesNotMatch(JSON.stringify(after),/PRIVATE_RUN|B2A_PRIVATE|PAYG_LOCAL_PRIVATE|evidenceRef"/);
    await assert.rejects(db.query('UPDATE bill2_runs SET payload=$2 WHERE id=$1',[f.run,before.payload]),/ERASURE_IMMUTABLE/);
    await assert.rejects(db.query('UPDATE bill2_runs SET scope=$2 WHERE id=$1',[f.run,before.scope]),/ERASURE_IMMUTABLE/);
    await assert.rejects(db.query('UPDATE bill2_runs SET result=$2 WHERE id=$1',[f.run,outcome]),/ERASURE_IMMUTABLE/);
    await assert.rejects(db.query('UPDATE bill2_runs SET content_erased_at=NULL WHERE id=$1',[f.run]),
      /ERASURE_IMMUTABLE/);
    await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);
    const settled = await rpc(db,'bill2_finalize',f.actor,f.run);
    assert.equal(settled.state,'settled');
    const settledMoney = await ledger(db,f);
    await rpc(db,'bill2_finalize',f.actor,f.run);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,original);
    assert.equal(await ledger(db,f),settledMoney);
    await assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,2,{}),/ACTOR_DENIED|RUN_DENIED/);
    report.checks.push(contract+': permissions, real closure, recursive projection, exact money, no content fingerprints, replay/finalize and refill denial');
  }
  const f = await fixture(db), c = await call(db,f);
  await closeAccount(db,f);
  assert.deepEqual(await scrub(db,f),{processed:0,remaining:1,reason:'call_set_open'});
  await rpc(db,'bill2_close',f.actor,f.run,'unknown',null);
  const before = await row(db,f), money = await ledger(db,f);
  assert.equal((await scrub(db,f)).processed,1);
  assert.equal(await ledger(db,f),money);
  assert.deepEqual(financial(await row(db,f)),financial(before));
  assert.equal((await rpc(db,'bill2_finalize',f.actor,f.run)).chargedCredits,null);
  await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c));
  await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);
  assert.equal((await rpc(db,'bill2_finalize',f.actor,f.run)).state,'settled');
  assert.doesNotMatch(JSON.stringify(await row(db,f)),/B2A_PRIVATE/);
  report.checks.push('open call set deferred; unknown retains hold; later receipt/close settles without body');

  const forex = await fixture(db), fc = await call(db,forex);
  await db.query(`UPDATE bill2_runs SET payload=jsonb_set(payload,'{rules,fx}',
    '{"EUR":{"version":"frozen-v1","usdPerUnit":"1.234500"}}') WHERE id=$1`,[forex.run]);
  await closeAccount(db,forex);
  await rpc(db,'bill2_close',forex.actor,forex.run,'unknown',null);
  await scrub(db,forex);
  await rpc(db,'bill2_record',forex.actor,forex.run,fc.id,evidence(fc,'0.001',{currency:'EUR'}));
  assert.equal((await row(db,forex)).payload.rules.fx.EUR.usdPerUnit,'1.234500');
  await rpc(db,'bill2_close',forex.actor,forex.run,'delivered',outcome);
  assert.equal((await rpc(db,'bill2_finalize',forex.actor,forex.run)).chargedCredits,2);
  report.checks.push('late non-USD observation uses exact original FX and original aggregate rounding');

  const failed = await fixture(db);
  const execution = (await db.query('SELECT b2a_test.bind($1) v',[failed])).rows[0].v;
  const failureCall = await call(db,failed);
  await rpc(db,'bill2_close',failed.actor,failed.run,'confirmed_failure',
    {...outcome,kind:'confirmed_delivery_failure'});
  await closeAccount(db,failed);
  await scrub(db,failed);
  assert.equal((await rpc(db,'bill2_finalize',failed.actor,failed.run)).state,'refunded');
  await rpc(db,'bill2_record',failed.actor,failed.run,failureCall.id,evidence(failureCall,'0.002'));
  assert.equal((await rpc(db,'bill2_finalize',failed.actor,failed.run)).chargedCredits,0);
  assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[failed.actor])).rows[0].credits,100);
  const sessionRef = (await row(db,failed)).session_ref;
  await rpc(db,'runtime_financial_recovery',failed.actor,execution,true);
  const runtimeScrub = await rpc(db,'account_erasure_scrub_runtime',failed.actor);
  assert.notEqual(runtimeScrub.retry,true);
  assert.equal((await row(db,failed)).session_ref,sessionRef,'session unlink remains separate');
  assert.ok((await db.query('SELECT erased_at FROM runtime_executions WHERE id=$1',[execution])).rows[0].erased_at);
  report.checks.push('original runtime recovery/B1b still works; refund once, late cost no re-debit; session binding unchanged');

  for (const contract of ['v1','v2']) {
    const seed = contract === 'v1' ? await fixture(db) : await createFixture(db);
    const payload = structuredClone(seed.payload);
    const identity = {provider:'fixture + version',account:'namespace + version',model:'model + version'};
    await db.query('UPDATE ai_models SET provider=$2,model_id=$3 WHERE id=$1',
      [payload.modelId,identity.provider,identity.model]);
    payload.modelId = payload.modelId.toUpperCase();
    payload.rules.version = '规则 + version';
    payload.rules.quoteVersion = 'quote + version';
    payload.callPolicy = payload.callPolicy.map(policy=>({...policy,...identity,modelId:payload.modelId}));
    const created = await rpc(db,'bill2_prepare',seed.actor,randomUUID(),payload);
    const accepted = {...seed,run:created.id,payload};
    await rpc(db,'bill2_close',accepted.actor,accepted.run,'unknown',null);
    await closeAccount(db,accepted);
    assert.deepEqual(await scrub(db,accepted),{processed:1,remaining:0});
    const projected = (await row(db,accepted)).payload;
    assert.equal(projected.rules.version,payload.rules.version);
    assert.equal(projected.rules.quoteVersion,payload.rules.quoteVersion);
    assert.deepEqual(projected.callPolicy,payload.callPolicy);
    assert.equal(projected.modelId,payload.modelId);
    assert.equal(projected.input,undefined);
  }
  report.checks.push('v1/v2 legitimately admitted free-form financial identifiers and uppercase UUIDs remain erasable');

  const malformed = await fixture(db);
  await rpc(db,'bill2_close',malformed.actor,malformed.run,'unknown',null);
  await closeAccount(db,malformed);
  await db.query(`UPDATE bill2_runs SET payload=jsonb_set(payload,'{rules,fx}',
    '{"USD":{"version":"v1","usdPerUnit":{"body":"PRIVATE_RUN"}}}'::jsonb) WHERE id=$1`,[malformed.run]);
  const old = await row(db,malformed);
  await assert.rejects(scrub(db,malformed),/INVALID_FINANCIAL_FIELD/);
  assert.deepEqual(await row(db,malformed),old);
  report.checks.push('malformed retained financial facts fail atomically without false completion');
}
