/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {transport} from '../monthly-refund/adapter.mjs';
import {syntheticSdk} from '../pay-erasure-integration/sdk.mjs';
export async function runExecutor({db,Client,connectionString,require,runAccountErasureExecutor,report}) {
 const service=new Client({connectionString});await service.connect();await service.query('SET ROLE service_role');
 const base=transport(service);
 const fixture=async()=>{
  const actor=randomUUID(),request=randomUUID(),ticket=randomUUID();
  await db.query('insert into profiles(id,credits) values($1,37)',[actor]);
  await db.query("insert into tickets(id,user_id,title,description,attachments) values($1,$2,'synthetic','private',$3)",
   [ticket,actor,JSON.stringify([actor+'/a.png'])]);
  const sdk=syntheticSdk(require('@supabase/supabase-js').createClient,actor);
  const client={...base,storage:sdk.client.storage,auth:sdk.client.auth,rpc(name,args){
   const result=base.rpc(name,args);result.abortSignal=()=>result;return result;
  }};
  const close=()=>db.query('select account_erasure_confirm($1,$2)',[actor,request]);
  const retry=()=>db.query("update account_erasure_requests set executor_attempted_at=null where profile_id=$1",[actor]);
  const row=async()=>(await db.query('select * from account_erasure_requests where profile_id=$1',[actor])).rows[0];
  return {actor,request,ticket,sdk,client,close,retry,row};
 };
 try {
  const first=await fixture();
  const admin=randomUUID();await db.query('insert into profiles(id) values($1)',[admin]);
  await db.query("insert into ticket_replies(ticket_id,user_id,content,attachments) values($1,$2,'synthetic',$3),($1,null,'system','[]')",
   [first.ticket,admin,JSON.stringify([admin+'/reply.png'])]);
  first.sdk.objects.add(admin+'/reply.png');await first.close();
  const done=await runAccountErasureExecutor(first.client);
  assert.equal(done.completed,1,JSON.stringify(done));assert.equal(done.failed,0);
  assert.equal((await first.row()).stage,'completed');assert.equal(first.sdk.objects.size,0);assert.equal(first.sdk.authDeletes(),1);
  assert.equal((await db.query('select credits from profiles where id=$1',[first.actor])).rows[0].credits,37);
  assert.equal((await db.query('select count(*)::int n from tickets where id=$1',[first.ticket])).rows[0].n,0);
  await runAccountErasureExecutor(first.client);assert.equal(first.sdk.authDeletes(),1,'completed identity is not dispatched again');

  const lost=await fixture();await lost.close();
  const remove=lost.client.storage.from.bind(lost.client.storage);let sends=0;
  lost.client.storage={from(bucket){const api=remove(bucket);const original=api.remove.bind(api);
   api.remove=async paths=>{sends++;await original(paths);throw new Error('synthetic lost success');};return api;}};
  const partial=await runAccountErasureExecutor(lost.client);assert.ok(partial.pending>0);assert.equal(lost.sdk.authDeletes(),0);
  assert.equal((await lost.row()).stage,'erasing');assert.ok((await lost.row()).executor_error_codes.includes('ERASURE_STORAGE_PENDING'));
  await lost.retry();const resumed=await runAccountErasureExecutor(lost.client);
  assert.equal(resumed.completed,1,JSON.stringify(resumed));assert.equal(sends,1,'read absence before any repeated remove');

  const barrier=await fixture();await barrier.close();
  const blocker=new Client({connectionString});await blocker.connect();
  try {
   await blocker.query('BEGIN');await blocker.query('select 1');
   const blocked=await runAccountErasureExecutor(barrier.client);
   assert.ok(blocked.pending>0);assert.equal(barrier.sdk.storageDeletes(),0);assert.equal(barrier.sdk.authDeletes(),0);
   assert.ok((await barrier.row()).executor_error_codes.includes('ERASURE_CONTENT_PENDING'));
  } finally {await blocker.query('ROLLBACK');await blocker.end();}
  await barrier.retry();assert.equal((await runAccountErasureExecutor(barrier.client)).completed,1);

  const history=await fixture();
  await db.query('delete from tickets where id=$1',[history.ticket]);
  assert.equal((await db.query('select erasure_history_complete v from profiles where id=$1',[history.actor])).rows[0].v,false);
  await assert.rejects(db.query('update profiles set erasure_history_complete=true where id=$1',[history.actor]),/ERASURE_HISTORY_CANNOT/);
  await history.close();const unknown=await runAccountErasureExecutor(history.client);
  assert.ok(unknown.pending>0);assert.equal(history.sdk.storageDeletes(),0);assert.equal(history.sdk.authDeletes(),0);
  assert.ok((await history.row()).profile_scrubbed_at,'unknown storage history does not postpone unrelated cleanup');

  const locked=await fixture();await locked.close();const token=randomUUID();
  await db.query('BEGIN');
  const claim=(await db.query('select account_erasure_executor_claim($1) v',[token])).rows[0].v;
  assert.equal(claim.profileId,locked.actor);
  assert.equal((await base.rpc('account_erasure_executor_claim',{p_token:randomUUID()})).data.claimed,false,'second connection skips locked request');
  await db.query('COMMIT');
  assert.equal((await base.rpc('account_erasure_executor_claim',{p_token:randomUUID()})).data.claimed,false);
  assert.ok((await base.rpc('account_erasure_executor_proof',{p_profile_id:locked.actor,p_request_id:locked.request,p_token:randomUUID()})).error);
  const finish={p_profile_id:locked.actor,p_request_id:locked.request,p_token:token,p_codes:['ERASURE_EXECUTOR_IO_PENDING'],p_release:false};
  assert.equal((await base.rpc('account_erasure_executor_finish',finish)).data.recorded,true);
  await locked.retry();assert.equal((await base.rpc('account_erasure_executor_claim',{p_token:randomUUID()})).data.claimed,false,'unsettled claim never expires');
  assert.equal((await base.rpc('account_erasure_executor_finish',{...finish,p_token:randomUUID(),p_release:true})).data.recorded,false);
  assert.equal((await base.rpc('account_erasure_executor_finish',{...finish,p_release:true})).data.recorded,true);
  assert.equal((await runAccountErasureExecutor(locked.client)).completed,1);

  for(const role of ['anon','authenticated']) {
   await service.query('SET ROLE '+role);
   for(const [name,args] of [['account_erasure_executor_claim',{p_token:randomUUID()}],
    ['account_erasure_executor_pending',{}],['account_erasure_executor_finish',finish],
    ['account_erasure_executor_proof',{p_profile_id:locked.actor,p_request_id:locked.request,p_token:token}]]) {
    assert.ok((await base.rpc(name,args)).error,role+' cannot execute '+name);
   }
  }
  await service.query('SET ROLE service_role');
  report.checks.push('wired executor + local service SQL + locked SDK synthetic HTTP: success, repeat, barrier/new transaction retry, lost Storage response, history refusal with independent cleanup, durable claim/CAS and denied roles');
 } finally {await service.end();}
}
