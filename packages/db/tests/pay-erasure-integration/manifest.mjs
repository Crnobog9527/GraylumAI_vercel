/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {transport} from '../monthly-refund/adapter.mjs';
import {syntheticSdk} from './sdk.mjs';
export async function runManifest(input){
 const {db,Client,connectionString,report,require,createErasureAttachmentManifest,
  createErasureStorageAdapter,createErasureStorageTransport,createErasureAuthAdapter,processAccountErasure}=input;
 const fixture=async()=>{
  const actor=randomUUID(),admin=randomUUID(),other=randomUUID(),ticket=randomUUID(),open=randomUUID();
  await db.query('insert into profiles(id) values($1),($2),($3)',[actor,admin,other]);
  await db.query(`insert into tickets(id,user_id,title,description,attachments,is_deleted,deleted_at)
   values($1,$2,'Synthetic','Synthetic',$3,'true',clock_timestamp()-interval '40 days'),
   ($4,$5,'Synthetic','Synthetic','[]','true',clock_timestamp()-interval '40 days')`,
   [ticket,actor,JSON.stringify([actor+'/a.png']),open,other]);
  await db.query(`insert into ticket_replies(ticket_id,user_id,content,attachments,is_deleted,deleted_at)
   values($1,$2,'Synthetic',$3,'true',clock_timestamp()-interval '40 days')`,[ticket,admin,JSON.stringify([admin+'/reply.png'])]);
  return {actor,admin,other,ticket,open};
 };
 const f=await fixture();
 await db.query('select account_erasure_confirm($1,$2)',[f.actor,randomUUID()]);
 const inherited=(await db.query("select f from monthly_test.upgrade_facts where kind='closed'")).rows[0].f;
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);await assert.rejects(db.query('select * from purge_deleted_records(30)'),/permission denied/);
  await db.query('RESET ROLE');
 }
 await db.query('SET ROLE service_role');await db.query('select * from purge_deleted_records(30)');await db.query('RESET ROLE');
 assert.equal((await db.query('select count(*)::int n from tickets where id=$1',[f.open])).rows[0].n,0,'ordinary retention still purges');
 assert.equal((await db.query('select count(*)::int n from tickets where id=ANY($1)',[[f.ticket,inherited.ticket]])).rows[0].n,2);
 assert.equal((await db.query('select count(*)::int n from ticket_replies where ticket_id=ANY($1)',[[f.ticket,inherited.ticket]])).rows[0].n,2);
 assert.deepEqual((await db.query('select title,description from tickets where id=$1',[f.ticket])).rows[0],{title:'',description:''});
 assert.equal((await db.query('select content from ticket_replies where ticket_id=$1',[f.ticket])).rows[0].content,'');
 await assert.rejects(db.query("update tickets set description='refill' where id=$1",[f.ticket]),/ACCOUNT_ERASURE/);
 await assert.rejects(db.query("update tickets set description='',attachments='[]' where id=$1",[f.ticket]),/ACCOUNT_ERASURE/);
 await db.query('SET ROLE service_role');
 await assert.rejects(db.query("update tickets set description='' where id=$1",[f.ticket]),/permission denied/);
 await db.query('select * from purge_deleted_records(30)');await db.query('RESET ROLE');
 const sdk=syntheticSdk(require('@supabase/supabase-js').createClient,f.actor);sdk.objects.add(f.admin+'/reply.png');
 const database=transport(db);
 const manifest=createErasureAttachmentManifest({client:database,limits:{pageSize:2,maxRows:10000,timeoutMs:5000},
  // Synthetic fixture created in this local run with no prior purge; never a deployment claim.
  verifyRetainedHistory:async profile=>{assert.equal(profile,f.actor);}});
 const missing=createErasureAttachmentManifest({client:database});
 assert.equal((await createErasureStorageAdapter({manifest:missing,storage:createErasureStorageTransport(sdk.client)}).cleanSubject(f.actor)).complete,false);
 assert.equal(sdk.storageDeletes(),0);
 const rpc=async(name,args)=>{await db.query('SET ROLE service_role');
  try{return await database.rpc(name,args);}finally{await db.query('RESET ROLE');}};
 const result=await processAccountErasure({profileId:f.actor,database:{rpc},
  storageAdapter:createErasureStorageAdapter({manifest,storage:createErasureStorageTransport(sdk.client)}),
  authAdapter:createErasureAuthAdapter(sdk.client,f.actor),budget:{deadline:Date.now()+30000,operationTimeoutMs:5000}});
 assert.equal(result.stage,'completed',JSON.stringify(result));assert.equal(sdk.objects.size,0);assert.equal(sdk.authDeletes(),1);
 assert.equal((await db.query('select count(*)::int n from tickets where id=$1',[f.ticket])).rows[0].n,0);
 const g=await fixture();const closing=new Client({connectionString}),purging=new Client({connectionString});
 await closing.connect();await purging.connect();
 try{
  await closing.query('BEGIN');await closing.query('select account_erasure_confirm($1,$2)',[g.actor,randomUUID()]);
  const pid=(await purging.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending=purging.query('select * from purge_deleted_records(30)');
  let waiting=false;
  for(let attempt=0;attempt<100&&!waiting;attempt++){
   waiting=(await db.query("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') v",[pid])).rows[0].v;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(waiting,'purge waits for closure profile lock');await closing.query('COMMIT');await pending;
  assert.equal((await db.query('select count(*)::int n from tickets where id=$1',[g.ticket])).rows[0].n,1);
 }finally{await closing.query('ROLLBACK');await closing.end();await purging.end();}
 const stale=await fixture();const snapshotClient=new Client({connectionString});await snapshotClient.connect();
 try{
  await snapshotClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await snapshotClient.query('select id from profiles where id=$1',[stale.actor]);
  await db.query('select account_erasure_confirm($1,$2)',[stale.actor,randomUUID()]);
  await assert.rejects(snapshotClient.query('select * from purge_deleted_records(30)'),error=>error.code==='40001');
  await snapshotClient.query('ROLLBACK');
  assert.equal((await db.query('select count(*)::int n from tickets where id=$1',[stale.ticket])).rows[0].n,1);
 }finally{await snapshotClient.query('ROLLBACK');await snapshotClient.end();}
 report.checks.push('0196 populated upgrade retains admin references; ordinary purge unchanged; public denied/service allowed; two-connection closure/purge lock');
 report.checks.push('real metadata manifest + locked SDK mock HTTP + processor/SQL: unknown historical coverage removes nothing; admin objects clean before references/Auth');
}
