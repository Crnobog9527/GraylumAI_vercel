/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

// Real staging-test contracts, synthetic SQL receipts only; never instantiate a provider transport.
export async function monitorCases(db,report,createFixture,claim,receipt) {
  for (const margins of [{templateTokens:4096,marginTokens:4096},{templateTokens:0,marginTokens:0}]) {
    for (const prompt of [79,80]) {
      const f=await createFixture(db,{empirical:true,bytes:100,...margins});
      const c=await claim(db,f,1,true);
      await receipt(db,f,c,'0.00001',{inputTokens:prompt,outputTokens:0});
      assert.equal((await db.query('SELECT metering_exit FROM bill2_calls WHERE id=$1',[c.id])).rows[0].metering_exit,prompt===80);
      if(prompt===80) {
        await assert.rejects(async()=>{
          const again=await rpc(db,'bill2_prepare',f.actor,randomUUID(),f.payload);
          await rpc(db,'bill2_claim',f.actor,again.id,1,f.claimPayload);
        },/METERING_BLOCKED|POLICY_DENIED|MODEL_DENIED/);
      } else {
        const again=await rpc(db,'bill2_prepare',f.actor,randomUUID(),f.payload);
        assert.ok((await rpc(db,'bill2_claim',f.actor,again.id,1,f.claimPayload)).id);
      }
    }
  }
  const unknown=await createFixture(db,{empirical:true,lookupSupported:false});
  const c=await claim(db,unknown,1,true);
  await receipt(db,unknown,c,'0.001',{});
  const state=(await db.query('SELECT nominal_source,metering_missing FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
  assert.equal(state.nominal_source,'actual_fallback');
  assert.equal(state.metering_missing,true);
  await assert.rejects(async()=>{
    const again=await rpc(db,'bill2_prepare',unknown.actor,randomUUID(),unknown.payload);
    await rpc(db,'bill2_claim',unknown.actor,again.id,1,unknown.claimPayload);
  },/METERING_BLOCKED|POLICY_DENIED|MODEL_DENIED/);
  report.checks.push('SQL-only empirical receipts: rB/rT just below 0.8 continue; exact 0.8 or missing P blocks same model across runs');
}
