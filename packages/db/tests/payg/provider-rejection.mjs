/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {createFixture,claim,receipt} from './fixture.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const proof=f=>{
 const rawBody=JSON.stringify({error:{code:402,message:'Synthetic refusal',metadata:{limit_source:'openrouter_key_limit'}}});
 return {provider:'openrouter',account:'sandbox',model:f.claimPayload.model,protocol:'openrouter-chat-v1',
  evidenceKind:'provider_rejection',requestHash:f.claimPayload.requestHash,providerId:null,cost:null,final:false,
  currency:'USD',source:'response',coverage:'request_total',observedAt:'2026-10-04T00:00:00Z',
  rawBody,sourceHash:hash(rawBody),transport:{httpStatus:402,complete:true,transportIssue:null,sourceHash:hash(rawBody)}};
};
const balance=async(db,f)=>(await db.query('select credits from profiles where id=$1',[f.actor])).rows[0].credits;
async function fixture(db,version){
 const f=await createFixture(db,{empirical:true,bytes:2000});
 if(version==='v1'){
  await rpc(db,'bill2_cancel',f.actor,f.run);await rpc(db,'bill2_finalize',f.actor,f.run);
  f.payload={...f.payload,contractVersion:'bill2.v1',limits:{...f.payload.limits,credits:100,maxPreDeduct:100}};
  f.run=(await rpc(db,'bill2_prepare',f.actor,randomUUID(),f.payload)).id;
 }
 return f;
}
export async function providerRejectionCases({db,Client,connectionString}){
 for(const version of ['v1','v2']){
  const f=await fixture(db,version),c=await claim(db,f),e=proof(f);
  assert.ok(await balance(db,f)<100);
  await rpc(db,'bill2_record',f.actor,f.run,c.id,e);
  assert.equal((await rpc(db,'bill2_read',f.actor,f.run)).state,'refunded');
  assert.equal(await balance(db,f),100);
  const snapshot=(await db.query('select id,amount from credit_transactions where bill2_run_id=$1 order by id',[f.run])).rows;
  await rpc(db,'bill2_record',f.actor,f.run,c.id,e);
  await rpc(db,'bill2_cancel',f.actor,f.run);await rpc(db,'bill2_finalize',f.actor,f.run);
  assert.deepEqual((await db.query('select id,amount from credit_transactions where bill2_run_id=$1 order by id',[f.run])).rows,snapshot);
  assert.equal((await db.query('select provider_rejected,dispatched_at is not null sent from bill2_calls where id=$1',[c.id])).rows[0].sent,true);
  // A contradictory late provider cost is retained as conflict, never charged again.
  await receipt(db,f,c,'0.001');
  assert.equal(await balance(db,f),100);
  assert.equal((await db.query('select selected_cost_usd::text cost from bill2_calls where id=$1',[c.id])).rows[0].cost,'0');
  assert.equal((await rpc(db,'bill2_read',f.actor,f.run)).conflict,true);

  const prior=await fixture(db,version),first=await claim(db,prior);
  await receipt(db,prior,first,'0.001',{inputTokens:1000,outputTokens:0});
  const next=await claim(db,prior,2);
  await rpc(db,'bill2_record',prior.actor,prior.run,next.id,proof(prior));
  assert.equal(await balance(db,prior),99,'previous paid call is never compensated');
  assert.equal((await rpc(db,'bill2_read',prior.actor,prior.run)).state,'settled');
  assert.equal((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_compensation'",[prior.run])).rows[0].n,0);

  // Unknown transport results have no refusal evidence in either billing contract.
  for(const status of [null,503,200]){
   const unknown=await fixture(db,version),uc=await claim(db,unknown),held=await balance(db,unknown);
   await rpc(db,'bill2_record',unknown.actor,unknown.run,uc.id,{...proof(unknown),
    evidenceKind:'transport_observation',transport:{httpStatus:status,complete:status!==null}});
   await rpc(db,'bill2_cancel',unknown.actor,unknown.run);await rpc(db,'bill2_finalize',unknown.actor,unknown.run);
   assert.equal(await balance(db,unknown),held);
   assert.notEqual((await rpc(db,'bill2_read',unknown.actor,unknown.run)).state,'refunded');
  }

  // Real overlap: hold the run lock until both rejection and cancellation queue.
  const race=await fixture(db,version),rc=await claim(db,race);
  const lock=new Client({connectionString}),a=new Client({connectionString}),b=new Client({connectionString});
  await Promise.all([lock.connect(),a.connect(),b.connect()]);
  try{
   await lock.query('begin');await lock.query('select id from bill2_runs where id=$1 for update',[race.run]);
   const writes=[rpc(a,'bill2_record',race.actor,race.run,rc.id,proof(race)),rpc(b,'bill2_cancel',race.actor,race.run)];
   // Wait on actual lock contention, not a timing-only race.
   let queued=false;
   for(let i=0;i<50;i++){
    const n=(await lock.query("select count(*)::int n from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and datname=current_database()")).rows[0].n;
    if(n>=2){queued=true;break;}await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal(queued,true);await lock.query('commit');await Promise.all(writes);
   await rpc(db,'bill2_finalize',race.actor,race.run);
   assert.equal(await balance(db,race),100);
   assert.equal((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_release'",[race.run])).rows[0].n,1);
  }finally{await lock.query('rollback');await Promise.all([lock.end(),a.end(),b.end()]);}
 }
 // An earlier unknown v1 call stays held when the later call is definitely refused.
 const f=await fixture(db,'v1');await claim(db,f);const c=await claim(db,f,2);
 await rpc(db,'bill2_record',f.actor,f.run,c.id,proof(f));
 assert.notEqual((await rpc(db,'bill2_read',f.actor,f.run)).state,'refunded');
 assert.equal(await balance(db,f),0);
 // v2 already prohibits admitting a new call until the prior call is settled.
 const v2=await fixture(db,'v2');await claim(db,v2);
 await assert.rejects(claim(db,v2,2),/BILL2_CALL_PENDING/);
 for(const patch of [{requestHash:'f'.repeat(64)},{providerId:'gen-conflict'},{cost:'0'},
  {transport:{httpStatus:500,complete:true}},{rawBody:'{"error":{"code":402}}'},
  {rawBody:JSON.stringify({error:{code:402,message:'synthetic',metadata:{limit_source:'other'}}})},
  {rawBody:JSON.stringify({id:'gen-conflict',error:{code:402,message:'synthetic',metadata:{limit_source:'openrouter_key_limit'}}})}]){
  const invalid=await fixture(db,'v2'),call=await claim(db,invalid),held=await balance(db,invalid);
  const evidence={...proof(invalid),...patch};
  if(patch.rawBody){evidence.sourceHash=hash(patch.rawBody);evidence.transport.sourceHash=evidence.sourceHash;}
  await assert.rejects(rpc(db,'bill2_record',invalid.actor,invalid.run,call.id,evidence),/REJECTION_PROOF_DENIED/);
  assert.equal(await balance(db,invalid),held);
 }
}
