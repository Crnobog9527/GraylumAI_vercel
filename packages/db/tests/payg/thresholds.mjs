/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {financial} from './core.mjs';
import {thresholdMigrationCases} from './thresholds-migration.mjs';

const key='billing_payg_start_thresholds';
const setConfig=(db,value)=>db.query('UPDATE system_settings SET value=$1::jsonb WHERE key=$2',[JSON.stringify(value),key]);
const entry=(f,amount)=>({model:f.claimPayload.model,purpose:f.claimPayload.phase,...amount});
const config=(...thresholds)=>({version:'nominal-p50-v1',thresholds});
const saved=async(db,id)=>(await db.query(`SELECT start_threshold,threshold_version,reserved_credits,available_credits
  FROM bill2_calls WHERE id=$1`,[id])).rows[0];

export async function thresholdCases(db,report,createFixture,claim,receipt) {
  const prior=(await db.query('SELECT value FROM system_settings WHERE key=$1',[key])).rows[0]?.value;
  try {
    for(const [typicalUsd,expected] of [['0.04415',[14,27]],['0.01274',[4,8]],['0.00028',[1,1]],['0',[1,1]]]) {
      for(const [i,multiplier] of ['3','6'].entries()) {
        const l=expected[i];
        for(const credits of [l-1,l,l+1]) {
          const f=await createFixture(db,{q:'100',multiplier,credits});
          await setConfig(db,config(entry(f,{typicalUsd})));
          const c=await claim(db,f,1,false);
          if(credits<l) {
            assert.equal(c.state,'waiting_credits');
            assert.equal(c.id,null);
            assert.equal((await financial(db,f)).credits,credits);
            assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n,0);
          } else {
            assert.ok(c.id);
            const row=await saved(db,c.id);
            const g=Math.ceil(Number(f.claimPayload.upperUsd)*100*Number(multiplier));
            assert.deepEqual(row,{start_threshold:l,threshold_version:'nominal-p50-v1',
              reserved_credits:Math.min(g,credits),available_credits:credits});
            const audit=(await db.query(`SELECT metadata FROM credit_transactions
              WHERE bill2_call_id=$1 AND reason_code='bill2_reserve'`,[c.id])).rows[0].metadata;
            assert.equal(audit.L,l);
            assert.equal(audit.thresholdVersion,'nominal-p50-v1');
            assert.equal(Number(audit.G),g);
            assert.equal(audit.H,Math.min(g,credits));
          }
        }
      }
    }
    report.checks.push('typical USD P50: m=3/6 yields Sonnet 14/27, Gemini 4/8, Luna 1/1; zero minimum 1; L-1/L/L+1; stored L/version and unchanged G/H');

    const mixed=await createFixture(db,{q:'100',multiplier:'3',secondMultiplier:'6',credits:100});
    await setConfig(db,config(...mixed.claimPayloads.map(p=>({model:p.model,purpose:p.phase,typicalUsd:'0.04415'}))));
    // Mutable pricing settings are deliberately inconsistent with this frozen run.
    await db.query('BEGIN');
    try {
      await db.query(`INSERT INTO system_settings(key,value) VALUES('billing_credits_per_usd','"900"'),
        ('billing_token_price_multiplier','"20"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
      const first=await claim(db,mixed,1,true);
      assert.equal((await saved(db,first.id)).start_threshold,14);
      await receipt(db,mixed,first,'0.001',{inputTokens:1000,outputTokens:0});
      const second=await claim(db,mixed,2,false,mixed.claimPayloads[1]);
      assert.equal((await saved(db,second.id)).start_threshold,27);
      assert.equal((await financial(db,mixed)).charged_credits,1);
    } finally {await db.query('ROLLBACK');}
    report.checks.push('one run freezes q=100 and per-model m=3/6 (not run max or live global values); L=14 then 27');

    const precise=await createFixture(db,{q:'100',multiplier:'3'});
    await setConfig(db,config(entry(precise,{typicalUsd:'0.010000000001'})));
    assert.equal((await saved(db,(await claim(db,precise,1,false)).id)).start_threshold,4);
    const fractional=await createFixture(db,{q:'12.5',multiplier:'1.25'});
    await setConfig(db,config(entry(fractional,{typicalUsd:'0.1'})));
    assert.equal((await saved(db,(await claim(db,fractional,1,false)).id)).start_threshold,2);
    report.checks.push('exact decimal rounding above integer boundary and fractional frozen q/m');

    for(const credits of [14,'14',4,1]) {
      const f=await createFixture(db,{q:'100',multiplier:'6',threshold:credits});
      await setConfig(db,{version:'legacy-v1',thresholds:[entry(f,{credits})]});
      const c=await claim(db,f,1,false);
      assert.equal((await saved(db,c.id)).start_threshold,Number(credits),'legacy entries never rescaled');
    }
    report.checks.push('legacy numeric and string integer credits remain readable at m=6, without rescaling');

    const invalid=await createFixture(db,{q:'100',multiplier:'3'});
    const valid=config(entry(invalid,{typicalUsd:'0.04415'}));
    const malformed=[null,{},[],{version:1,thresholds:valid.thresholds},{version:' ',thresholds:valid.thresholds},
      {version:'v1',thresholds:{}},{version:'v1',thresholds:null},config(),
      config({...valid.thresholds[0],purpose:'other'}),config({...valid.thresholds[0],model:'other'}),
      config(...valid.thresholds,...valid.thresholds),
      ...[null,0.04415,'','-1','1e-3','NaN','Infinity','01','0.0000000000001','1000000000000','999999999999']
        .map(typicalUsd=>config(entry(invalid,{typicalUsd}))),
      config(entry(invalid,{typicalUsd:'0.04415',credits:14})),
      config(entry(invalid,{typicalUsd:null,credits:14})),
      ...[null,0,-1,1.5,'3.0',1000000000].map(credits=>config(entry(invalid,{credits}))),
    ];
    for(const value of malformed) {
      await setConfig(db,value);
      await assert.rejects(claim(db,invalid,1,false),/BILL2_START_THRESHOLD_UNCONFIGURED/);
      assert.equal((await financial(db,invalid)).credits,100);
      const r=(await db.query('SELECT paused_reason FROM bill2_runs WHERE id=$1',[invalid.run])).rows[0];
      assert.equal(r.paused_reason,null,'invalid config must not become a recharge pause');
      assert.equal((await db.query('SELECT count(*)::int n FROM bill2_calls WHERE run_id=$1',[invalid.run])).rows[0].n,0);
    }
    await db.query('DELETE FROM system_settings WHERE key=$1',[key]);
    await assert.rejects(claim(db,invalid,1,false),/BILL2_START_THRESHOLD_UNCONFIGURED/);
    await db.query('INSERT INTO system_settings(key,value) VALUES($1,$2)',[key,valid]);
    const c=await claim(db,invalid,1,false);
    const frozen=await saved(db,c.id);
    await setConfig(db,config(entry(invalid,{typicalUsd:'0.09'})));
    assert.equal((await claim(db,invalid,1,false)).id,c.id);
    assert.deepEqual(await saved(db,c.id),frozen,'already frozen claim is not repriced');
    await setConfig(db,null);
    assert.equal((await claim(db,invalid,1,false)).id,c.id,'idempotent read does not depend on new config');
    report.checks.push(`${malformed.length} malformed/missing/wrong-purpose/duplicate/overflow configs reject without hold or recharge pause; retries preserve frozen L/version`);
    await setConfig(db,valid);
    await thresholdMigrationCases(db,report,createFixture,claim,receipt);
  } finally {
    if(prior)await db.query(`INSERT INTO system_settings(key,value) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,prior]);
    else await db.query('DELETE FROM system_settings WHERE key=$1',[key]);
  }
}
