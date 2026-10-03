/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

export const financial = async (db,f) => (await db.query(`
  SELECT p.credits,
    (SELECT coalesce(sum(amount),0)::int FROM credit_transactions WHERE user_id=p.id) ledger,
    r.charged AS charged_credits, r.theoretical_credits, r.platform_absorbed_credits,
    r.nominal_cost_usd, r.weighted_nominal_usd
  FROM profiles p JOIN bill2_runs r ON r.actor_id=p.id WHERE r.id=$1`,[f.run])).rows[0];
export async function conserved(db,f) {
  const v = await financial(db,f);
  assert.equal(v.credits,v.ledger);
  assert.ok(v.credits>=0);
  assert.equal(Number(v.charged_credits??0)+Number(v.platform_absorbed_credits),Number(v.theoretical_credits));
  return v;
}

export async function coreCases(db,report,createFixture,claim,receipt) {
  for (const role of ['anon','authenticated']) {
    await db.query('SET ROLE '+role);
    await assert.rejects(db.query("SELECT * FROM bill2_admin_call_report(now()-interval '1 day',now()+interval '1 day',100)"),/permission denied/);
    await assert.rejects(db.query("SELECT * FROM bill2_payg_absorb_report(now()-interval '1 day',now()+interval '1 day')"),/permission denied/);
    await db.query('RESET ROLE');
  }
  await db.query('SET ROLE service_role');
  await assert.rejects(db.query("SELECT bill2_payg_prices('{}'::jsonb,0::bigint)"),/permission denied/);
  await db.query('RESET ROLE');
  report.checks.push('anon/authenticated denied both finance reports; service_role denied private PAYG price helper');

  const f = await createFixture(db);
  assert.equal((await financial(db,f)).credits,100,'v2 prepare reserves nothing');
  assert.equal((await db.query('SELECT pre_deduct_id,reserved FROM bill2_runs WHERE id=$1',[f.run])).rows[0].pre_deduct_id,null);
  for (let n=1;n<=3;n++) {
    const c = await claim(db,f,n,true);
    await receipt(db,f,c,'0.0001',{inputTokens:100,outputTokens:0});
    await conserved(db,f);
  }
  assert.equal(Number((await financial(db,f)).charged_credits),1,'three 0.1-credit calls round once');
  assert.equal((await financial(db,f)).credits,99);
  report.checks.push('v2 zero run reserve; three micro nominal costs aggregate to one credit; wallet and C+E=N each call');

  const capped = await createFixture(db,{credits:2,threshold:1});
  const c = await claim(db,capped,1,true);
  const frozen = (await db.query('SELECT reserved_credits,available_credits FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
  assert.equal(frozen.reserved_credits,2,'H=min(G,A)');
  assert.equal(frozen.available_credits,2);
  await receipt(db,capped,c,'0.005',{inputTokens:5000,outputTokens:0});
  const result = await conserved(db,capped);
  assert.equal(Number(result.charged_credits),2);
  assert.equal(Number(result.theoretical_credits),5);
  assert.equal(Number(result.platform_absorbed_credits),3);
  assert.equal((await db.query('SELECT conflict FROM bill2_runs WHERE id=$1',[capped.run])).rows[0].conflict,false);
  await db.query('SET ROLE service_role');
  const projection = (await db.query(`SELECT * FROM bill2_admin_call_report(
    now()-interval '1 day',now()+interval '1 day',5000) WHERE call_id=$1`,[c.id])).rows[0];
  const absorbed = (await db.query(`SELECT * FROM bill2_payg_absorb_report(
    now()-interval '1 day',now()+interval '1 day') WHERE model=$1`,[capped.claimPayload.model])).rows[0];
  await db.query('RESET ROLE');
  assert.equal(Number(projection.charged_delta),2);
  assert.equal(Number(projection.theoretical_delta),5);
  assert.equal(Number(projection.platform_absorbed_cap_credits),3);
  assert.equal(Number(projection.platform_absorbed_bound_credits),0);
  assert.equal(Number(projection.platform_absorbed_cap_usd),0.003);
  assert.equal(Number(absorbed.platform_cap_credits),3);
  assert.equal(Number(projection.selected_cost_usd)+Number(projection.platform_margin_usd),Number(projection.nominal_cost_usd));
  report.checks.push('service financial projection and UTC-day absorption show C+E=N and actual+margin=nominal');
  const rows = (await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[capped.actor])).rows;
  await receipt(db,capped,c,'0.005',{inputTokens:5000,outputTokens:0});
  await rpc(db,'bill2_finalize',capped.actor,capped.run);
  assert.deepEqual((await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[capped.actor])).rows,rows);
  report.checks.push('A<G but A>=L dispatches; charge capped at hold, normal cap never conflict; duplicate receipt/finalize no second charge');

  for (const credits of [2,3,4]) {
    const edge = await createFixture(db,{credits,threshold:3});
    if (credits<3) {
      const waiting = await claim(db,edge,1,false);
      assert.equal(waiting.state,'waiting_credits');
      assert.equal(waiting.id,null);
      assert.equal((await financial(db,edge)).credits,credits);
      assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[edge.run])).rows[0].n,0);
    } else {
      const claimed = await claim(db,edge,1,false);
      assert.ok(claimed.id);
    }
  }
  report.checks.push('start threshold L-1/L/L+1; refusal leaves no call or hold');

  const unknown = await createFixture(db);
  const uc = await claim(db,unknown,1,true);
  const held = (await financial(db,unknown)).credits;
  await receipt(db,unknown,uc,null);
  await rpc(db,'bill2_cancel',unknown.actor,unknown.run);
  assert.equal((await rpc(db,'bill2_finalize',unknown.actor,unknown.run)).state,'cost_pending');
  assert.equal((await financial(db,unknown)).credits,held);
  report.checks.push('unknown cost on cancellation retains hold and remains cost_pending');

  const fallback = await createFixture(db,{lookupSupported:false});
  const fc = await claim(db,fallback,1,true);
  await receipt(db,fallback,fc,'0.003',{});
  const settled = (await db.query('SELECT * FROM bill2_calls WHERE id=$1',[fc.id])).rows[0];
  assert.equal(settled.nominal_source,'actual_fallback');
  assert.equal(Number(settled.charged_delta),3);
  const before = await financial(db,fallback);
  await receipt(db,fallback,fc,'0.003',{inputTokens:100,outputTokens:0});
  assert.deepEqual(await financial(db,fallback),before,'late nominal evidence cannot reprice fallback');
  report.checks.push('no-lookup missing token actual_fallback; late complete tokens never reprice settled call');

  const lookup = await createFixture(db,{lookupSupported:true});
  const lc = await claim(db,lookup,1,true);
  await receipt(db,lookup,lc,'0.003',{});
  assert.equal((await db.query('SELECT settled_at FROM bill2_calls WHERE id=$1',[lc.id])).rows[0].settled_at,null);
  for (let i=0;i<3;i++) {
    assert.ok(await rpc(db,'bill2_recovery_claim',lookup.actor,lookup.run,lc.id));
    await rpc(db,'bill2_finalize',lookup.actor,lookup.run);
    if(i<2) assert.equal((await db.query('SELECT settled_at FROM bill2_calls WHERE id=$1',[lc.id])).rows[0].settled_at,null);
  }
  assert.equal((await db.query('SELECT nominal_source FROM bill2_calls WHERE id=$1',[lc.id])).rows[0].nominal_source,'actual_fallback');
  assert.equal(await rpc(db,'bill2_recovery_claim',lookup.actor,lookup.run,lc.id),null);
  assert.equal(Number((await financial(db,lookup)).charged_credits),3);
  report.checks.push('missing tokens retain hold during three bounded lookups; exhausted lookup falls back exactly once');

  const failure = await createFixture(db);
  const complete = await claim(db,failure,1,true);
  await receipt(db,failure,complete,'0.003',{inputTokens:3000,outputTokens:0});
  const unfinished = await claim(db,failure,2,true);
  await receipt(db,failure,unfinished,null);
  await rpc(db,'bill2_close',failure.actor,failure.run,'confirmed_failure',{
    kind:'confirmed_delivery_failure',evidenceRef:'local-proof',evidenceHash:'d'.repeat(64),body:'local proof',
  });
  const failedRun = await rpc(db,'bill2_finalize',failure.actor,failure.run);
  assert.equal(failedRun.state,'refunded');
  assert.equal(failedRun.netChargedCredits,0);
  assert.equal((await financial(db,failure)).credits,100);
  assert.equal(Number((await financial(db,failure)).charged_credits),3,'gross charge remains immutable');
  const compensated = (await db.query('SELECT compensation_credits,compensated_at FROM bill2_calls WHERE id=$1',[complete.id])).rows[0];
  assert.equal(compensated.compensation_credits,3);
  assert.ok(compensated.compensated_at);
  const compensatedRows = (await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[failure.actor])).rows;
  await rpc(db,'bill2_finalize',failure.actor,failure.run);
  await receipt(db,failure,unfinished,'0.005',{inputTokens:5000,outputTokens:0});
  assert.deepEqual((await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[failure.actor])).rows,compensatedRows);
  await conserved(db,failure);
  report.checks.push('confirmed failure compensates settled prefix and refunds unknown suffix once; late receipt never re-debits');

  // Normal claim is serial. Seed a hypothetical pre-existing two-call snapshot to verify
  // recovery ordering independently of the admission guard, then roll the fixture back.
  await db.query('BEGIN');
  try {
    const prefix=await createFixture(db);
    const original=await claim(db,prefix,1,true);
    await receipt(db,prefix,original,null);
    const alternate=await rpc(db,'bill2_prepare',prefix.actor,randomUUID(),prefix.payload);
    const af={...prefix,run:alternate.id};
    const later=await claim(db,af,1,true);
    await db.query('UPDATE bill2_calls SET run_id=$1,sequence=2 WHERE id=$2',[prefix.run,later.id]);
    const before=(await financial(db,prefix)).credits;
    await receipt(db,prefix,later,'0.0005',{inputTokens:500,outputTokens:0});
    assert.equal((await db.query('SELECT settled_at FROM bill2_calls WHERE id=$1',[later.id])).rows[0].settled_at,null);
    assert.equal((await financial(db,prefix)).credits,before);
    await receipt(db,prefix,original,'0.0005',{inputTokens:500,outputTokens:0});
    assert.equal(Number((await financial(db,prefix)).charged_credits),1);
    assert.equal((await financial(db,prefix)).credits,99);
  } finally {await db.query('ROLLBACK');}
  report.checks.push('pre-existing known suffix cannot settle across unknown prefix; resolved prefix then settles cumulative order once');

  const prepared = await createFixture(db);
  await claim(db,prepared,1,false);
  await rpc(db,'bill2_cancel',prepared.actor,prepared.run);
  await rpc(db,'bill2_finalize',prepared.actor,prepared.run);
  assert.equal((await financial(db,prepared)).credits,100);
  const once = (await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[prepared.actor])).rows;
  await rpc(db,'bill2_finalize',prepared.actor,prepared.run);
  assert.deepEqual((await db.query('SELECT * FROM credit_transactions WHERE user_id=$1 ORDER BY id',[prepared.actor])).rows,once);
  report.checks.push('prepared cancellation releases one hold exactly once');
}
