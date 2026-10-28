/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-2 (0420): the new core-path tables hold what the plan says and refuse what it forbids. Constraints, owner-keyed
// foreign keys, what account erasure keeps and removes, privileges, and that each query shape of the coming functions has an index.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
// Statements run in autocommit, so a refused one leaves nothing behind.
async function refused(sql,args,pattern){
 try{await c.query(sql,args);}catch(e){assert.match(e.message,pattern,sql);return;}
 assert.fail('accepted: '+sql);
}
async function account(){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,100)',[actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session};
}
const openTurn=async(a,kind='chat',extra={})=>one(
 'insert into turns(actor_id,session_id,request_id,kind,state,reserved_credits,policy) values($1,$2,$3,$4,$5,$6,$7) returning id v',
 [a.actor,a.session,extra.request??randomUUID(),kind,extra.state??'running',extra.reserved??10,JSON.stringify(extra.policy??{q:'100'})]);
const call=(a,turn,seq,extra={})=>c.query(
 `insert into turn_calls(actor_id,turn_id,seq,call_kind,model_id,tool_name,status,nominal_usd,actual_usd,multiplier,usage,generation_id,payload_hash,cost_pending)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
 [extra.actor??a.actor,turn,seq,extra.kind??'model',extra.kind==='tool'?null:randomUUID(),extra.kind==='tool'?'research_search':null,
  extra.status??'ok',extra.nominal??'0.01','actual' in extra?extra.actual:'0.01',extra.m??'6',JSON.stringify({cache_read:0}),'gen-'+seq,hash(String(seq)),
  extra.pending??false]);
const message=(a,turn,seq,role='user')=>c.query(
 'insert into session_messages(session_id,seq,role,turn_id,content,content_hash) values($1,$2,$3,$4,$5,$6)',
 [a.session,seq,role,turn,'text '+seq,hash('text '+seq)]);
try{
 // 1. Five tables, row security on, and no table privilege for any API role: only SECURITY DEFINER functions (0421) touch them.
 for(const t of ['turns','turn_calls','turn_call_raw','session_messages','daily_spend']){
  assert.equal(await one('select relrowsecurity v from pg_class where oid=$1::regclass',['public.'+t]),true,t);
  for(const role of ['anon','authenticated','service_role'])for(const p of ['SELECT','INSERT','UPDATE','DELETE'])
   assert.equal(await one('select has_table_privilege($1,$2,$3) v',[role,'public.'+t,p]),false,`${role} ${p} ${t}`);
 }
 assert.equal(await one("select count(*)::int v from information_schema.columns where table_name='runtime_sessions' and column_name='active_turn_id'"),1);
 report.checks.push('five new tables with row security and no privilege for anon, authenticated or service_role; runtime_sessions.active_turn_id');

 // 2. A turn: idempotent per (actor, request); the state machine columns stay consistent.
 const a=await account(),b=await account();
 const request=randomUUID(),t1=await openTurn(a,'chat',{request});
 await refused('insert into turns(actor_id,session_id,request_id,kind) values($1,$2,$3,$4)',[a.actor,a.session,request,'chat'],/turns_actor_id_request_id_key/);
 assert.ok(await openTurn(b,'chat',{request}),'the same request id under another actor is another turn');
 await refused("insert into turns(actor_id,session_id,request_id,kind) values($1,$2,$3,'image')",[a.actor,a.session,randomUUID()],/check/);
 await refused("update turns set state='paused' where actor_id=$1 and id=$2",[a.actor,t1],/check/);
 await c.query("update turns set state='paused',pause_reason='waiting_credits' where actor_id=$1 and id=$2",[a.actor,t1]);
 await refused("update turns set state='closed',pause_reason=null where actor_id=$1 and id=$2",[a.actor,t1],/check/);
 await c.query("update turns set state='closed',pause_reason=null,close_kind='completed',closed_at=now() where actor_id=$1 and id=$2",[a.actor,t1]);
 // Only a report can be stopped (Owner 10-28: no user stop in chat or mentor).
 const chat=await openTurn(a,'chat'),report1=await openTurn(a,'report');
 await refused("update turns set stopped_by_user=true where actor_id=$1 and id=$2",[a.actor,chat],/check/);
 await refused("update turns set state='closed',close_kind='stopped',closed_at=now() where actor_id=$1 and id=$2",[a.actor,chat],/check/);
 await c.query("update turns set stopped_by_user=true,state='closed',close_kind='stopped',closed_at=now() where actor_id=$1 and id=$2",[a.actor,report1]);
 // A resumed turn points at an earlier turn of the same actor only.
 await c.query('insert into turns(actor_id,session_id,request_id,kind,resume_of) values($1,$2,$3,$4,$5)',[a.actor,a.session,randomUUID(),'chat',chat]);
 await refused('insert into turns(actor_id,session_id,request_id,kind,resume_of) values($1,$2,$3,$4,$5)',[b.actor,b.session,randomUUID(),'chat',chat],/foreign key/);
 report.checks.push('one turn per (actor, request); pause needs a reason and close needs a kind and time; only a report can be stopped; resume_of stays within the actor');

 // 3. Receipts: one per (turn, seq), bound to the turn's own actor; 402 costs nothing; a pending cost has no actual cost yet.
 const t2=await openTurn(a);
 await call(a,t2,1);
 await assert.rejects(call(a,t2,1),/turn_calls_pkey/);
 await assert.rejects(call(a,t2,2,{actor:b.actor}),/foreign key/);
 await assert.rejects(call(a,t2,2,{status:'no_charge_402',nominal:'0.02'}),/check/);
 await assert.rejects(call(a,t2,2,{pending:true}),/check/);
 await call(a,t2,2,{status:'no_charge_402',nominal:'0'});
 await call(a,t2,3,{kind:'tool',status:'unknown',nominal:'0',actual:null,pending:true});
 // The raw body lives apart from the hot row, at most 256 KB.
 await c.query("insert into turn_call_raw(turn_id,seq,body) values($1,1,repeat('x',262144))",[t2]);
 await refused("insert into turn_call_raw(turn_id,seq,body) values($1,2,repeat('x',262145))",[t2],/check/);
 await refused("insert into turn_call_raw(turn_id,seq,body) values($1,9,'x')",[t2],/foreign key/);
 report.checks.push('receipts are unique per (turn, seq) and bound to the same actor; 402 is free; pending cost has no actual cost; raw body <= 256 KB beside the row');

 // 4. History: unique per (session, seq); account erasure deletes the session: its messages go, the turns and receipts stay
 // as financial evidence with the session reference cleared, and deleting a receipt removes its raw body.
 await message(a,t2,1);await message(a,t2,2,'assistant');
 await assert.rejects(message(a,t2,2),/session_messages_session_id_seq_key/);
 const turnsBefore=await one('select count(*)::int v from turns where actor_id=$1',[a.actor]);
 await c.query('delete from runtime_sessions where id=$1',[a.session]);
 assert.equal(await one('select count(*)::int v from session_messages where session_id=$1',[a.session]),0);
 assert.equal(await one('select count(*)::int v from turns where actor_id=$1 and session_id is null',[a.actor]),turnsBefore);
 assert.equal(await one('select count(*)::int v from turn_calls where turn_id=$1',[t2]),3);
 await c.query('delete from turn_calls where turn_id=$1 and seq=1',[t2]);
 assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[t2]),0);
 report.checks.push('history unique per (session, seq); deleting a session removes its messages and keeps turns and receipts (session reference cleared); raw body follows its receipt');

 // 5. Stop-loss rows: 16 actor buckets and the large-kind row -1, never negative.
 await c.query("insert into daily_spend(day,bucket,reserved_usd) values(current_date,-1,1),(current_date,15,1)");
 await refused("insert into daily_spend(day,bucket) values(current_date,16)",[],/check/);
 await refused("update daily_spend set reserved_usd=reserved_usd-2 where day=current_date and bucket=15",[],/check/);
 report.checks.push('daily_spend: buckets -1..15 only, reservations and spend never negative');

 // 6. Every query shape the core functions and the recovery job will run has an index (seq scan off proves the index applies).
 await c.query('BEGIN');
 try{
  await c.query('SET LOCAL enable_seqscan=off');
  const plan=async sql=>(await c.query('EXPLAIN '+sql)).rows.map(r=>r['QUERY PLAN']).join('\n');
  const shapes=[
   [`select * from turns where actor_id='${b.actor}' and request_id='${request}'`,null],
   [`select * from turns where actor_id='${b.actor}' and id=1`,null],
   [`select * from turns where state in ('running','paused') and updated_at<now()-interval '15 minutes' order by updated_at limit 50`,/turns_live/],
   [`select count(*) from turns where actor_id='${b.actor}' and kind='report' and stopped_by_user and closed_at>now()-interval '24 hours'`,null],
   [`select * from turns where settlement='pending' order by updated_at limit 50`,/turns_settlement_pending/],
   [`select * from turn_calls where turn_id=1 order by seq`,/turn_calls_pkey/],
   [`select * from turn_calls where cost_pending order by created_at limit 50`,/turn_calls_cost_pending/],
   [`select * from session_messages where session_id='${b.session}' and visible and deleted_at is null order by seq desc limit 100`,/session_messages_history/],
   [`select sum(reserved_usd+spent_usd) from daily_spend where day=current_date`,/daily_spend_pkey/],
   [`delete from turn_call_raw where created_at<now()-interval '30 days'`,/turn_call_raw_created/],
  ];
  // Owner-keyed lookups may use any owner-keyed index; lookups without an owner key must use their own partial index.
  for(const [sql,index] of shapes){const p=await plan(sql);assert.doesNotMatch(p,/Seq Scan/,sql+'\n'+p);if(index)assert.match(p,index,sql+'\n'+p);}
 }finally{await c.query('ROLLBACK');}
 report.checks.push('no lookup of the core functions or the recovery and cleanup jobs needs a sequential scan; the jobs use their partial indexes');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
