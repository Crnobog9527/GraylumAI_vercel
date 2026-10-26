/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {createFixture,receipt} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';

/** Local PostgreSQL only: Sonnet unit-price fixture, maximum review bytes/output, no provider request. */
export async function boundedBillingCases({c,report}){
 const f=await createFixture(c,{credits:1000,q:'100',multiplier:'3',phase:'ordinary',bytes:32000,
  promptPrice:'2.5',completionPrice:'10',tiers:[{minPromptTokens:0,prompt:'2.5',completion:'10',request:'0'}]});
 assert.equal(f.claimPayload.upperUsd,'0.110480000000');
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_review_model_id',$1::jsonb),
  ('publish_monitor_review_max_usd','"0.30"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[JSON.stringify(f.payload.modelId)]);
 await rpc(c,'publish_monitor_set_auto_review',f.actor,true);
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1",[f.actor]);
 await c.query('SET ROLE service_role');
 const r=(await rpc(c,'publish_monitor_review_claim',20)).find(row=>row.actorId===f.actor);
 const session=await rpc(c,'runtime_session_context',f.actor,r.sessionId);
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Bounded review',instructions:'Read real data',
  model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:2,historyItems:0,
  purposeBudget:{purpose:'interactive',inputBytes:32000,historyItems:0},
  tools:['read_source'],maxToolCalls:1,workspaceContext:true,ownPosts:true,sources:[],network:'deny',
  request:{sessionId:r.sessionId,requestId:r.requestId,input:'Bounded review',selection:{kind:'ordinary',modelId:f.payload.modelId},network:'deny'},
  weeklyReview:{id:r.id,token:r.token,maxCostUsd:r.maxCostUsd}};
 const approved={...f.payload.callPolicy[0],upperUsd:'2.827680000000',inputLimit:196608,outputLimit:32768,
  providerLimits:{...f.payload.callPolicy[0].providerLimits,contextTokens:1000000}};
 const call={...f.claimPayload,providerLimits:approved.providerLimits,runtimeEpoch:1};
 const payload={...f.payload,scope:session.scope,input:context,callPolicy:[approved],
  limits:{...f.payload.limits,costUsd:'0.220960000000',maxCalls:2,maxPreDeduct:67}};
 const admitted=await rpc(c,'runtime_admit',f.actor,r.sessionId,r.requestId,context,payload);
 const replay=await rpc(c,'runtime_admit',f.actor,r.sessionId,r.requestId,context,payload);
 assert.equal(replay.runId,admitted.runId);
 await c.query('RESET ROLE');
 const saved=(await c.query('SELECT budget_usd::text,payload FROM bill2_runs WHERE id=$1',[admitted.runId])).rows[0];
 assert.equal(Number(saved.budget_usd),0.22096);
 assert.equal(saved.payload.limits.costUsd,'0.220960000000');
 assert.equal(saved.payload.input.maxOutputTokens,1000);
 assert.deepEqual(saved.payload.callPolicy,[approved]);
 await c.query('SET ROLE service_role');
 await rpc(c,'runtime_execution',f.actor,admitted.executionId,'begin',null);
 const linked={...f,run:admitted.runId};
 for(const sequence of [1,2]){
  const claim=await rpc(c,'bill2_claim',f.actor,linked.run,sequence,call);
  const repeated=await rpc(c,'bill2_claim',f.actor,linked.run,sequence,call);
  assert.equal(repeated.id,claim.id);assert.equal(repeated.dispatchToken,null);
  assert.equal((await rpc(c,'bill2_dispatch',f.actor,linked.run,claim.id,claim.dispatchToken)).dispatch,true);
  await receipt(c,linked,claim,'0.110480000000',{inputTokens:40192,outputTokens:1000});
  await receipt(c,linked,claim,'0.110480000000',{inputTokens:40192,outputTokens:1000});
 }
 await assert.rejects(rpc(c,'bill2_claim',f.actor,linked.run,3,call),/BILL2_CALL_BUDGET_OR_CONTRACT/);
 await c.query('RESET ROLE');
 const costs=(await c.query(`SELECT count(*)::int n,sum((payload->>'upperUsd')::numeric)::text upper
  FROM bill2_calls WHERE run_id=$1`,[linked.run])).rows[0];
 assert.equal(costs.n,2);assert.equal(Number(costs.upper),0.22096);
 assert.ok(Number(costs.upper)<=0.30);
 report.checks.push('bounded review: BILL2 persists $0.22096, two $0.11048 claims settle once each; third call is refused');
 await c.query('SET ROLE service_role');
 await rpc(c,'runtime_cancel',f.actor,admitted.executionId);
 await c.query('RESET ROLE');
}
