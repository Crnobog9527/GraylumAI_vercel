/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {rpc} from '../erasure-b2a/cases.mjs';
import {conserved,financial} from './core.mjs';

export async function edgeCases(db,report,createFixture,claim,receipt) {
  const rounding=await createFixture(db);
  const first=await claim(db,rounding,1,true);
  await receipt(db,rounding,first,'0.0005',{inputTokens:500,outputTokens:0});
  const second=await claim(db,rounding,2,true);
  await receipt(db,rounding,second,'0.02',{inputTokens:20000,outputTokens:0});
  const delta=(await db.query(`SELECT theoretical_delta,charged_delta,platform_absorbed_cap_credits,
    platform_absorbed_bound_credits FROM bill2_calls WHERE id=$1`,[second.id])).rows[0];
  assert.equal(Number(delta.theoretical_delta),20);
  assert.equal(delta.charged_delta,9);
  assert.equal(Number(delta.platform_absorbed_cap_credits),0);
  assert.equal(Number(delta.platform_absorbed_bound_credits),11);
  await conserved(db,rounding);
  report.checks.push('cumulative rounding H>bounded delta: bound absorption is residual and never double attributed');

  const mixed=await createFixture(db,{secondMultiplier:'2'});
  const m1=await claim(db,mixed,1,true);
  await receipt(db,mixed,m1,'0.0004',{inputTokens:400,outputTokens:0});
  const secondModel={...mixed,claimPayload:mixed.claimPayloads[1]};
  const m2=await claim(db,secondModel,2,true);
  await receipt(db,secondModel,m2,'0.0004',{inputTokens:400,outputTokens:0});
  assert.equal(Number((await financial(db,mixed)).charged_credits),2);
  assert.equal(Number((await financial(db,mixed)).weighted_nominal_usd),0.0012);
  await conserved(db,mixed);
  report.checks.push('mixed model multipliers 1 and 2 use one weighted cumulative ceiling');

  const capped=await createFixture(db,{credits:2});
  const cc=await claim(db,capped,1,true);
  await receipt(db,capped,cc,'0.005',{inputTokens:5000,outputTokens:0});
  await db.query('BEGIN');
  try {
    const before=(await db.query('SELECT credits FROM profiles WHERE id=$1 FOR UPDATE',[capped.actor])).rows[0].credits;
    await db.query('UPDATE profiles SET credits=credits+100 WHERE id=$1',[capped.actor]);
    await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
      idempotency_key,balance_before,balance_after) VALUES($1,100,'addition','grant','opening_grant','system',$2,$3,$4)`,
    [capped.actor,'local-topup:'+randomUUID(),before,before+100]);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;}
  const later=await claim(db,capped,2,true);
  await receipt(db,capped,later,'0.001',{inputTokens:1000,outputTokens:0});
  const state=await financial(db,capped);
  assert.equal(state.credits,99);
  assert.equal(Number(state.charged_credits),3);
  assert.equal(Number(state.platform_absorbed_credits),3);
  await conserved(db,capped);
  report.checks.push('later topup funds only new call; previously absorbed E is never back-charged');

  const missing=await createFixture(db);
  for (const [container,keys] of [
    ['payg',['policyId','policyVersion','profileVersion','evidenceVersion','pricingHash','endpointTag','nominalPricing',
      'bytes','templateTokens','marginTokens','promptTokensUpper','messages','tools','schemaBytes']],
    ['providerLimits',['providerSlug','contextTokens','promptUsdPerMillion','completionUsdPerMillion','requestUsd']],
    ['billingUnit',['modelId','multiplier']],
  ]) {
    for (const key of keys) {
      const p=structuredClone(missing.claimPayload);
      delete p[container][key];
      await assert.rejects(rpc(db,'bill2_claim',missing.actor,missing.run,1,p),undefined,`${container}.${key}`);
      assert.equal((await financial(db,missing)).credits,100);
    }
  }

  for (const key of ['providerSlug','contextTokens','promptUsdPerMillion','completionUsdPerMillion','requestUsd']) {
    const stable=structuredClone(missing.payload);
    const frozen=structuredClone(missing.claimPayload);
    delete stable.callPolicy[0].providerLimits[key];
    delete frozen.providerLimits[key];
    await assert.rejects(async()=>{
      const admitted=await rpc(db,'bill2_prepare',missing.actor,randomUUID(),stable);
      await rpc(db,'bill2_claim',missing.actor,admitted.id,1,frozen);
    },undefined,`matching incomplete providerLimits.${key} still refuses`);
    assert.equal((await financial(db,missing)).credits,100);
  }
  report.checks.push('every required metering/price/multiplier field missing fails closed before money movement');

  // Exercise the private validator directly as well as public claim: outer checks must
  // not hide NULL comparisons in its frozen policy/quote arithmetic.
  const validate = (payload,quote) => db.query(`SELECT bill2_payg_validate_quote(
    jsonb_populate_record(r, jsonb_build_object('payload',$2::jsonb)), $3::jsonb)
    FROM bill2_runs r WHERE r.id=$1`,[missing.run,payload,quote]);
  await validate(missing.payload,missing.claimPayload);
  for(const cap of [32,128]) {
    const payload=structuredClone(missing.payload);
    payload.callPolicy[0].payg.maxMessages=cap;
    await validate(payload,{...missing.claimPayload,payg:{...missing.claimPayload.payg,messages:cap}});
    await assert.rejects(validate(payload,{...missing.claimPayload,
      payg:{...missing.claimPayload.payg,messages:cap+1}}),/BILL2_PAYG_QUOTE_INVALID/);
  }
  report.checks.push('128-message quotes accepted; 129 rejected; old frozen 32-message caps preserved');
  const signature='public.bill2_payg_validate_quote(bill2_runs,jsonb)';
  const original=(await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition;
  const migration=readFileSync(new URL('../../migrations/0173_payg_profile_messages.sql',import.meta.url),'utf8');
  const guard=migration.slice(migration.indexOf('DO $migration$'),migration.indexOf('COMMIT;'));
  await db.query('BEGIN');
  try {
    await db.query(original.replace('AS $function$','AS $function$\n-- intentional drift\n'));
    await assert.rejects(db.query(guard),/PAYG_MESSAGES_SOURCE_MISMATCH/);
  } finally {await db.query('ROLLBACK');}
  assert.equal((await db.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition,original);
  report.checks.push('128-message migration refuses unexpected function drift and rollback restores exact original');


  for (const key of ['inputLimit','outputLimit']) {
    for (const nullValue of [false,true]) {
      const quote=structuredClone(missing.claimPayload);
      if (nullValue) quote[key]=null; else delete quote[key];
      await assert.rejects(validate(missing.payload,quote),/BILL2_PAYG_QUOTE_INVALID/,key);
      await assert.rejects(rpc(db,'bill2_claim',missing.actor,missing.run,1,quote),/BILL2_PAYG_QUOTE_INVALID/,key);
      const payload=structuredClone(missing.payload);
      if (nullValue) payload.callPolicy[0][key]=null; else delete payload.callPolicy[0][key];
      await assert.rejects(validate(payload,missing.claimPayload),/BILL2_PAYG_QUOTE_INVALID/,`policy.${key}`);
    }
  }
  const nullContext=structuredClone(missing.payload);
  const nullQuote=structuredClone(missing.claimPayload);
  nullContext.callPolicy[0].providerLimits.contextTokens=null;
  nullQuote.providerLimits.contextTokens=null;
  await assert.rejects(validate(nullContext,nullQuote),/BILL2_PAYG_QUOTE_INVALID/);
  assert.equal((await financial(db,missing)).credits,100);
  assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[missing.run])).rows[0].n,0);
  report.checks.push('quote validator rejects missing/NULL call and policy input/output limits and NULL context before any hold');

  const size=await createFixture(db);
  const base={...size.claimPayload,testPadding:''};
  const length=(await db.query('SELECT octet_length($1::jsonb::text)::int n',[base])).rows[0].n;
  const exact={...base,testPadding:'x'.repeat(65536-length)};
  assert.equal((await db.query('SELECT octet_length($1::jsonb::text)::int n',[exact])).rows[0].n,65536);
  await assert.rejects(rpc(db,'bill2_claim',size.actor,size.run,1,{...exact,testPadding:exact.testPadding+'x'}),/CALL_TOO_LARGE/);
  assert.equal((await financial(db,size)).credits,100);
  assert.ok((await rpc(db,'bill2_claim',size.actor,size.run,1,exact)).id);
  report.checks.push('complete frozen call JSON exact 65536 bytes accepted, plus one rejected before hold');
  const runSize=await createFixture(db);
  const runBase={...runSize.payload,testPadding:''};
  const runLength=(await db.query('SELECT octet_length($1::jsonb::text)::int n',[runBase])).rows[0].n;
  const exactRun={...runBase,testPadding:'x'.repeat(262144-runLength)};
  await assert.rejects(rpc(db,'bill2_prepare',runSize.actor,randomUUID(),{...exactRun,testPadding:exactRun.testPadding+'x'}),/check constraint|TOO_LARGE/);
  const largeRun=await rpc(db,'bill2_prepare',runSize.actor,randomUUID(),exactRun);
  assert.ok(largeRun.id);
  const resultBase={kind:'usable_result',evidenceRef:'local-proof',evidenceHash:'d'.repeat(64),body:''};
  const resultLength=(await db.query('SELECT octet_length($1::jsonb::text)::int n',[resultBase])).rows[0].n;
  const exactResult={...resultBase,body:'x'.repeat(262144-resultLength)};
  await assert.rejects(rpc(db,'bill2_close',runSize.actor,largeRun.id,'delivered',{...exactResult,body:exactResult.body+'x'}),/RESULT_TOO_LARGE/);
  await rpc(db,'bill2_close',runSize.actor,largeRun.id,'delivered',exactResult);
  assert.equal((await financial(db,runSize)).credits,100);
  report.checks.push('run frozen payload and result each accept exact 262144 bytes and reject plus one');

}
