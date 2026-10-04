/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {claim,receipt} from './fixture.mjs';
import {fixture,proof,balance} from './provider-rejection.mjs';
const recover=(db,f,c)=>rpc(db,'bill2_recovery_claim',f.actor,f.run,c.id);
const record=(db,f,c,e)=>rpc(db,'bill2_record',f.actor,f.run,c.id,e);
const age=(db,c)=>db.query("update bill2_calls set rejection_recovery_at=clock_timestamp()-interval '5 minutes' where id=$1",[c.id]);
function pending(f,c){
 const e=proof(f),providerId='gen-synthetic-'+c.id;
 return {...e,evidenceKind:'provider_rejection_pending',providerId,transport:{...e.transport,generationId:providerId}};
}
function lookup(f,identity,status=404){
 return {provider:'openrouter',account:'sandbox',model:f.claimPayload.model,protocol:'openrouter-chat-v1',
  expectedProviderId:identity.providerId,providerId:null,cost:null,final:false,currency:'USD',
  source:'lookup',coverage:'request_total',observedAt:new Date().toISOString(),sourceHash:'d'.repeat(64),
  rejectionRecovery:identity.rejectionRecovery,
  evidenceKind:status===404?'provider_rejection_lookup':'transport_observation',
  transport:{httpStatus:status,complete:status!==null,transportIssue:status===null?'timeout':null}};
}
export async function providerRejectionLookupCases({db,Client,connectionString}){
 for(const version of ['v1','v2']){
  for(const scenario of ['missing','cost','terminal-no-cost','failure','5xx','erased']){
   const f=await fixture(db,version);
   if(scenario==='erased')await db.query('select b2a_test.bind($1)',[f]);
   const c=await claim(db,f),held=await balance(db,f);
   await record(db,f,c,pending(f,c));
   if(scenario==='erased')await closeAccount(db,f);
   assert.equal(await balance(db,f),held,'402 with ID alone does not release');
   let last;
   for(let i=1;i<=3;i++){
    // Local clock simulation only. Assert the real SQL interval gate before advancing it.
    if(i>1){
     assert.equal(await recover(db,f,c),null);
     await db.query("update bill2_calls set rejection_recovery_at=clock_timestamp()-interval '4 minutes 59 seconds' where id=$1",[c.id]);
     assert.equal(await recover(db,f,c),null,'minimum interval is five minutes');
     await age(db,c);
    }
    const identity=await recover(db,f,c);
    assert.equal(identity.rejectionRecovery.attempt,i);
    assert.ok(Date.parse(identity.rejectionRecovery.claimedAt));
    const e=lookup(f,identity,i===2&&scenario==='failure'?null:i===2&&scenario==='5xx'?503:404);
    if(i===2&&(scenario==='cost'||scenario==='terminal-no-cost')){
     e.providerId=identity.providerId;delete e.evidenceKind;
     e.final=scenario==='cost';e.cost=scenario==='cost'?'0.001':null;
     e.usage=scenario==='cost'?{inputTokens:1000,outputTokens:0}:null;
     e.transport.httpStatus=200;
     // Raw synthetic content must be removed even for non-404 query records.
     e.rawBody='SYNTHETIC_PRIVATE';
    }
    await record(db,f,c,e);last=e;
    const snapshot=(await db.query('select id,amount from credit_transactions where bill2_run_id=$1 order by id',[f.run])).rows;
    await record(db,f,c,e);
    assert.deepEqual((await db.query('select id,amount from credit_transactions where bill2_run_id=$1 order by id',[f.run])).rows,snapshot);
    await assert.rejects(record(db,f,c,{...e,sourceHash:'e'.repeat(64)}),/REJECTION_LOOKUP_DENIED/);
    if(scenario==='cost'&&i===2){await rpc(db,'bill2_finalize',f.actor,f.run);break;}
    if(i<3)assert.equal(await balance(db,f),held);
   }
   const success=['missing','erased'].includes(scenario);
   const state=(await db.query('select provider_rejected,recovery_attempts,selected_cost_usd::text cost from bill2_calls where id=$1',[c.id])).rows[0];
   assert.equal(state.provider_rejected,success);
   assert.equal(await balance(db,f),success?100:scenario==='cost'?99:held);
   const rows=(await db.query('select payload from bill2_receipts where call_id=$1',[c.id])).rows;
   assert.doesNotMatch(JSON.stringify(rows),/rawBody|"transport"|SYNTHETIC_PRIVATE|synthetic-user|Synthetic refusal/);
   const audits=rows.filter(r=>r.payload.rejectionRecovery).map(r=>r.payload.rejectionRecovery);
   assert.equal(audits.filter(a=>a.notFound).length,success?3:scenario==='cost'?1:2);
   for(const a of audits){assert.ok(a.claimedAt);assert.ok(a.observedAt);assert.ok(Number.isInteger(a.notFoundCount));}
   assert.equal(await recover(db,f,c),null,'exhaustion/settlement cannot start another lookup');
   await record(db,f,c,last);await rpc(db,'bill2_finalize',f.actor,f.run);
   assert.equal(await balance(db,f),success?100:scenario==='cost'?99:held);
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
   await record(db,f,c,lookup(f,claims.find(Boolean)));
   for(let i=2;i<=3;i++){
    await age(db,c);const e=lookup(f,await recover(db,f,c));
    await Promise.all([record(a,f,c,e),record(b,f,c,e)]);
   }
   assert.equal(await balance(db,f),99);
   const releases=(await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_release'",[f.run])).rows[0].n;
   assert.equal(releases,version==='v1'?1:2);
  }finally{await Promise.all([a.end(),b.end()]);}
 }
 const f=await fixture(db,'v1');await claim(db,f);const c=await claim(db,f,2);
 await record(db,f,c,pending(f,c));
 for(let i=1;i<=3;i++){if(i>1)await age(db,c);await record(db,f,c,lookup(f,await recover(db,f,c)));}
 assert.equal(await balance(db,f),0,'unknown sibling reservation must stay frozen');
 assert.equal((await rpc(db,'bill2_read',f.actor,f.run)).state,'cost_pending');
}
