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
  const actor=options.actor??randomUUID(),credits=options.credits??100,phase=options.phase??'question';
  if (!options.actor) await db.query('INSERT INTO profiles(id,credits) VALUES($1,$2)',[actor,credits]);
  if (!options.actor) await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
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
    maxSchemaBytes:16384,purposes:[phase],expiresAt:deadline};
  const base={provider:'openrouter',account:account(key),model,protocol:'openrouter-chat-v1',upperUsd:'0.008292000000',
    inputLimit:8292,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:false,
    providerLimits:{providerSlug:TAG,contextTokens:100000,promptUsdPerMillion:'1',completionUsdPerMillion:'0',requestUsd:'0'}};
  const payload={contractVersion:'bill2.v2',mode:'production',scope:{kind:'positioning_draft',draftId:draft},
    operation:'question',modelId,sourceHash:'a'.repeat(64),input:{version:'runtime.v1',network:'deny',tools:[],sources:[]},
    callPolicy:[{...base,modelId,multiplier,payg}],
    rules:{version:'runtime-production-v1',quoteVersion:POLICY,creditsPerUsd:'100',multiplier,fx:{},
      billingUnit:{version:'bill-unit-v2',creditsPerUsd:'100',defaultMultiplier:'6',hash:'f'.repeat(64)}},
    limits:{costUsd:'0.1',credits:0,maxPreDeduct:0,maxCalls:8,deadline}};
  const claimPayload={...base,phase,requestHash:'b'.repeat(64),billingUnit:{modelId,multiplier},
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

// 0292: research tool routes and tool-only publish monitor runs on the production database.
const toolsMigration=new URL(`../../migrations/${readdirSync(new URL('../../migrations/',import.meta.url))
  .find(f=>/^\d{4}_runtime_production_tools\.sql$/.test(f))}`,import.meta.url);
const toolModelId=route=>createHash('md5').update('bill2-research-tool:'+route).digest('hex')
  .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
const VALID=new Date(Date.now()+7*86400000).toISOString();
const toolPolicy=(route,patch={})=>({provider:'tikhub',account:'research-production',model:route,protocol:'research-tool-v1',
  modelId:toolModelId(route),multiplier:'6',lookupSupported:false,upperUsd:'0.01',purposes:['question'],
  toolPricing:{unit:'call',currency:'USD',price:'0.01',unitsPerPrice:'1',usdPerCurrency:null,entryHash:'e'.repeat(64),
    validUntil:VALID,maxUnitsPerCall:'1'},...patch});
const priceEntry=(patch={})=>({provider:'tikhub',route:null,appliesToUnlistedRoutes:true,currency:'USD',usageUnit:'call',
  unitsPerPrice:'1',price:'0.01',usdPerCurrency:null,fxSourceUrl:null,fxEffectiveAt:null,fxValidUntil:null,pricingBasis:'list',
  sourceUrl:'https://example.com/p',evidenceHash:'a'.repeat(64),verifiedAt:new Date(Date.now()-86400000).toISOString(),
  validUntil:VALID,chargeCondition:'per call',includedInReceipt:false,priceMultiplier:null,...patch});
const researchConfig=(enabled=true,vendor=true)=>({version:1,enabled,vendors:{tikhub:{enabled:vendor,hardCapAttested:vendor?{by:randomUUID(),at:new Date().toISOString()}:null},
  parallel:{enabled:false,hardCapAttested:null},firecrawl:{enabled:false,hardCapAttested:null}}});

export async function productionToolCases({db,report,claim,reapply=true}) {
  // productionCases reran 0291, which restores its own gate; put the 0292 gate back (a rerun is a no-op otherwise).
  if (reapply) await db.query(readFileSync(toolsMigration,'utf8'));
  const profiles=[];
  const paused=(await db.query('UPDATE runtime_test_windows SET enabled=false WHERE enabled RETURNING id')).rows.map(r=>r.id);
  const config=()=>setting(db,'runtime_payg_production',{version:1,enabled:true,policyVersion:POLICY,profiles});
  await setting(db,'runtime_environment','production');
  await setting(db,'billing_credits_per_usd','100');
  await setting(db,'billing_token_price_multiplier','6');
  await setting(db,'research_tools_config',researchConfig());
  await setting(db,'billing_provider_prices',{version:1,entries:[priceEntry()]});
  await db.query(`INSERT INTO system_settings(key,value) VALUES('billing_payg_start_thresholds','{"version":"local-v1","thresholds":[]}')
    ON CONFLICT(key) DO NOTHING`);
  try {
    const f=await productionFixture(db,profiles);
    const route='tikhub:/tiktok/app/v3/handler_user_profile#'+randomUUID().slice(0,8);
    const tool=toolPolicy(route);
    f.payload.callPolicy.push(tool);
    await db.query(`UPDATE system_settings SET value=jsonb_set(value,'{thresholds}',coalesce(value->'thresholds','[]')||$1::jsonb)
      WHERE key='billing_payg_start_thresholds'`,[JSON.stringify([f.model,route].map(model=>({model,purpose:'question',credits:1})))]);
    await config();
    for (const [payload,why] of [
      [{...f.payload,callPolicy:[f.payload.callPolicy[0],{...tool,toolPricing:{...tool.toolPricing,price:'0.005'}}]},'a frozen price below the configured price'],
      [{...f.payload,callPolicy:[f.payload.callPolicy[0],{...tool,multiplier:'3'}]},'a route multiplier other than the configured one'],
      [{...f.payload,callPolicy:[f.payload.callPolicy[0],{...tool,modelId:toolModelId('tikhub:other')}]},'a tool model id that is not its route'],
    ]) {
      await rejects(prepare(db,f,payload),/RUNTIME_PRODUCTION_MODEL_DENIED|BILL2_CALL_POLICY_DENIED/);
      report.checks.push(`production tool route refused at prepare: ${why}`);
    }
    for (const [entry,why] of [[{validUntil:new Date(Date.now()+86400000).toISOString()},'the price validity changed'],
      [{usageUnit:'credit'},'the usage unit changed'],[{includedInReceipt:true},'the price is included in another receipt'],
      [{currency:'EUR',usdPerCurrency:'1.1',fxSourceUrl:'https://example.com/fx',fxEffectiveAt:new Date(Date.now()-86400000).toISOString(),
        fxValidUntil:new Date(Date.now()+86400000).toISOString()},'the currency and exchange rate changed']]) {
      await setting(db,'billing_provider_prices',{version:1,entries:[priceEntry(entry)]});
      await rejects(prepare(db,f),/RUNTIME_PRODUCTION_MODEL_DENIED/);
      report.checks.push(`production tool route refused at prepare: ${why}`);
    }
    await setting(db,'billing_provider_prices',{version:1,entries:[priceEntry()]});
    await setting(db,'research_tools_config',researchConfig(true,false));
    await rejects(prepare(db,f),/RUNTIME_PRODUCTION_MODEL_DENIED/);
    await setting(db,'research_tools_config',researchConfig());
    f.run=(await prepare(db,f)).id;
    const m=await claim(db,f,1,true);
    await record(db,f,m,'0.00005');
    const toolClaim=(seq)=>rpc(db,'bill2_claim',f.actor,f.run,seq,{provider:'tikhub',account:'research-production',model:route,
      protocol:'research-tool-v1',phase:'question',requestHash:'d'.repeat(64),automaticRetry:false,hiddenTools:false,lookupSupported:false,
      upperUsd:tool.upperUsd,billingUnit:{modelId:tool.modelId,multiplier:'6'},toolPricing:tool.toolPricing});
    await setting(db,'research_tools_config',researchConfig(true,false));
    await rejects(toolClaim(2),/RUNTIME_PRODUCTION_MODEL_DENIED/);
    await setting(db,'research_tools_config',researchConfig());
    const c=await toolClaim(2);
    assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken)).dispatch,true);
    await rpc(db,'bill2_record',f.actor,f.run,c.id,{provider:'tikhub',account:'research-production',protocol:'research-tool-v1',
      model:route,providerId:c.id,source:'response',sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),
      coverage:'request_total',final:true,currency:'USD',cost:'0.01',usage:{unit:'call',units:'1'},evidenceKind:'tool_result',
      toolOutcome:'delivered'});
    await rpc(db,'bill2_finalize',f.actor,f.run);
    const v=await conserved(db,f);
    // (0.00005 + 0.01) × 100 × 6 = 6.03 → 7 credits, rounded once for the run.
    assert.equal(Number(v.charged_credits),7);
    report.checks.push('production run with a model and an approved tool route: prepare, claim, dispatch, settle (q=100, m=6)');
    report.checks.push('turning the vendor off (no attested hard cap) refuses the next tool claim and new runs');

    const monitorPayload=(patch={})=>({contractVersion:'bill2.v2',mode:'production',scope:f.payload.scope,operation:'question',
      modelId:toolModelId('publish-monitor:read-run'),sourceHash:'a'.repeat(64),
      input:{version:'runtime.v1',network:'deny',tools:[],sources:[],publishMonitor:{kind:'refresh'}},callPolicy:[tool],
      rules:{...f.payload.rules,quoteVersion:'publish-monitor'},limits:f.payload.limits,...patch});
    const gate=(payload,prepareTime=true)=>db.query('SELECT public.runtime_production_allowed($1,$2,$3)',[f.actor,payload,prepareTime]);
    await setting(db,'runtime_payg_production',{enabled:false});
    await rejects(gate(monitorPayload()),/RUNTIME_PRODUCTION_DENIED/);
    await setting(db,'runtime_payg_production',{version:1,enabled:true,policyVersion:'another-version',profiles:[]});
    await gate(monitorPayload());
    await rejects(gate({...monitorPayload(),input:{...monitorPayload().input,publishMonitor:undefined}}),/RUNTIME_PRODUCTION_DENIED/);
    await rejects(gate(monitorPayload({callPolicy:[tool,f.payload.callPolicy[0]]})),/RUNTIME_PRODUCTION_(MODEL_)?DENIED/);
    await rejects(gate(monitorPayload({modelId:randomUUID()})),/RUNTIME_PRODUCTION_DENIED/);
    await setting(db,'research_tools_config',researchConfig(false,true));
    await gate(monitorPayload());
    await setting(db,'research_tools_config',researchConfig(true,false));
    await rejects(gate(monitorPayload()),/RUNTIME_PRODUCTION_MODEL_DENIED/);
    await db.query("DELETE FROM system_settings WHERE key='runtime_environment'");
    await setting(db,'research_tools_config',researchConfig());
    await rejects(gate(monitorPayload()),/RUNTIME_PRODUCTION_DENIED/);
    report.checks.push('tool-only publish monitor run: needs no model profile or research master switch, still needs the production '
      +'database, the production switch, the vendor switch and a tool-only policy with the fixed placeholder model');
    // The whole prepare path needs 0290 (PUBLISH-MONITOR 4b, #1081), which lets bill2_prepare skip the model row for
    // these runs; until it is applied only the gate above can run.
    if ((await db.query("SELECT to_regprocedure('public.publish_monitor_tool_only_run(jsonb)') IS NOT NULL v")).rows[0].v) {
      await setting(db,'runtime_environment','production');
      const monitor=monitorPayload({rules:{...f.payload.rules,quoteVersion:'publish-monitor'}});
      assert.ok((await prepare(db,f,monitor)).id);
      report.checks.push('tool-only publish monitor run prepares through bill2_prepare on the production database (0290 present)');
    } else report.checks.push('SKIPPED until 0290: tool-only publish monitor run through bill2_prepare');
  } finally {
    await db.query(`DELETE FROM system_settings WHERE key IN ('runtime_environment','runtime_payg_production','research_tools_config',
      'billing_provider_prices')`);
    await db.query('UPDATE runtime_test_windows SET enabled=true WHERE id=ANY($1::uuid[])',[paused]);
  }
}

