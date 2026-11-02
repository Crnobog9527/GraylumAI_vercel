/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// FUSION-REVIEW PR-3a (0235): the wired account-erasure executor completes for an account holding a settled
// sessionless Fusion call with a saved output, and removes that output.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {transport} from '../monthly-refund/adapter.mjs';
import {syntheticSdk} from '../pay-erasure-integration/sdk.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
import {createFixture} from '../payg/fixture.mjs';
export async function runFusionExecutor({db,Client,connectionString,require,runAccountErasureExecutor,report}) {
 const service=new Client({connectionString});await service.connect();
 await service.query('SET ROLE service_role');
 try {
  const f=await createFixture(db,{credits:9,phase:'fusion_review'});
  const session=randomUUID();
  await db.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
   [session,f.actor,f.payload.scope,randomUUID()]);
  const group=await rpc(db,'fusion_group_create',f.actor,randomUUID(),'review',session);
  await rpc(db,'fusion_group_attach',f.actor,group,f.run);
  const claimed=await rpc(db,'fusion_group_claim',f.actor,group,'review:1',1,
   JSON.stringify([{runId:f.run,sequence:1,payload:f.claimPayload}]));
  const c=claimed.calls[0];
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,c.id,c.dispatchToken)).dispatch,true);
  await rpc(db,'bill2_record',f.actor,f.run,c.id,{provider:f.claimPayload.provider,account:'sandbox',
   model:f.claimPayload.model,protocol:f.claimPayload.protocol,providerId:'generation-'+c.id,source:'response',
   sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.0004',currency:'USD',
   usage:{inputTokens:400,outputTokens:0}});
  await rpc(db,'fusion_call_output_save',f.actor,c.id,'fusion review body');
  await rpc(db,'fusion_call_verdict',f.actor,c.id,'usable');
  await rpc(db,'bill2_finalize',f.actor,f.run);
  await rpc(db,'bill2_cancel',f.actor,f.run);
  const credits=(await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits;
  await db.query('SELECT account_erasure_confirm($1,$2)',[f.actor,randomUUID()]);
  const base=transport(service);
  const sdk=syntheticSdk(require('@supabase/supabase-js').createClient,f.actor);
  const client={...base,storage:sdk.client.storage,auth:sdk.client.auth,rpc(name,args){
   const result=base.rpc(name,args);result.abortSignal=()=>result;return result;
  }};
  // The summary's failure count also covers unrelated housekeeping (e.g. the off-database manifest without Redis
  // in this environment), so this case checks the subject's own outcome.
  const done=await runAccountErasureExecutor(client);
  // The processor settles nothing itself any more: a run still prepared (not settled/refunded) keeps the account in billing_pending,
  // the money untouched and Auth not removed, until the run is closed out (before F, a one-off cleanup of the old runs).
  const stage=async()=>(await db.query('SELECT stage,executor_error_codes FROM account_erasure_requests WHERE profile_id=$1',[f.actor])).rows[0];
  let request=await stage();
  assert.equal(request.stage,'billing_pending',JSON.stringify({done,request}));
  assert.equal(sdk.authDeletes(),0,'an unsettled old run blocks Auth removal');
  assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits,credits,'money untouched while pending');
  await rpc(db,'bill2_cancel',f.actor,f.run);await rpc(db,'bill2_finalize',f.actor,f.run);
  await db.query('UPDATE account_erasure_requests SET executor_attempted_at=NULL WHERE profile_id=$1',[f.actor]);
  const again=await runAccountErasureExecutor(client);
  request=await stage();
  assert.equal(request.stage,'completed',JSON.stringify({again,request}));assert.deepEqual(request.executor_error_codes,[]);
  assert.equal((await db.query('SELECT count(*)::int n FROM fusion_call_outputs WHERE actor_id=$1',[f.actor])).rows[0].n,0);
  assert.equal((await db.query('SELECT credits FROM profiles WHERE id=$1',[f.actor])).rows[0].credits,credits,'money unchanged');
  assert.equal(sdk.authDeletes(),1);
  // A reviewer answer arriving after account erasure must not bring the body back.
  await assert.rejects(rpc(db,'fusion_call_output_save',f.actor,c.id,'late fusion review body'),/BILL2_ACTOR_DENIED/);
  assert.equal((await db.query('SELECT count(*)::int n FROM fusion_call_outputs WHERE actor_id=$1 OR call_id=$2',[f.actor,c.id])).rows[0].n,0,
   'a late Fusion save after account erasure stores nothing');
  report.checks.push('wired account-erasure executor completes for an account with a settled sessionless Fusion call and saved output; output removed, money unchanged; a late output save is refused');
 } finally {await service.end();}
}
