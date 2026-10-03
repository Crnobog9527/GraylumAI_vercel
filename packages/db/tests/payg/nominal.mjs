/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc} from '../erasure-b2a/cases.mjs';
import {conserved,financial} from './core.mjs';

const callState = async (db,id) => (await db.query('SELECT * FROM bill2_calls WHERE id=$1',[id])).rows[0];
export async function nominalCases(db,report,createFixture,claim,receipt) {
  // Same nominal tokens, two independently supplied actual costs: cache read/write do not change list billing.
  for (const actual of ['0.0004','0.0014']) {
    const f = await createFixture(db);
    const c = await claim(db,f,1,true);
    await receipt(db,f,c,actual,{inputTokens:1000,outputTokens:0,cachedTokens:500,cacheCreationTokens:200});
    const state = await callState(db,c.id);
    assert.equal(Number(state.nominal_cost_usd),0.001);
    assert.equal(Number(state.charged_delta),1);
    assert.equal(Number((await financial(db,f)).nominal_cost_usd),0.001);
    await conserved(db,f);
  }
  report.checks.push('cache reads and expensive cache writes: identical list-price nominal charge despite different provider costs');

  const breakdown=await createFixture(db,{tiers:[
    {minPromptTokens:0,prompt:'1',completion:'0',request:'0',cacheRead:'0.2',cacheWrite:'3'},
  ]});
  const bc=await claim(db,breakdown,1,true);
  await receipt(db,breakdown,bc,'0.0014',{inputTokens:1000,outputTokens:0,cachedTokens:500,cacheCreationTokens:200});
  const parts=await callState(db,bc.id);
  assert.equal(Number(parts.platform_margin_cache_read_usd),0.0004);
  assert.equal(Number(parts.platform_margin_cache_write_usd),-0.0004);
  assert.equal(Number(parts.platform_margin_other_usd),-0.0004);
  assert.equal((await db.query(`SELECT platform_margin_cache_read_usd+platform_margin_cache_write_usd
    +platform_margin_other_usd=nominal_cost_usd-selected_cost_usd ok FROM bill2_calls WHERE id=$1`,[bc.id])).rows[0].ok,true);
  report.checks.push('cache read/write/other signed margin parts sum to nominal minus actual; write premium stays negative');

  const tiers = [
    {minPromptTokens:0,prompt:'1',completion:'0',request:'0'},
    {minPromptTokens:200,prompt:'2',completion:'0',request:'0'},
  ];
  for (const prompt of [199,200,201]) {
    const f = await createFixture(db,{tiers,promptPrice:'2'});
    const c = await claim(db,f,1,true);
    await receipt(db,f,c,'0.0001',{inputTokens:prompt,outputTokens:0});
    const expected = prompt*(prompt<200?1:2)/1e6;
    assert.equal(Number((await callState(db,c.id)).nominal_cost_usd),expected);
    await conserved(db,f);
  }
  report.checks.push('actual-token long-context threshold -1/0/+1 selects correct complete nominal tier');

  const timed = await createFixture(db,{promptPrice:'4',timeOfDay:[{prompt:'4',completion:'0',request:'0'}]});
  const tc = await claim(db,timed,1,true);
  await receipt(db,timed,tc,'0.001',{inputTokens:1000,outputTokens:0});
  assert.equal(Number((await callState(db,tc.id)).nominal_cost_usd),0.004);
  assert.equal(Number((await financial(db,timed)).charged_credits),4);
  report.checks.push('time-varying nominal price uses maximum time layer');

  const unreachable = await createFixture(db,{tiers:[
    {minPromptTokens:0,prompt:'1',completion:'0',request:'0'},
    {minPromptTokens:9000,prompt:'5',completion:'0',request:'0'},
  ]});
  const uc = await claim(db,unreachable,1,true);
  await receipt(db,unreachable,uc,'0.001',{inputTokens:9000,outputTokens:0});
  const over = await callState(db,uc.id);
  assert.equal(Number(over.nominal_cost_usd),0.045);
  assert.equal(over.budget_conflict,true);
  assert.ok(Number(over.platform_absorbed_bound_credits)>0);
  await conserved(db,unreachable);
  await assert.rejects(claim(db,unreachable,2,false),/CLOSED|CONFLICT|BUDGET|METERING_BLOCKED/);
  report.checks.push('unreachable expensive tier permits short quote; P>T uses full actual tier, caps and stops new calls');

  const invalid = await createFixture(db);
  for (const patch of [
    {payg:{...invalid.claimPayload.payg,pricingHash:'d'.repeat(64)}},
    {payg:{...invalid.claimPayload.payg,nominalPricing:undefined}},
    {payg:{...invalid.claimPayload.payg,promptTokensUpper:8293}},
    {payg:{...invalid.claimPayload.payg,bytes:196609}},
    {payg:{...invalid.claimPayload.payg,tools:3}},
  ]) {
    await assert.rejects(claim(db,invalid,1,false,patch));
    assert.equal((await financial(db,invalid)).credits,100);
    assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[invalid.run])).rows[0].n,0);
  }
  report.checks.push('invalid nominal identity/missing table/T/byte/tool cap refuses before hold');

  const zero = await createFixture(db);
  const zc = await claim(db,zero,1,true);
  await receipt(db,zero,zc,'0',{inputTokens:0,outputTokens:0});
  assert.equal(Number((await financial(db,zero)).charged_credits),0);
  assert.equal((await financial(db,zero)).credits,100);
  await rpc(db,'bill2_finalize',zero.actor,zero.run);
  report.checks.push('authoritative zero-token/zero-cost call releases full hold with no charge');
}
