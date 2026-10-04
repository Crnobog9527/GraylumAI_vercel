/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';

export async function createFixture(db,options={}) {
  const {credits=100,q='1000',multiplier='1',threshold=1,lookupSupported=false} = options;
  const actor = options.actor ?? randomUUID();
  const provider = options.empirical?'openrouter':'fixture';
  const protocol = options.empirical?'openrouter-chat-v1':'fixture-cost-v1';
  const bytes = options.bytes??100;
  const templateTokens = options.templateTokens??4096;
  const marginTokens = options.marginTokens??4096;
  const promptTokensUpper = bytes+templateTokens+marginTokens;
  if (!options.actor) {
    await db.query('INSERT INTO profiles(id,credits) VALUES($1,$2)',[actor,credits]);
    await db.query(`INSERT INTO credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
      idempotency_key,balance_before,balance_after) VALUES($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,
    [actor,credits,'opening_grant:'+actor]);
  }
  const modelId = randomUUID();
  const model = 'payg-local-'+modelId;
  await db.query("INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES($1,$2,'PAYG local',$3,true)",[modelId,model,provider]);
  const draft = await rpc(db,'bill2_create_draft',actor);
  const pricingHash = 'a'.repeat(64);
  const endpointTag = 'fixture/exact';
  const nominalPricing = {version:'nominal-v1',pricingHash,endpointTag,
    tiers:options.tiers??[{minPromptTokens:0,prompt:'1',completion:'0',request:'0'}],timeOfDay:options.timeOfDay??[]};
  const identity = {policyId:'payg-local',profileVersion:'local-v1',evidenceVersion:'local-v1',
    pricingHash,endpointTag,nominalPricing,templateTokens,marginTokens};
  const payg = {...identity,version:'v1',admissionPath:options.empirical?'empirical':'fixture',maxBytes:196608,maxMessages:32,maxTools:2,
    maxSchemaBytes:16384,purposes:['question'],expiresAt:new Date(Date.now()+3600000).toISOString()};
  const quote = {...identity,policyVersion:'v1',bytes,promptTokensUpper,messages:1,tools:0,schemaBytes:0};
  const promptPrice = options.promptPrice??'1';
  const completionPrice = options.completionPrice??'0';
  const requestPrice = options.requestPrice??'0';
  const upperUsd = options.upperUsd??(promptTokensUpper*Number(promptPrice)/1e6+1000*Number(completionPrice)/1e6+Number(requestPrice)).toFixed(12);
  const base = {provider,account:'sandbox',model,protocol,upperUsd,
    inputLimit:promptTokensUpper,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported,
    providerLimits:{providerSlug:endpointTag,contextTokens:100000,promptUsdPerMillion:promptPrice,
      completionUsdPerMillion:completionPrice,requestUsd:requestPrice}};
  const policy = {...base,modelId,multiplier,payg};
  const claimPayload = {...base,phase:'question',requestHash:'b'.repeat(64),
    billingUnit:{modelId,multiplier},payg:quote};
  const policies = [policy];
  const claimPayloads = [claimPayload];
  if (options.secondMultiplier) {
    const secondId = randomUUID();
    const secondModel = 'payg-local-'+secondId;
    await db.query("INSERT INTO ai_models(id,model_id,name,provider,is_active) VALUES($1,$2,'PAYG local','fixture',true)",[secondId,secondModel]);
    policies.push({...policy,modelId:secondId,model:secondModel,multiplier:options.secondMultiplier});
    claimPayloads.push({...claimPayload,model:secondModel,billingUnit:{modelId:secondId,multiplier:options.secondMultiplier}});
  }
  const runMultiplier = String(Math.max(Number(multiplier),Number(options.secondMultiplier??multiplier)));
  const payload = {contractVersion:'bill2.v2',mode:'isolated',scope:{kind:'positioning_draft',draftId:draft},
    operation:'question',modelId,sourceHash:'a'.repeat(64),input:{text:'PAYG_LOCAL_PRIVATE_CANARY'},callPolicy:policies,
    rules:{version:'v1',quoteVersion:'local-v1',creditsPerUsd:q,multiplier:runMultiplier,fx:{},
      billingUnit:{version:'bill-unit-v2',creditsPerUsd:q,defaultMultiplier:multiplier,hash:'f'.repeat(64)}},
    limits:{costUsd:'0.1',credits:0,maxPreDeduct:0,maxCalls:8,deadline:new Date(Date.now()+3600000).toISOString()}};
  // Each fixture adds its exact model threshold without changing other concurrent fixture models.
  await db.query(`INSERT INTO system_settings(key,value) VALUES('billing_payg_start_thresholds',$1::jsonb)
    ON CONFLICT(key) DO UPDATE SET value=jsonb_set(system_settings.value,'{thresholds}',
      coalesce(system_settings.value->'thresholds','[]')||(excluded.value->'thresholds'))`,
  [{version:'local-v1',thresholds:policies.map(p=>({model:p.model,purpose:'question',credits:threshold}))}]);
  if (options.empirical) {
    const windowId=randomUUID();
    payload.mode='staging_test';
    payload.testWindowId=windowId;
    payload.input={version:'runtime.v1',network:'deny',tools:[],sources:[]};
    payload.rules.version='runtime-staging-v1';
    payload.rules.quoteVersion=windowId;
    await db.query(`INSERT INTO runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,
      multiplier,max_cost_usd,max_calls,expires_at) VALUES($1,true,$2,$3,$4,$5,1,100,now()+interval '2 hours')`,
    [windowId,[actor],JSON.stringify(policies),q,runMultiplier]);
  }
  const run = await rpc(db,'bill2_prepare',actor,randomUUID(),payload);
  return {actor,run:run.id,draft,payload,claimPayload,claimPayloads};
}

export async function claim(db,f,sequence=1,dispatch=true,patch={}) {
  // b2a_test.bind historically seeds an interrupted execution without acquiring a
  // runtime owner. Start that synthetic v2 fixture through the real epoch RPC.
  const linked=(await db.query(`SELECT e.id,r.runtime_epoch FROM runtime_executions e
    JOIN bill2_runs r ON r.id=e.billing_run_id
    WHERE r.id=$1 AND r.contract_version='bill2.v2' AND r.session_ref IS NOT NULL`,[f.run])).rows[0];
  let runtime={};
  if(linked){
    const initial=String(linked.runtime_epoch)==='0';
    if(initial)await db.query(`UPDATE runtime_executions SET state='prepared'
      WHERE id=$1 AND state='interrupted'
      AND NOT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=$2)`,[linked.id,f.run]);
    const execution=await rpc(db,'runtime_execution',f.actor,linked.id,initial?'begin':'read',null);
    runtime={runtimeEpoch:execution.epoch};
  }
  const c = await rpc(db,'bill2_claim',f.actor,f.run,sequence,{...f.claimPayload,...runtime,...patch});
  if (dispatch) assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken)).dispatch,true);
  return c;
}
export const receipt = (db,f,c,cost='0.001',usage={inputTokens:1000,outputTokens:0}) =>
  rpc(db,'bill2_record',f.actor,f.run,c.id,{provider:f.claimPayload.provider,account:'sandbox',model:f.claimPayload.model,
    protocol:f.claimPayload.protocol,providerId:'generation-'+c.id,source:'response',sourceHash:'c'.repeat(64),
    observedAt:new Date().toISOString(),coverage:'request_total',final:cost!==null,cost,currency:'USD',usage});
