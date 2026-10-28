/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-2 (0420): the new core-path tables hold what the plan says and refuse what it forbids. Constraints, owner-keyed
// foreign keys, what account erasure keeps and removes, privileges, and that each query shape of the coming functions has an index.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
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
// turn_call_begin's insert: dispatched, with the request hash, the bound U_i and the frozen multiplier, no cost yet.
const call=(a,turn,seq,extra={})=>c.query(
 `insert into turn_calls(actor_id,turn_id,seq,call_kind,model_id,tool_name,request_hash,upper_usd,multiplier)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
 [extra.actor??a.actor,turn,seq,extra.kind??'model',extra.kind==='tool'?null:randomUUID(),extra.kind==='tool'?'research_search':null,
  hash('request '+seq),'0.05','6']);
// turn_call_record's final state.
const finish=(turn,seq,set,args=[])=>c.query(`update turn_calls set ${set} where turn_id=$1 and seq=$2`,[turn,seq,...args]);
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

 // 3. Calls (plan 2.5.2): one row per attempt, written before sending; in flight it has no cost; an identified call has its
 // provider id; ok has a nominal cost and a settle time; certainly-free outcomes cost zero; a pending cost is an unknown call.
 const t2=await openTurn(a);
 await call(a,t2,1);
 assert.equal(await one('select status v from turn_calls where turn_id=$1 and seq=1',[t2]),'dispatched');
 await assert.rejects(call(a,t2,1),/turn_calls_pkey/);
 await assert.rejects(call(a,t2,2,{actor:b.actor}),/foreign key/);
 await refused("update turn_calls set nominal_usd=0.01 where turn_id=$1 and seq=1",[t2],/check/);
 await refused("update turn_calls set status='identified' where turn_id=$1 and seq=1",[t2],/check/);
 await finish(t2,1,"status='identified',provider_id='gen-1'");
 await refused("update turn_calls set status='ok' where turn_id=$1 and seq=1",[t2],/check/);
 await finish(t2,1,"status='ok',nominal_usd=0.01,actual_usd=0.01,payload_hash=$3,settled_at=now()",[hash('payload')]);
 for(const [seq,status] of [[2,'no_charge_402'],[3,'not_sent'],[4,'rejected']]){
  await call(a,t2,seq);
  await refused(`update turn_calls set status='${status}',nominal_usd=0.02,settled_at=now() where turn_id=$1 and seq=$2`,[t2,seq],/check/);
  await finish(t2,seq,`status='${status}',nominal_usd=0,settled_at=now()`);
 }
 await call(a,t2,5,{kind:'tool'});
 await refused("update turn_calls set cost_pending=true where turn_id=$1 and seq=5",[t2],/check/);
 await finish(t2,5,"status='unknown',cost_pending=true");
 // The full response lives apart from the hot row, at most 4194304 bytes (the existing persisted receipt limit).
 await c.query("insert into turn_call_raw(turn_id,seq,body) values($1,1,repeat('x',4194304))",[t2]);
 await refused("insert into turn_call_raw(turn_id,seq,body) values($1,2,repeat('x',4194305))",[t2],/check/);
 await refused("insert into turn_call_raw(turn_id,seq,body) values($1,9,'x')",[t2],/foreign key/);
 report.checks.push('a call row is written before sending and moves dispatched -> identified -> ok; no cost in flight; 402, not sent and rejected cost zero; pending cost only when unknown; raw body <= 4194304 bytes beside the row');

 // 4. History: unique per (session, seq); account erasure deletes the session: its messages go, the turns and receipts stay
 // as financial evidence with the session reference cleared, and deleting a receipt removes its raw body.
 await message(a,t2,1);await message(a,t2,2,'assistant');
 await assert.rejects(message(a,t2,2),/session_messages_session_id_seq_key/);
 const turnsBefore=await one('select count(*)::int v from turns where actor_id=$1',[a.actor]);
 await c.query('delete from runtime_sessions where id=$1',[a.session]);
 assert.equal(await one('select count(*)::int v from session_messages where session_id=$1',[a.session]),0);
 assert.equal(await one('select count(*)::int v from turns where actor_id=$1 and session_id is null',[a.actor]),turnsBefore);
 assert.equal(await one('select count(*)::int v from turn_calls where turn_id=$1',[t2]),5);
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
   [`select * from turn_calls where cost_pending order by dispatched_at limit 50`,/turn_calls_cost_pending/],
   [`select * from turn_calls where status in ('dispatched','identified') and dispatched_at<now()-interval '15 minutes' limit 50`,/turn_calls_in_flight/],
   [`select * from session_messages where session_id='${b.session}' and visible and deleted_at is null order by seq desc limit 100`,/session_messages_history/],
   [`select sum(reserved_usd+spent_usd) from daily_spend where day=current_date`,/daily_spend_pkey/],
   [`delete from turn_call_raw where created_at<now()-interval '30 days'`,/turn_call_raw_created/],
  ];
  // Owner-keyed lookups may use any owner-keyed index; lookups without an owner key must use their own partial index.
  for(const [sql,index] of shapes){const p=await plan(sql);assert.doesNotMatch(p,/Seq Scan/,sql+'\n'+p);if(index)assert.match(p,index,sql+'\n'+p);}
 }finally{await c.query('ROLLBACK');}
 report.checks.push('no lookup of the core functions or the recovery and cleanup jobs needs a sequential scan; the jobs use their partial indexes');
 // 7. Account erasure (controller 10-28, option A): raw provider bodies and message text go; turns and turn_calls keep their
 // billing fields (plan 4.6); a turn still open keeps its raw body and counts as remaining; repeating changes nothing.
 {
  const e=await account();
  const closed=await openTurn(e,'chat',{reserved:7}),open=await openTurn(e,'chat');
  for(const t of [closed,open]){
   await call(e,t,1);
   await finish(t,1,"status='ok',nominal_usd=0.01,actual_usd=0.01,payload_hash=$3,settled_at=now()",[hash('p'+t)]);
   await c.query("insert into turn_call_raw(turn_id,seq,body) values($1,1,'provider body')",[t]);
  }
  await c.query("update turns set state='closed',close_kind='completed',closed_at=now(),charged_credits=6,settlement='done' where actor_id=$1 and id=$2",[e.actor,closed]);
  await message(e,closed,1);await message(e,closed,2,'assistant');
  const billing=async()=>(await c.query(`select t.id,t.reserved_credits,t.charged_credits,c.nominal_usd::text n,c.actual_usd::text a,c.multiplier::text m,
   c.provider_id,c.request_hash from turns t join turn_calls c on c.turn_id=t.id and c.actor_id=t.actor_id where t.actor_id=$1 order by t.id`,[e.actor])).rows;
  const before=await billing();
  await c.query('insert into account_erasure_requests(profile_id,request_id) values($1,$2)',[e.actor,randomUUID()]);
  const first=await one('select account_erasure_scrub_turns($1) v',[e.actor]);
  assert.deepEqual(first,{turn_call_raw:1,turn_call_raw_skipped:1,session_messages:2,session_messages_skipped:0});
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[closed]),0);
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[open]),1);
  assert.deepEqual((await c.query("select content,visible,deleted_at is not null d from session_messages where session_id=$1 order by seq",[e.session])).rows,
   [{content:'',visible:false,d:true},{content:'',visible:false,d:true}]);
  assert.deepEqual(await billing(),before,'billing fields are kept');
  assert.deepEqual(await one('select account_erasure_scrub_turns($1) v',[e.actor]),
   {turn_call_raw:0,turn_call_raw_skipped:1,session_messages:0,session_messages_skipped:0},'repeating changes nothing');
  await c.query("update turns set state='closed',close_kind='completed',closed_at=now() where actor_id=$1 and id=$2",[e.actor,open]);
  assert.deepEqual(await one('select account_erasure_scrub_turns($1) v',[e.actor]),
   {turn_call_raw:1,turn_call_raw_skipped:0,session_messages:0,session_messages_skipped:0});
  assert.deepEqual(await billing(),before);
  for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]])
   assert.equal(await one("select has_function_privilege($1,'public.account_erasure_scrub_turns(uuid)','EXECUTE') v",[role]),want,role);
  assert.deepEqual((await c.query(read('packages/db/tests/erasure-coverage-audit.sql'))).rows,[],'every owner table is wired into erasure');
 }
 report.checks.push('account erasure removes raw bodies of closed turns and message text, keeps billing fields, counts an open turn as remaining, repeats without change; service_role only; coverage audit clean');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
