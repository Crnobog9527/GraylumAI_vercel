/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {transport} from '../monthly-refund/adapter.mjs';
import {syntheticSdk} from '../pay-erasure-integration/sdk.mjs';
import {recoverErasureClaim} from '../../../api/scripts/erasure-recovery.mjs';
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
  const unrelated=randomUUID();await db.query('insert into profiles(id) values($1)',[unrelated]);
  await db.query("insert into tickets(user_id,title,description) select $1,'synthetic','unrelated' from generate_series(1,5001)",[unrelated]);
  const parent=(await db.query('select id from tickets where user_id=$1 limit 1',[unrelated])).rows[0].id;
  await db.query("insert into ticket_replies(ticket_id,content) select $1,'unrelated' from generate_series(1,5001)",[parent]);
  const first=await fixture();
  const admin=randomUUID();await db.query('insert into profiles(id) values($1)',[admin]);
  await db.query("insert into ticket_replies(ticket_id,user_id,content,attachments) values($1,$2,'synthetic',$3),($1,null,'system','[]')",
   [first.ticket,admin,JSON.stringify([admin+'/reply.png'])]);
  first.sdk.objects.add(admin+'/reply.png');await first.close();
  const done=await runAccountErasureExecutor(first.client);
  assert.equal(done.completed,1,JSON.stringify(done));assert.equal(done.failed,0);
  assert.equal((await first.row()).stage,'completed');assert.equal(first.sdk.objects.size,0);
  assert.equal((await db.query('select count(*)::int n from tickets where user_id=$1',[unrelated])).rows[0].n,5001);
  assert.equal((await db.query('select count(*)::int n from ticket_replies where ticket_id=$1',[parent])).rows[0].n,5001);
  assert.equal((await db.query('select erasure_history_complete v from profiles where id=$1',[first.actor])).rows[0].v,true);assert.equal(first.sdk.authDeletes(),1);
  assert.equal((await db.query('select credits from profiles where id=$1',[first.actor])).rows[0].credits,37);
  assert.equal((await db.query('select count(*)::int n from tickets where id=$1',[first.ticket])).rows[0].n,0);
  await runAccountErasureExecutor(first.client);assert.equal(first.sdk.authDeletes(),1,'completed identity is not dispatched again');

  assert.equal((await db.query('select erasure_history_complete v from profiles where id=$1',[admin])).rows[0].v,true,
   'verified subject cleanup preserves the other uploader history');
  const adminSdk=syntheticSdk(require('@supabase/supabase-js').createClient,admin);
  await db.query('select account_erasure_confirm($1,$2)',[admin,randomUUID()]);
  const adminDone=await runAccountErasureExecutor({...first.client,storage:adminSdk.client.storage,auth:adminSdk.client.auth});
  assert.equal(adminDone.completed,1,JSON.stringify(adminDone));assert.equal(adminSdk.authDeletes(),1);

  const claimed=await fixture();await claimed.close();let lostClaim=false;
  const claimRpc=claimed.client.rpc.bind(claimed.client);
  claimed.client.rpc=(name,args)=>{const promise=(async()=>{const response=await claimRpc(name,args);
   if(name==='account_erasure_executor_claim'&&!lostClaim&&response.data?.claimed){lostClaim=true;return {data:null,error:{message:'synthetic lost claim'}};}
   return response;})();promise.abortSignal=()=>promise;return promise;};
  const claimRecovered=await runAccountErasureExecutor(claimed.client);
  assert.equal(claimRecovered.completed,1,JSON.stringify(claimRecovered));assert.equal(claimed.sdk.authDeletes(),1);
  assert.equal((await claimed.row()).executor_token,null);

  for(const committed of [false,true]){
   const finished=await fixture();await finished.close();let lostFinish=false;
   const finishRpc=finished.client.rpc.bind(finished.client);
   finished.client.rpc=(name,args)=>{const promise=(async()=>{
    if(name==='account_erasure_executor_finish'&&!lostFinish){lostFinish=true;if(committed)await finishRpc(name,args);
     return {data:null,error:{message:'synthetic uncertain finish'}};}
    return finishRpc(name,args);})();promise.abortSignal=()=>promise;return promise;};
   const result=await runAccountErasureExecutor(finished.client);
   assert.equal(result.failed,0,JSON.stringify(result));assert.equal(result.completed,1);
   assert.equal((await finished.row()).executor_token,null);assert.equal(finished.sdk.authDeletes(),1);
  }

  const preflight=await fixture();await preflight.close();preflight.sdk.setAuth('unknown');
  assert.ok((await runAccountErasureExecutor(preflight.client)).pending>0);
  assert.ok((await preflight.row()).auth_delete_started_at);assert.equal((await preflight.row()).auth_delete_dispatch_ready,true);assert.equal(preflight.sdk.authDeletes(),0);
  preflight.sdk.setAuth('present');await preflight.retry();assert.equal((await runAccountErasureExecutor(preflight.client)).completed,1);
  for(const delayed of [false,true]){
   const intent=await fixture();await intent.close();let lostBegin=false;
   const beginRpc=intent.client.rpc.bind(intent.client);
   intent.client.rpc=(name,args)=>{const promise=(async()=>{const response=await beginRpc(name,args);
    if(name==='account_erasure_auth_begin'&&!lostBegin){lostBegin=true;
     if(delayed)await new Promise(resolve=>setTimeout(resolve,2200));
     return {data:null,error:{message:'synthetic lost Auth begin'}};}
    return response;})();promise.abortSignal=()=>promise;return promise;};
   assert.ok((await runAccountErasureExecutor(intent.client)).pending>0);assert.equal(intent.sdk.authDeletes(),0);
   const before=await intent.row();assert.equal(before.auth_delete_dispatch_ready,true);assert.equal(before.executor_token,null);
   await intent.retry();assert.equal((await runAccountErasureExecutor(intent.client)).completed,1);
   assert.equal(intent.sdk.authDeletes(),1);assert.equal((await intent.row()).auth_delete_started_at.getTime(),before.auth_delete_started_at.getTime());
  }
  const uncertainAuth=await fixture();await uncertainAuth.close();uncertainAuth.sdk.setMode('auth_unknown');
  assert.ok((await runAccountErasureExecutor(uncertainAuth.client)).pending>0);assert.equal(uncertainAuth.sdk.authDeletes(),1);
  assert.equal((await uncertainAuth.row()).auth_delete_dispatch_ready,false);
  uncertainAuth.sdk.setAuth('present');await uncertainAuth.retry();
  assert.ok((await runAccountErasureExecutor(uncertainAuth.client)).pending>0);assert.equal(uncertainAuth.sdk.authDeletes(),1);
  uncertainAuth.sdk.setAuth('absent');await uncertainAuth.retry();assert.equal((await runAccountErasureExecutor(uncertainAuth.client)).completed,1);

  const lost=await fixture();await lost.close();
  const remove=lost.client.storage.from.bind(lost.client.storage);let sends=0;const sentPaths=[];
  lost.client.storage={from(bucket){const api=remove(bucket);const original=api.remove.bind(api);
   api.remove=async paths=>{sends++;sentPaths.push(...paths);const value=await original(paths);
    if(sends===1)throw new Error('synthetic lost success');return value;};return api;}};
  const partial=await runAccountErasureExecutor(lost.client);assert.ok(partial.pending>0);assert.equal(lost.sdk.authDeletes(),0);
  assert.equal((await lost.row()).stage,'erasing');assert.ok((await lost.row()).executor_error_codes.includes('ERASURE_STORAGE_PENDING'));
  await lost.retry();const resumed=await runAccountErasureExecutor(lost.client);
  assert.equal(resumed.completed,1,JSON.stringify(resumed));assert.equal(sends,3);assert.equal(new Set(sentPaths).size,sentPaths.length,'read absence before any repeated remove');

  const barrier=await fixture();await barrier.close();
  const blocker=new Client({connectionString});await blocker.connect();
  try {
   await blocker.query('BEGIN');await blocker.query('select 1');
   const blocked=await runAccountErasureExecutor(barrier.client);
   assert.ok(blocked.pending>0);assert.equal(barrier.sdk.storageDeletes(),0);assert.equal(barrier.sdk.authDeletes(),0);
   assert.ok((await barrier.row()).executor_error_codes.includes('ERASURE_CONTENT_PENDING'));
  } finally {await blocker.query('ROLLBACK');await blocker.end();}
  await barrier.retry();assert.equal((await runAccountErasureExecutor(barrier.client)).completed,1);

  const slow=await fixture();await slow.close();
  const slowFrom=slow.client.storage.from.bind(slow.client.storage);let delayedOnce=false;
  slow.client.storage={from(bucket){const api=slowFrom(bucket);const original=api.remove.bind(api);
   api.remove=async paths=>{const value=await original(paths);if(!delayedOnce){delayedOnce=true;await new Promise(resolve=>setTimeout(resolve,2200));}return value;};return api;}};
  const delayed=await runAccountErasureExecutor(slow.client);
  assert.ok(delayed.pending>0);assert.equal((await slow.row()).executor_token,null,'late settled I/O releases the original claim');
  assert.equal(slow.sdk.authDeletes(),0);await slow.retry();
  assert.equal((await runAccountErasureExecutor(slow.client)).completed,1);

  const many=await fixture();const uploader=randomUUID();await db.query('insert into profiles(id) values($1)',[uploader]);
  const paths=Array.from({length:251},(_,index)=>uploader+'/'+index+'.png');
  await db.query("insert into ticket_replies(ticket_id,user_id,content,attachments) values($1,$2,'synthetic',$3)",
   [many.ticket,uploader,JSON.stringify(paths)]);
  for(const path of paths)many.sdk.objects.add(path);
  await many.close();
  const firstPage=await runAccountErasureExecutor(many.client);assert.ok(firstPage.pending>0);
  const saved=await many.row();assert.ok(saved.storage_manifest_cursor);assert.equal(saved.storage_manifest_done,false);
  assert.match(saved.storage_manifest_cursor,/^[01]:[0-9a-f-]{36}:[0-9]{10}$/,'progress contains row IDs, not filenames');
  assert.equal(many.sdk.authDeletes(),0);await many.retry();
  let lastPage;for(let pass=0;pass<5;pass++){await many.retry();lastPage=await runAccountErasureExecutor(many.client);if(lastPage.completed)break;}
  assert.equal(lastPage.completed,1,JSON.stringify(lastPage));
  assert.equal(many.sdk.objects.size,0);assert.equal((await many.row()).storage_manifest_done,true);
  assert.equal(many.sdk.authDeletes(),1);

  const latency=await fixture();
  const latencyPaths=Array.from({length:8},(_,index)=>uploader+'/latency-'+index+'.png');
  await db.query("insert into ticket_replies(ticket_id,user_id,content,attachments) values($1,$2,'synthetic',$3)",
   [latency.ticket,uploader,JSON.stringify(latencyPaths)]);
  for(const path of latencyPaths)latency.sdk.objects.add(path);
  const latencyFrom=latency.client.storage.from.bind(latency.client.storage);
  latency.client.storage={from(bucket){const api=latencyFrom(bucket);const original=api.listV2.bind(api);
   api.listV2=async args=>{await new Promise(resolve=>setTimeout(resolve,150));return original(args);};return api;}};
  await latency.close();const began=Date.now();const delayedPage=await runAccountErasureExecutor(latency.client);
  assert.ok(Date.now()-began>2000,'normal serial reads exceed a single-request timeout');
  assert.equal(delayedPage.completed,1,JSON.stringify(delayedPage));assert.equal(latency.sdk.objects.size,0);

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
  const receipt={profileId:locked.actor,requestId:locked.request,token,evidence:{workerStopped:true,ioSettled:true,
   workerEvidenceHash:'a'.repeat(64),ioEvidenceHash:'b'.repeat(64),authNeverDispatched:false}};
  await assert.rejects(recoverErasureClaim(locked.client,{...receipt,evidence:{...receipt.evidence,workerStopped:false}}));
  await assert.rejects(recoverErasureClaim(locked.client,{...receipt,token:randomUUID()}),/NOT_CLAIMED/);
  await db.query('BEGIN');await db.query('select 1');
  await assert.rejects(recoverErasureClaim(locked.client,receipt),/RECOVERY_UNKNOWN/);await db.query('ROLLBACK');
  assert.equal((await locked.row()).executor_token,token,'failed recovery leaves original claim untouched');
  assert.equal((await recoverErasureClaim(locked.client,receipt)).recovered,true);
  assert.equal((await recoverErasureClaim(locked.client,receipt)).recovered,true,'repeat observes recorded receipt');
  assert.equal((await locked.row()).executor_recovery_evidence.token,token);
  assert.equal((await runAccountErasureExecutor(locked.client)).completed,1);

  const shared=await fixture();
  await db.query("insert into tickets(user_id,title,description,attachments) values($1,'unrelated','keep',$2)",
   [unrelated,JSON.stringify([shared.actor+'/a.png'])]);
  await db.query("insert into ticket_replies(ticket_id,user_id,content) values($1,$2,'private reply')",[shared.ticket,shared.actor]);
  const retained=uploader+'/shared.png';const independent=Array.from({length:150},(_,n)=>uploader+'/independent-'+n+'.png');
  await db.query("insert into ticket_replies(ticket_id,user_id,content,attachments) values($1,$2,'private with attachments',$3)",
   [shared.ticket,uploader,JSON.stringify([retained,...independent])]);
  await db.query("insert into tickets(user_id,title,description,attachments) values($1,'other','keep',$2)",[unrelated,JSON.stringify([retained])]);
  for(const path of [retained,...independent])shared.sdk.objects.add(path);
  await shared.close();assert.ok((await runAccountErasureExecutor(shared.client)).pending>0);
  assert.equal((await shared.row()).storage_manifest_review,true);
  for(let pass=0;pass<3;pass++){await shared.retry();assert.ok((await runAccountErasureExecutor(shared.client)).pending>0);}
  assert.ok(independent.every(path=>!shared.sdk.objects.has(path)),'retained entries do not starve later exclusive attachments');
  assert.ok(shared.sdk.objects.has(retained));assert.equal((await shared.row()).storage_manifest_done,false);
  assert.ok(shared.sdk.objects.has(shared.actor+'/a.png'));assert.equal(shared.sdk.authDeletes(),0);
  const scrubbed=(await db.query('select title,description,attachments from tickets where id=$1',[shared.ticket])).rows[0];
  assert.equal(scrubbed.title,'');assert.equal(scrubbed.description,'');assert.deepEqual(scrubbed.attachments,[shared.actor+'/a.png']);
  assert.equal((await db.query('select content from ticket_replies where ticket_id=$1',[shared.ticket])).rows[0].content,'');
  await assert.rejects(db.query("update tickets set title='refill' where id=$1",[shared.ticket]),/ACCOUNT_ERASURE/);

  const large=await fixture();for(let n=0;n<5001;n++)large.sdk.objects.add(large.actor+'/large-'+n+'.png');
  await large.close();assert.ok((await runAccountErasureExecutor(large.client)).pending>0);
  const left=large.sdk.objects.size;assert.ok(left<5004&&left>0,'large prefix makes bounded deletion progress');
  await large.retry();await runAccountErasureExecutor(large.client);assert.ok(large.sdk.objects.size<left);
  assert.equal(large.sdk.authDeletes(),0);

  const prefixShared=await fixture();
  const held=Array.from({length:125},(_,n)=>prefixShared.actor+'/000-'+String(n).padStart(3,'0')+'.png');
  const later=Array.from({length:60},(_,n)=>prefixShared.actor+'/zzz-'+n+'.png');
  const laterManifest=Array.from({length:10},(_,n)=>uploader+'/prefix-independent-'+n+'.png');
  await db.query("insert into tickets(user_id,title,description,attachments) values($1,'other','keep',$2)",[unrelated,JSON.stringify(held)]);
  await db.query("insert into ticket_replies(ticket_id,user_id,content,attachments) values($1,$2,'private',$3)",
   [prefixShared.ticket,uploader,JSON.stringify(laterManifest)]);
  for(const path of [...held,...later,...laterManifest])prefixShared.sdk.objects.add(path);
  await prefixShared.close();await runAccountErasureExecutor(prefixShared.client);
  assert.ok((await prefixShared.row()).storage_prefix_cursor);assert.equal((await prefixShared.row()).storage_prefix_review,true);
  for(let pass=0;pass<5;pass++){await prefixShared.retry();assert.ok((await runAccountErasureExecutor(prefixShared.client)).pending>0);}
  assert.ok([...later,...laterManifest].every(path=>!prefixShared.sdk.objects.has(path)));
  assert.ok(held.every(path=>prefixShared.sdk.objects.has(path)));assert.equal(prefixShared.sdk.authDeletes(),0);

  for(const role of ['anon','authenticated']) {
   await service.query('SET ROLE '+role);
   for(const [name,args] of [['account_erasure_executor_claim',{p_token:randomUUID()}],
    ['account_erasure_executor_pending',{}],
    ['account_erasure_executor_recover',{p_profile_id:locked.actor,p_request_id:locked.request,p_token:token,
     p_evidence:receipt.evidence,p_auth_state:'present'}],
    ['account_erasure_attachment_page',{p_profile_id:locked.actor}],
    ['account_erasure_attachment_checkpoint',{p_profile_id:locked.actor,p_request_id:locked.request,p_token:token}],
    ['account_erasure_attachment_classify',{p_profile_id:locked.actor,p_paths:[]}],['account_erasure_executor_finish',finish],
    ['account_erasure_executor_proof',{p_profile_id:locked.actor,p_request_id:locked.request,p_token:token}]]) {
    assert.ok((await base.rpc(name,args)).error,role+' cannot execute '+name);
   }
  }
  await service.query('SET ROLE service_role');
  report.checks.push('wired executor with 5001 unrelated tickets and replies + local service SQL + locked SDK synthetic HTTP: success, repeat, barrier/new transaction retry, lost/slow Storage response, 251-path resumable manifest, serial network latency exceeding two seconds, history refusal with independent cleanup, durable claim/CAS and denied roles');
 } finally {await service.end();}
}
