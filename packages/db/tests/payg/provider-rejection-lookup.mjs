/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {claim,receipt} from './fixture.mjs';
import {fixture,proof,balance} from './provider-rejection.mjs';
const recover=(db,f,c)=>rpc(db,'bill2_recovery_claim',f.actor,f.run,c.id);
const record=(db,f,c,e)=>rpc(db,'bill2_record',f.actor,f.run,c.id,e);
const age=(db,c)=>db.query("update bill2_calls set rejection_recovery_at=clock_timestamp()-interval '60 seconds' where id=$1",[c.id]);
function pending(f,c){
 const e=proof(f),providerId='gen-synthetic-'+c.id;
 return {...e,evidenceKind:'provider_rejection_pending',providerId,transport:{...e.transport,generationId:providerId}};
}
function lookup(f,identity,status=404){
 return {provider:'openrouter',account:'sandbox',model:f.claimPayload.model,protocol:'openrouter-chat-v1',
  expectedProviderId:identity.providerId,providerId:null,cost:null,final:false,currency:'USD',
  source:'lookup',coverage:'request_total',observedAt:new Date().toISOString(),sourceHash:'d'.repeat(64),
  rejectionRecovery:{...identity.rejectionRecovery,queryCount:1,queryTimes:[new Date().toISOString()]},
  lookupOutcome:status===404?'not_found':undefined,
  evidenceKind:status===404?'provider_rejection_lookup':'transport_observation',
  transport:{httpStatus:status,complete:status!==null,transportIssue:status===null?'timeout':null}};
}
export async function providerRejectionLookupCases({db,Client,connectionString}){
 for(const version of ['v1','v2']){
  for(const scenario of ['missing','no-cost','cost','failure','5xx','erased']){
   const f=await fixture(db,version);
   if(scenario==='erased')await db.query('select b2a_test.bind($1)',[f]);
   const c=await claim(db,f),held=await balance(db,f);
   await record(db,f,c,pending(f,c));
   if(scenario==='erased')await closeAccount(db,f);
   assert.equal(await balance(db,f),held,'402 with ID alone does not release');
   const identity=await recover(db,f,c);
   assert.equal(identity.rejectionRecovery.attempt,1);
   assert.equal(await recover(db,f,c),null,'concurrent claim is leased for 60 seconds');
   const e=lookup(f,identity,scenario==='failure'?null:scenario==='5xx'?503:404);
   if(scenario==='cost'||scenario==='no-cost'){
    e.providerId=identity.providerId;e.transport.httpStatus=200;
    e.lookupOutcome=scenario==='no-cost'?'no_cost':undefined;
    if(scenario==='cost'){
     delete e.evidenceKind;e.final=true;e.cost='0.001';e.usage={inputTokens:1000,outputTokens:0};
    }
    e.rawBody='SYNTHETIC_PRIVATE';
   }
   if(scenario==='missing'||scenario==='no-cost'){
    e.rejectionRecovery.queryCount=2;
    e.rejectionRecovery.queryTimes.push(new Date().toISOString());
    e.rejectionRecovery.queryOutcomes=['not_found',scenario==='no-cost'?'no_cost':'not_found'];
   }
   if(scenario==='missing'){
    for(const patch of [
     {lookupOutcome:'no_cost'},
     {rejectionRecovery:{...e.rejectionRecovery,queryCount:3}},
     {rejectionRecovery:{...e.rejectionRecovery,queryTimes:[null,null]}},
     {rejectionRecovery:{...e.rejectionRecovery,queryTimes:['2000-01-01T00:00:00Z'],queryCount:1}},
     {cost:'0.001'},
    ])await assert.rejects(record(db,f,c,{...e,...patch}),/REJECTION_LOOKUP_DENIED/);
   }
   await record(db,f,c,e);
   if(scenario==='cost')await rpc(db,'bill2_finalize',f.actor,f.run);
   const snapshot=(await db.query('select id,amount from credit_transactions where bill2_run_id=$1 order by id',[f.run])).rows;
   await record(db,f,c,e);
   assert.deepEqual((await db.query('select id,amount from credit_transactions where bill2_run_id=$1 order by id',[f.run])).rows,snapshot);
   await assert.rejects(record(db,f,c,{...e,sourceHash:'e'.repeat(64)}),/REJECTION_LOOKUP_DENIED/);
   const success=['missing','no-cost','erased'].includes(scenario);
   const state=(await db.query('select provider_rejected from bill2_calls where id=$1',[c.id])).rows[0];
   assert.equal(state.provider_rejected,success);
   assert.equal(await balance(db,f),success?100:scenario==='cost'?99:held);
   const rows=(await db.query('select payload from bill2_receipts where call_id=$1',[c.id])).rows;
   assert.doesNotMatch(JSON.stringify(rows),/rawBody|"transport"|SYNTHETIC_PRIVATE|synthetic-user|Synthetic refusal/);
   const audit=rows.find(r=>r.payload.rejectionRecovery).payload.rejectionRecovery;
   assert.equal(audit.notFoundCount,scenario==='missing'?2:['erased','no-cost'].includes(scenario)?1:0);
   assert.ok(audit.claimedAt);assert.ok(audit.observedAt);assert.equal(audit.queryTimes.length,audit.queryCount);
   if(!success&&scenario!=='cost'){
    // Failed queries never release or consume a lifetime budget. Later valid proof may settle.
    for(let i=2;i<=4;i++){
     await age(db,c);const again=await recover(db,f,c);
     assert.equal(again.rejectionRecovery.attempt,i);
     await record(db,f,c,lookup(f,again,i===4?404:503));
     assert.equal(await balance(db,f),i===4?100:held);
    }
   }
   assert.equal(await recover(db,f,c),null,'settlement cannot start another lookup');
  }
  // Prior spend survives a later 404 rejection; v1 unknown siblings remain held.
  const f=await fixture(db,version),paid=await claim(db,f);
  await receipt(db,f,paid,'0.001',{inputTokens:1000,outputTokens:0});
  const c=await claim(db,f,2);await record(db,f,c,pending(f,c));
  const a=new Client({connectionString}),b=new Client({connectionString});
  await Promise.all([a.connect(),b.connect()]);
  try{
   const claims=await Promise.all([recover(a,f,c),recover(b,f,c)]);
   assert.equal(claims.filter(Boolean).length,1,'concurrent recovery gets only one timed claim');
   const e=lookup(f,claims.find(Boolean));
   await Promise.all([record(a,f,c,e),record(b,f,c,e)]);
   assert.equal(await balance(db,f),99);
   const releases=(await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_release'",[f.run])).rows[0].n;
   assert.equal(releases,version==='v1'?1:2);
  }finally{await Promise.all([a.end(),b.end()]);}
 }
 const f=await fixture(db,'v1');await claim(db,f);const c=await claim(db,f,2);
 await record(db,f,c,pending(f,c));
 await record(db,f,c,lookup(f,await recover(db,f,c)));
 assert.equal(await balance(db,f),0,'unknown sibling reservation must stay frozen');
 assert.equal((await rpc(db,'bill2_read',f.actor,f.run)).state,'cost_pending');
}