// 0293: the review panel (Fusion) on the production database: group admission, batch claim and the recovery inventory.
const fusionMigration=new URL(`../../migrations/${readdirSync(new URL('../../migrations/',import.meta.url))
  .find(f=>/^\d{4}_runtime_production_fusion\.sql$/.test(f))}`,import.meta.url);
export async function productionFusionCases({db,report,reapply=true}) {
  // Earlier cases rerun 0235, which restores its own recovery inventory; put the 0293 patch back (a rerun is a no-op).
  if (reapply) await db.query(readFileSync(fusionMigration,'utf8'));
  const profiles=[];
  const paused=(await db.query('UPDATE runtime_test_windows SET enabled=false WHERE enabled RETURNING id')).rows.map(r=>r.id);
  const sha=text=>createHash('sha256').update(text).digest('hex');
  await setting(db,'runtime_environment','production');
  await setting(db,'billing_credits_per_usd','100');
  await setting(db,'billing_token_price_multiplier','6');
  await db.query(`INSERT INTO system_settings(key,value) VALUES('billing_payg_start_thresholds','{"version":"local-v1","thresholds":[]}')
    ON CONFLICT(key) DO NOTHING`);
  try {
    const f=await productionFixture(db,profiles,{phase:'fusion_review'});
    await db.query(`UPDATE system_settings SET value=jsonb_set(value,'{thresholds}',coalesce(value->'thresholds','[]')||$1::jsonb)
      WHERE key='billing_payg_start_thresholds'`,[JSON.stringify([{model:f.model,purpose:'fusion_review',credits:1}])]);
    await setting(db,'runtime_payg_production',{version:1,enabled:true,policyVersion:POLICY,profiles});
    await setting(db,'fusion_settings',{version:1,compare:{enabled:false},review:{enabled:true,reviewerModelIds:[f.modelId],
      summaryModelId:randomUUID(),maxBudgetUsd:'1'}});
    await db.query(`INSERT INTO membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
      VALUES($1,'Local fixture','gold',true,true,500000000) ON CONFLICT(level) DO UPDATE SET allow_fusion_review=true`,[randomUUID()]);
    await db.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
    const session=randomUUID();
    await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
      [session,f.actor,f.payload.scope,randomUUID()]);
    const member=async()=>{
      const draft=await rpc(db,'bill2_create_draft',f.actor);
      const fusion={index:0,phase:'fusion_review',body:'review request 0',call:{...f.claimPayload,requestHash:sha('review request 0')}};
      return {requestId:randomUUID(),payload:{...f.payload,scope:{kind:'positioning_draft',draftId:draft},
        input:{...f.payload.input,fusion},sourceHash:sha(JSON.stringify(fusion)),limits:{...f.payload.limits,maxCalls:1}}};
    };
    const admit=async(runs,request=randomUUID())=>{
      await db.query('SET ROLE service_role');
      try { return (await db.query('SELECT fusion_group_admit($1,$2,$3,$4,$5) v',[f.actor,request,'review',session,JSON.stringify(runs)])).rows[0].v; }
      finally { await db.query('RESET ROLE'); }
    };
    await db.query("DELETE FROM system_settings WHERE key='runtime_environment'");
    await rejects(admit([await member()]),/RUNTIME_PRODUCTION_DENIED/);
    await setting(db,'runtime_environment','production');
    const group=await admit([await member()]);
    assert.equal(group.runs.length,1);
    const run=(await db.query('SELECT payload->>\'mode\' mode,test_window_id FROM bill2_runs WHERE id=$1',[group.runs[0].runId])).rows[0];
    assert.deepEqual(run,{mode:'production',test_window_id:null});
    const claimed=await rpc(db,'fusion_group_claim',f.actor,group.groupId,'review:1',1,
      JSON.stringify(group.runs.map(r=>({runId:r.runId,sequence:1,payload:r.fusion.call}))));
    assert.equal(claimed.state,'claimed');
    for (const c of claimed.calls) assert.equal((await rpc(db,'bill2_dispatch',f.actor,c.runId,c.id,c.dispatchToken)).dispatch,true);
    const listed=(await db.query('SELECT * FROM fusion_pending_financial_batch(200)')).rows.find(r=>r.run_id===group.runs[0].runId);
    assert.ok(listed,'the dispatched production call is in the recovery inventory');
    assert.deepEqual({mode:listed.recovery.mode,id:listed.recovery.id,callPolicies:listed.recovery.callPolicies},
      {mode:'production',id:POLICY,callPolicies:f.payload.callPolicy});
    report.checks.push('production review panel: group admission refused without the marker, admitted as a production run, '
      +'batch claim and dispatch, and the recovery inventory returns the run\'s own frozen production policy');
  } finally {
    await db.query("DELETE FROM system_settings WHERE key IN ('runtime_environment','runtime_payg_production')");
    await db.query('UPDATE runtime_test_windows SET enabled=true WHERE id=ANY($1::uuid[])',[paused]);
  }
}
