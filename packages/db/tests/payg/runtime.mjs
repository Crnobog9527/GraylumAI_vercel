/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {createFixture} from './fixture.mjs';
import {runtimeOwnerCases} from './runtime-owner.mjs';
export async function runtimeCases({db,Client,connectionString,report}) {
  async function setup(extraContext={}) {
    const f=await createFixture(db,{credits:0,threshold:1});
    const session=await rpc(db,'runtime_start',f.actor,randomUUID(),{scope:f.payload.scope});
    const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'synthetic input',instructions:'Answer',
      model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:1,historyItems:0,tools:[],sources:[],network:'deny',...extraContext};
    const payload={...f.payload,input:context};
    const admitted=await rpc(db,'runtime_admit',f.actor,session.sessionId,randomUUID(),context,payload);
    const begin=await rpc(db,'runtime_execution',f.actor,admitted.executionId,'begin',null);
    assert.equal(begin.live,true);assert.equal(begin.epoch,1);
    return {...f,run:admitted.runId,execution:admitted.executionId,session:session.sessionId,context,payload};
  }
  await runtimeOwnerCases({db,Client,connectionString,report,setup});
  const lost=await setup();
  await db.query("UPDATE bill2_runs SET runtime_dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[lost.run]);
  const recoverable=await rpc(db,'runtime_execution',lost.actor,lost.execution,'read',null);
  assert.equal(recoverable.state,'waiting_resume');assert.equal(recoverable.cursor,1);
  assert.equal(recoverable.remainingCalls,8);
  await rpc(db,'runtime_execution',lost.actor,lost.execution,'payg_resume',{epoch:1,cursor:1});
  assert.equal((await rpc(db,'bill2_claim',lost.actor,lost.run,1,{...lost.claimPayload,runtimeEpoch:2})).state,'waiting_credits');
  report.checks.push('expired owner between calls becomes durable waiting without minting an automatic dispatch');
  const f=await setup();
  const call={...f.claimPayload,runtimeEpoch:1};
  const waiting=await rpc(db,'bill2_claim',f.actor,f.run,1,call);
  assert.equal(waiting.state,'waiting_credits');
  const point={epoch:1,state:'waiting_credits',sequence:1,requestHash:call.requestHash,phase:call.phase};
  const saved=await rpc(db,'runtime_execution',f.actor,f.execution,'payg_wait',point);
  assert.equal(saved.cursor,1);assert.equal(saved.epoch,1);assert.equal(saved.remainingCalls,8);
  assert.equal(saved.state,'waiting_credits');
  const read=await rpc(db,'runtime_execution',f.actor,f.execution,'begin',null);
  assert.equal(read.live,false);assert.equal(read.state,'waiting_credits');
  const before=(await db.query('SELECT payload,deadline FROM bill2_runs WHERE id=$1',[f.run])).rows[0];
  // Independent HTTP opportunities cannot mint two live owners for one cursor.
  const other=new Client({connectionString});await other.connect();
  try {
    const outcomes=await Promise.allSettled([db,other].map(c=>rpc(c,'runtime_execution',f.actor,f.execution,
      'payg_resume',{epoch:1,cursor:1})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.match(String(outcomes.find(x=>x.status==='rejected').reason),/RUNTIME_RESUME_CONFLICT/);
  }finally{await other.end();}
  await assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,1,call),/RUNTIME_RESUME_CONFLICT/);
  await assert.rejects(rpc(db,'bill2_claim',f.actor,f.run,1,{...call,runtimeEpoch:2,requestHash:'c'.repeat(64)}),
    /RUNTIME_CHECKPOINT_CONFLICT/);
  // Original run deadline is historical; next call has its own bounded deadline.
  await db.query("UPDATE bill2_runs SET deadline=clock_timestamp()-interval '2 days' WHERE id=$1",[f.run]);
  const short=await rpc(db,'bill2_claim',f.actor,f.run,1,{...call,runtimeEpoch:2});
  assert.equal(short.state,'waiting_credits');
  const wait2=await rpc(db,'runtime_execution',f.actor,f.execution,'payg_wait',{...point,epoch:2,state:'waiting_resume'});
  assert.equal(wait2.cursor,2);assert.equal(wait2.state,'waiting_resume');
  await db.query('UPDATE runtime_sessions SET revision=revision+1 WHERE id=$1',[f.session]);
  await assert.rejects(rpc(db,'runtime_execution',f.actor,f.execution,'payg_resume',{epoch:2,cursor:2}),/RUNTIME_RESUME_SOURCE_CHANGED/);
  await db.query('UPDATE runtime_sessions SET revision=revision-1 WHERE id=$1',[f.session]);
  await rpc(db,'runtime_execution',f.actor,f.execution,'payg_resume',{epoch:2,cursor:2});
  await db.query('UPDATE profiles SET credits=100 WHERE id=$1',[f.actor]);
  const claimed=await rpc(db,'bill2_claim',f.actor,f.run,1,{...call,runtimeEpoch:3});
  assert.ok(claimed.dispatchToken);
  const repeated=await rpc(db,'bill2_claim',f.actor,f.run,1,{...call,runtimeEpoch:3});
  assert.equal(repeated.id,claimed.id);assert.equal(repeated.dispatchToken,null);
  assert.equal((await db.query('SELECT count(*) n FROM bill2_calls WHERE run_id=$1',[f.run])).rows[0].n,'1');
  const deadlines=(await db.query('SELECT dispatch_deadline,recovery_deadline FROM bill2_calls WHERE id=$1',[claimed.id])).rows[0];
  assert.ok(deadlines.dispatch_deadline);assert.equal(deadlines.recovery_deadline-deadlines.dispatch_deadline,86400000);
  await db.query("UPDATE bill2_calls SET dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[claimed.id]);
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,claimed.id,claimed.dispatchToken,false,null)).dispatch,false);
  assert.deepEqual((await db.query('SELECT payload FROM bill2_runs WHERE id=$1',[f.run])).rows[0].payload,before.payload);
  // Owner loss after a prepared claim: only its expired, never-sent grant can be retired.
  await db.query("UPDATE bill2_runs SET runtime_dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[f.run]);
  const expired=await rpc(db,'runtime_execution',f.actor,f.execution,'read',null);
  assert.equal(expired.state,'waiting_resume');assert.equal(expired.cursor,3);
  const old=(await db.query('SELECT * FROM bill2_calls WHERE id=$1',[claimed.id])).rows[0];
  assert.equal(old.state,'cancelled');assert.equal(old.runtime_retryable,true);assert.ok(old.settled_at);
  assert.equal(old.charged_delta,0);assert.equal(old.dispatched_at,null);
  assert.equal((await rpc(db,'runtime_response',f.actor,f.execution,1,call.requestHash)).retryable,true);
  await rpc(db,'runtime_execution',f.actor,f.execution,'payg_resume',{epoch:3,cursor:3});
  const replacement=await rpc(db,'bill2_claim',f.actor,f.run,2,{...call,runtimeEpoch:4});
  assert.notEqual(replacement.id,claimed.id);
  assert.equal((await db.query('SELECT supersedes_call_id FROM bill2_calls WHERE id=$1',[replacement.id])).rows[0].supersedes_call_id,claimed.id);
  assert.equal((await rpc(db,'bill2_dispatch',f.actor,f.run,claimed.id,claimed.dispatchToken,false,null)).dispatch,false);
  await rpc(db,'runtime_execution',f.actor,f.execution,'payg_wait',{...point,epoch:4,sequence:2,state:'waiting_resume'});
  const size=(await db.query("SELECT octet_length(jsonb_build_object('checkpoint',jsonb_build_object('x',''), 'pausedReason',paused_reason)::text) n FROM bill2_runs WHERE id=$1",[f.run])).rows[0].n;
  await db.query("UPDATE bill2_runs SET runtime_checkpoint=jsonb_build_object('x',repeat('x',$2)) WHERE id=$1",[f.run,65536-size]);
  await assert.rejects(db.query("UPDATE bill2_runs SET runtime_checkpoint=jsonb_build_object('x',repeat('x',$2)) WHERE id=$1",[f.run,65537-size]),/bill2_runtime_checkpoint_size/);
  await assert.rejects(db.query("UPDATE bill2_runs SET runtime_checkpoint=jsonb_build_object('x',repeat('x',65536)) WHERE id=$1",[f.run]),
    /bill2_runtime_checkpoint_size/);
  await db.query('SET ROLE authenticated');
  try{await assert.rejects(rpc(db,'runtime_execution',f.actor,f.execution,'payg_resume',{epoch:3,cursor:2}),/permission denied/);}
  finally{await db.query('RESET ROLE');}
  report.checks.push('runtime v2 wait persists without call/hold; read never resumes; dual-client CAS single winner; stale epoch/hash rejected');
  report.checks.push('expired prepared grant retires and releases once; later sequence links original; old token denied; checkpoint exact 65536/+1');
  report.checks.push('historical deadline retained; per-call immutable recovery horizon; repeated claim identity; source drift rejects; payload unchanged');
}
