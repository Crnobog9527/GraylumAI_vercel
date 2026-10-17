/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RUNTIME-PROD: BILL2 v2 in production mode (no test window). Runs last: it marks this local database as the
// production database and disables every enabled test window, then restores both in finally.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import {rpc} from '../erasure-b2a/cases.mjs';
import {conserved,financial} from './core.mjs';

const migrationName=readdirSync(new URL('../../migrations/',import.meta.url)).find(f=>/^\d{4}_runtime_production_mode\.sql$/.test(f));
const migration=new URL(`../../migrations/${migrationName}`,import.meta.url);
const signatures=['bill2_prepare(uuid,uuid,jsonb)','runtime_test_window_allowed(uuid,jsonb)','runtime_test_budget_guard()',
  'runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)'];
const definitions=async db=>Object.fromEntries(await Promise.all(signatures.map(async s=>
  [s,(await db.query(`SELECT pg_get_functiondef('public.${s}'::regprocedure) d`)).rows[0].d])));
const rejects=(promise,pattern)=>assert.rejects(promise,error=>pattern.test(error.message));
const POLICY='prod-local-v1';
const TAG='fixture/prod';
const account=key=>'openrouter-key:'+createHash('sha256').update(key).digest('hex');
const setting=(db,key,value)=>db.query(`INSERT INTO system_settings(key,value) VALUES($1,$2::jsonb)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,JSON.stringify(value)]);

/** One production run: an OpenRouter model row with a stored price snapshot and key, the production profile
 * of its route, and the frozen v2 payload the TS host builds (productionPolicy.ts / admission.ts). */
async function productionFixture(db,profiles,options={}) {
  const actor=randomUUID(),credits=options.credits??100;
  await db.query('INSERT INTO profiles(id,credits) VALUES($1,$2)',[actor,credits]);
  await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) VALUES($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,
  [actor,credits,'opening_grant:'+actor]);
  const modelId=randomUUID(),model='prod-local/'+modelId.slice(0,8),key='sk-local-'+modelId,pricingHash='a'.repeat(64);
  await db.query(`INSERT INTO ai_models(id,model_id,name,provider,is_active,api_key,config,price_multiplier)
    VALUES($1,$2,'Production local','openrouter',true,$3,$4,$5)`,
  [modelId,model,key,{pricing:{pricingHash}},options.modelMultiplier??null]);
  profiles.push({model,endpointTag:TAG});
  const draft=await rpc(db,'bill2_create_draft',actor);
  const nominalPricing={version:'nominal-v1',pricingHash,endpointTag:TAG,
    tiers:[{minPromptTokens:0,prompt:'1',completion:'0',request:'0'}],timeOfDay:[]};
  const identity={policyId:POLICY,profileVersion:'local-v1',evidenceVersion:'local-v1',pricingHash,endpointTag:TAG,
    nominalPricing,templateTokens:4096,marginTokens:4096};
  const multiplier=options.multiplier??'6';
  const deadline=new Date(Date.now()+3600000).toISOString();
  const payg={...identity,version:'production-host-v1',admissionPath:'empirical',maxBytes:196608,maxMessages:32,maxTools:2,
    maxSchemaBytes:16384,purposes:['question'],expiresAt:deadline};
  const base={provider:'openrouter',account:account(key),model,protocol:'openrouter-chat-v1',upperUsd:'0.008292000000',
    inputLimit:8292,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:false,
    providerLimits:{providerSlug:TAG,contextTokens:100000,promptUsdPerMillion:'1',completionUsdPerMillion:'0',requestUsd:'0'}};
  const payload={contractVersion:'bill2.v2',mode:'production',scope:{kind:'positioning_draft',draftId:draft},
    operation:'question',modelId,sourceHash:'a'.repeat(64),input:{version:'runtime.v1',network:'deny',tools:[],sources:[]},
    callPolicy:[{...base,modelId,multiplier,payg}],
    rules:{version:'runtime-production-v1',quoteVersion:POLICY,creditsPerUsd:'100',multiplier,fx:{},
      billingUnit:{version:'bill-unit-v2',creditsPerUsd:'100',defaultMultiplier:'6',hash:'f'.repeat(64)}},
    limits:{costUsd:'0.1',credits:0,maxPreDeduct:0,maxCalls:8,deadline}};
  const claimPayload={...base,phase:'question',requestHash:'b'.repeat(64),billingUnit:{modelId,multiplier},
    payg:{...identity,policyVersion:'production-host-v1',bytes:100,promptTokensUpper:8292,messages:1,tools:0,schemaBytes:0}};
  return {actor,draft,modelId,model,key,payload,claimPayload};
}
const prepare=(db,f,payload=f.payload,request=randomUUID())=>rpc(db,'bill2_prepare',f.actor,request,payload);
const record=(db,f,c,cost)=>rpc(db,'bill2_record',f.actor,f.run,c.id,{provider:'openrouter',account:f.claimPayload.account,
  model:f.model,protocol:'openrouter-chat-v1',providerId:'generation-'+c.id,source:'response',sourceHash:'c'.repeat(64),
  observedAt:new Date().toISOString(),coverage:'request_total',final:cost!==null,cost,currency:'USD',
  usage:{inputTokens:50,outputTokens:0}});

export async function productionCases({db,Client,connectionString,report,claim}) {
  const profiles=[];
  const config=()=>setting(db,'runtime_payg_production',{version:1,enabled:true,policyVersion:POLICY,profiles});
  const paused=(await db.query('UPDATE runtime_test_windows SET enabled=false WHERE enabled RETURNING id')).rows.map(r=>r.id);
  await setting(db,'billing_credits_per_usd','100');
  await setting(db,'billing_token_price_multiplier','6');
  await db.query(`INSERT INTO system_settings(key,value) VALUES('billing_payg_start_thresholds','{"version":"local-v1","thresholds":[]}')
    ON CONFLICT(key) DO NOTHING`);
  const threshold=async model=>db.query(`UPDATE system_settings SET value=jsonb_set(value,'{thresholds}',
    coalesce(value->'thresholds','[]')||$1::jsonb) WHERE key='billing_payg_start_thresholds'`,
  [JSON.stringify([{model,purpose:'question',credits:1}])]);
  const writers=[new Client({connectionString}),new Client({connectionString})];
  try {
    const f=await productionFixture(db,profiles);
    await threshold(f.model);
    await config();
    await rejects(prepare(db,f),/RUNTIME_PRODUCTION_DENIED/);
    await rejects(rpc(db,'runtime_production_access',f.actor),/RUNTIME_PRODUCTION_DENIED/);
    assert.equal((await db.query('SELECT count(*)::int n FROM bill2_runs WHERE actor_id=$1',[f.actor])).rows[0].n,0);
    report.checks.push('production mode is refused on a database without the production marker; no run is created');

    await setting(db,'runtime_environment','production');
    const request=randomUUID();
    f.run=(await prepare(db,f,f.payload,request)).id;
    assert.equal((await prepare(db,f,f.payload,request)).id,f.run,'same request replays the same run');
    assert.equal((await db.query('SELECT test_window_id FROM bill2_runs WHERE id=$1',[f.run])).rows[0].test_window_id,null);
    assert.equal(await rpc(db,'runtime_production_access',f.actor),true);
    const c=await claim(db,f,1,true);
    assert.equal((await claim(db,f,1,false)).id,c.id,'repeated claim returns the same call');
    await record(db,f,c,'0.00005');
    await rpc(db,'bill2_finalize',f.actor,f.run);
    const settled=await conserved(db,f);
    // 50 input tokens at $1/M = $0.00005; q=100, m=6 -> ceil(0.00005*100*6)=1 credit.
    assert.equal(Number(settled.charged_credits),1);
    assert.equal(settled.credits,99);
    report.checks.push('production v2 run: prepare, replay, one claim, dispatch, receipt and settlement with q=100 m=6');

    const denied=async(payload,pattern,why)=>{
      await rejects(prepare(db,f,payload),pattern);
      report.checks.push(`production prepare refused: ${why}`);
    };
    await denied({...f.payload,testWindowId:randomUUID()},/RUNTIME_(PRODUCTION|TEST_WINDOW)_DENIED/,'carries a test window id');
    await denied({...f.payload,input:{...f.payload.input,network:'allow'}},/RUNTIME_PRODUCTION_DENIED/,'network allowed');
    await denied({...f.payload,rules:{...f.payload.rules,version:'runtime-staging-v1'}},/RUNTIME_PRODUCTION_DENIED/,'staging rules version');
    await denied({...f.payload,rules:{...f.payload.rules,quoteVersion:'prod-old'}},/RUNTIME_PRODUCTION_DENIED/,'stale profile version');
    await denied({...f.payload,rules:{...f.payload.rules,creditsPerUsd:'1000'}},/RUNTIME_PRODUCTION_DENIED/,'q differs from configuration');
    const entry=f.payload.callPolicy[0];
    const withEntry=patch=>({...f.payload,callPolicy:[{...entry,...patch}]});
    await denied(withEntry({multiplier:'3'}),/RUNTIME_PRODUCTION_MODEL_DENIED/,'m differs from configuration');
    await denied(withEntry({payg:{...entry.payg,pricingHash:'e'.repeat(64)}}),/RUNTIME_PRODUCTION_MODEL_DENIED|BILL2/,'price snapshot differs');
    await denied(withEntry({providerLimits:{...entry.providerLimits,providerSlug:'other/route'}}),/RUNTIME_PRODUCTION_MODEL_DENIED|BILL2/,'route without a profile');
    await denied(withEntry({protocol:'fixture-cost-v1'}),/RUNTIME_PRODUCTION_MODEL_DENIED|BILL2/,'fixture protocol');
    await denied({...f.payload,contractVersion:'bill2.v1',limits:{...f.payload.limits,credits:1,maxPreDeduct:1}},
      /RUNTIME_PRODUCTION_DENIED|BILL2/,'v1 contract');
    await db.query(`DELETE FROM system_settings WHERE key='billing_token_price_multiplier'`);
    await denied(f.payload,/RUNTIME_PRODUCTION_DENIED/,'default m row missing (no code fallback)');
    await setting(db,'billing_token_price_multiplier','6');

    const model=await productionFixture(db,profiles,{modelMultiplier:8,multiplier:'8'});
    await threshold(model.model);await config();
    model.run=(await prepare(db,model)).id;
    report.checks.push('a model override m_i is accepted only when it equals ai_models.price_multiplier');

    const live=await productionFixture(db,profiles);
    await threshold(live.model);await config();
    live.run=(await prepare(db,live)).id;
    await setting(db,'runtime_payg_production',{version:1,enabled:true,policyVersion:'prod-local-v2',profiles});
    const afterBump=await claim(db,live,1,true);
    assert.ok(afterBump.id,'a new profile version does not strand a started run');
    await record(db,live,afterBump,'0.00005');
    for (const [change,restore] of [
      [()=>setting(db,'runtime_payg_production',{enabled:false}),config],
      [()=>setting(db,'runtime_payg_production',{version:1,enabled:true,policyVersion:POLICY,
        profiles:profiles.filter(p=>p.model!==live.model)}),config],
      [()=>db.query("UPDATE ai_models SET is_active='false' WHERE id=$1",[live.modelId]),
        ()=>db.query("UPDATE ai_models SET is_active='true' WHERE id=$1",[live.modelId])],
      [()=>db.query("DELETE FROM system_settings WHERE key='runtime_environment'"),()=>setting(db,'runtime_environment','production')],
    ]) {
      await change();
      await rejects(claim(db,live,2,false),/RUNTIME_PRODUCTION_(MODEL_)?DENIED|BILL2_MODEL_DENIED|BILL2_CALL_POLICY_DENIED/);
      await restore();
    }
    assert.ok((await claim(db,live,2,false)).id);
    report.checks.push('switch-off, route removal, model deactivation and marker removal stop the next claim');

    const window=await db.query(`INSERT INTO runtime_test_windows(id,enabled,all_actors,actor_ids,call_policies,credits_per_usd,
      multiplier,max_cost_usd,max_calls,expires_at) VALUES($1,true,true,'{}',$2,100,6,1,10,now()+interval '1 hour') RETURNING id`,
    [randomUUID(),JSON.stringify(f.payload.callPolicy)]);
    await rejects(claim(db,live,3,false),/RUNTIME_PRODUCTION_DENIED/);
    await rejects(rpc(db,'runtime_production_access',f.actor),/RUNTIME_PRODUCTION_DENIED/);
    await db.query('UPDATE runtime_test_windows SET enabled=false WHERE id=$1',[window.rows[0].id]);
    const staging={...f.payload,mode:'staging_test',testWindowId:window.rows[0].id,
      rules:{...f.payload.rules,version:'runtime-staging-v1',quoteVersion:window.rows[0].id}};
    await rejects(prepare(db,f,staging),/RUNTIME_TEST_WINDOW_DENIED/);
    report.checks.push('an enabled test window turns production off; a staging run is refused on the production database');

    // Financial recovery: while production is on, an unfinished execution is still allowed (not finishable); once the
    // production switch is off, recovery closes it and the hold is released (a production run has no window to expire).
    const stuck=await productionFixture(db,profiles);
    await threshold(stuck.model);await config();
    stuck.run=(await prepare(db,stuck)).id;
    const stuckExecution=(await db.query('SELECT b2a_test.bind($1) v',[stuck])).rows[0].v;
    await rejects(rpc(db,'runtime_financial_recovery',stuck.actor,stuckExecution,true),/RUNTIME_EXECUTION_STILL_ALLOWED/);
    await setting(db,'runtime_payg_production',{enabled:false});
    assert.equal((await rpc(db,'runtime_financial_recovery',stuck.actor,stuckExecution,true)).state,'cancelled');
    await config();
    report.checks.push('production financial recovery: refused while production is on, closes an unfinished execution once the switch is off');
    const bound=await productionFixture(db,profiles);
    await threshold(bound.model);await config();
    bound.run=(await prepare(db,bound)).id;
    const execution=(await db.query('SELECT b2a_test.bind($1) v',[bound])).rows[0].v;
    const policy=await rpc(db,'runtime_production_recovery_policy',bound.actor,execution);
    assert.deepEqual({mode:policy.mode,id:policy.id,callPolicies:policy.callPolicies,creditsPerUsd:policy.creditsPerUsd},
      {mode:'production',id:POLICY,callPolicies:bound.payload.callPolicy,creditsPerUsd:'100'});
    await rejects(rpc(db,'runtime_production_recovery_policy',f.actor,execution),/RUNTIME_TEST_RECOVERY_DENIED/);
    await rejects(rpc(db,'runtime_test_recovery_policy',bound.actor,execution),/RUNTIME_TEST_RECOVERY_DENIED/);
    report.checks.push('recovery returns the run\'s own frozen production policy, only to its actor; the window RPC refuses it');

    await Promise.all(writers.map(w=>w.connect()));
    await Promise.all(writers.map(w=>w.query("SET statement_timeout='10s'")));
    const raced=await productionFixture(db,profiles);
    await threshold(raced.model);await config();
    raced.run=(await prepare(db,raced)).id;
    const pair=await Promise.all(writers.map(w=>claim(w,raced,1,false)));
    assert.equal(pair[0].id,pair[1].id);
    assert.equal(pair.filter(x=>x.dispatchToken).length,1,'one dispatch authority');
    const failing=await productionFixture(db,profiles);
    await threshold(failing.model);await config();
    failing.run=(await prepare(db,failing)).id;
    const lost=await claim(db,failing,1,true);
    await record(db,failing,lost,null);
    await rpc(db,'bill2_close',failing.actor,failing.run,'confirmed_failure',{
      kind:'confirmed_delivery_failure',evidenceRef:'local-proof',evidenceHash:'d'.repeat(64),body:'local proof'});
    assert.equal((await rpc(db,'bill2_finalize',failing.actor,failing.run)).state,'refunded');
    assert.equal((await financial(db,failing)).credits,100);
    await conserved(db,failing);
    report.checks.push('two-backend duplicate claim yields one call and one token; a confirmed failure refunds the hold');

    for (const role of ['anon','authenticated']) {
      await db.query(`SET ROLE ${role}`);
      try {
        await rejects(rpc(db,'runtime_production_access',f.actor),/permission denied/);
        await rejects(rpc(db,'runtime_production_recovery_policy',f.actor,execution),/permission denied/);
        await rejects(db.query('SELECT runtime_production_database()'),/permission denied/);
      } finally {await db.query('RESET ROLE');}
    }
    report.checks.push('anon and authenticated cannot reach the production host functions');

    const patched=await definitions(db);
    await db.query(readFileSync(migration,'utf8'));
    assert.deepEqual(await definitions(db),patched,'rerun leaves every patched function unchanged');
    const original=patched['runtime_test_budget_guard()'];
    await db.query(original.replace("PERFORM runtime_production_allowed(NEW.actor_id,NEW.payload,true);",'NULL;')
      .replace(" IF NEW.payload->>'mode' IS DISTINCT FROM 'staging_test' THEN\n  IF NEW.test_window_id IS NOT NULL",
        " IF NEW.payload->>'mode' IS DISTINCT FROM 'staging_test'  THEN\n  IF NEW.test_window_id IS NOT NULL"));
    try {
      await rejects(db.query(readFileSync(migration,'utf8')),/RUNTIME_PRODUCTION_PATCH_MISSING/);
      await db.query('ROLLBACK');
    } finally {await db.query(original);}
    assert.deepEqual(await definitions(db),patched);
    report.checks.push('production migration rerun is a no-op and a missing anchor aborts it');
  } finally {
    await Promise.all(writers.map(w=>w.end().catch(()=>{})));
    await db.query("DELETE FROM system_settings WHERE key IN ('runtime_environment','runtime_payg_production')");
    await db.query('UPDATE runtime_test_windows SET enabled=true WHERE id=ANY($1::uuid[])',[paused]);
  }
}
