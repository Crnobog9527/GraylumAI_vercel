/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-9: conversation deletion, content cleanup, account erasure and voice source revocation on the core-path
// tables (turns, turn_calls, turn_call_raw, session_messages). Each block is the core-path equivalent of an old erasure
// scenario (conversation-erasure, content-erasure/instant, content-erasure/cases, turn-core 7), named in its checks line.
// Plan 6.1 V2-9: a long conversation (1000 messages) is deleted within 1 second; allow and deny both tested.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {localDb,root} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[],samples:{}};
const one=async(sql,args=[],client=c)=>(await client.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const {Client}=createRequire(resolve(root,'package.json'))('pg');
const peer=async()=>{const p=new Client({host:c.host,port:c.port,user:'postgres',database:c.database});await p.connect();return p;};
const refusal=async(promise)=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const blocked=async(p,pid)=>{for(let i=0;i<100;i++){if(await one('select pg_blocking_pids($1)<>$2 v',[pid,'{}'],p))return;await new Promise(r=>setTimeout(r,50));}assert.fail('never blocked');};
const policy=(over={})=>({q:100,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:200,inputBytes:1000,
 limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5},...over});
async function account(credits=1000){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,$2)',[actor,credits]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
 await newSession({actor},session);
 return {actor,session};
}
async function newSession(a,id=randomUUID()){
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [id,a.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return id;
}
const open=(a,{session=a.session,pol=policy(),client=c}={})=>
 one('select turn_open($1,$2,$3,$4,$5) v',[a.actor,session,randomUUID(),'chat',JSON.stringify(pol)],client);
const begin=(a,turn,seq=1,client=c)=>one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,'model',randomUUID(),null,null,hash('r'+turn+seq),0.02,6],client);
const record=(a,turn,seq=1,raw='RAW_PRIVATE_BODY',client=c)=>one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,'ok',0.01,0.01,'{}',null,hash('p'+turn+seq),raw],client);
const close=(a,turn,messages=[{role:'user',content:'PRIVATE_Q'},{role:'assistant',content:'PRIVATE_A'}],client=c)=>
 one("select turn_close($1,$2,'completed',$3,true,false,null) v",[a.actor,turn,JSON.stringify(messages)],client);
// One whole turn through the real functions: freeze, receipt with a response body, two messages.
async function turn(a,{session=a.session,pol}={}){
 const o=await open(a,{session,pol});await begin(a,o.turnId);await record(a,o.turnId);return close(a,o.turnId).then(()=>o.turnId);
}
const mark=(a,session=a.session,client=c)=>one('select content_erasure_mark_session($1,$2) v',[a.actor,session],client);
const cleanup=(a,session=a.session)=>one("select content_erasure_confirm($1,'session',$2,null) v",[a.actor,session]);
const content=async session=>(await c.query(`select count(*) filter (where visible)::int visible,count(*) filter (where content<>'')::int text,
  count(*)::int total from session_messages where session_id=$1`,[session])).rows[0];
const raws=session=>one('select count(*)::int v from turn_call_raw r join turns t on t.id=r.turn_id where t.session_id=$1',[session]);
const money=async a=>(await c.query(`select (select credits from profiles where id=$1) credits,
  (select sum(amount)::int from credit_transactions where user_id=$1) ledger,(select count(*)::int from credit_transactions where user_id=$1) rows,
  (select json_agg(json_build_object('id',id,'charged',charged_credits,'absorbed',absorbed_credits,'kind',close_kind) order by id) from turns where actor_id=$1) turns,
  (select json_agg(json_build_object('t',turn_id,'s',seq,'n',nominal_usd,'status',status,'p',provider_id) order by turn_id,seq) from turn_calls where actor_id=$1) calls`,
 [a.actor])).rows[0];
try{
 // 1. conversation-erasure: a long conversation (500 turns, 1000 messages, 500 response bodies) deleted within 1 second.
 {
  const a=await account(100000);
  await turn(a);
  const first=await one('select min(id) v from turns where actor_id=$1',[a.actor]);
  await c.query(`with t as (insert into turns(actor_id,session_id,request_id,kind,state,close_kind,closed_at,policy,reserved_credits,charged_credits,absorbed_credits,settlement,delivered)
    select $1,$2,gen_random_uuid(),'chat','closed','completed',now(),'{}',6,6,0,'done',true from generate_series(1,499) returning id)
   , calls as (insert into turn_calls(actor_id,turn_id,seq,call_kind,model_id,status,request_hash,upper_usd,multiplier,nominal_usd,actual_usd,settled_at)
    select $1,id,1,'model',gen_random_uuid(),'ok',encode(sha256(id::text::bytea),'hex'),0.02,6,0.01,0.01,now() from t returning turn_id,seq)
   , raw as (insert into turn_call_raw(turn_id,seq,body) select turn_id,seq,repeat('RAW_PRIVATE_BODY ',400) from calls)
   insert into session_messages(session_id,seq,role,turn_id,content,content_hash)
    select $2,2+row_number() over (order by t.id,r.role)::int,r.role,t.id,'PRIVATE '||r.role||' '||repeat('x',2000),encode(sha256('x'::bytea),'hex')
    from t cross join (values ('assistant'),('user')) r(role)`,[a.actor,a.session]);
  assert.deepEqual(await content(a.session),{visible:1000,text:1000,total:1000});assert.equal(await raws(a.session),500);
  const before=await money(a);
  // A real statement cancellation rolls the whole deletion back: no marker, nothing hidden, money unchanged.
  await c.query('begin');await c.query("set local statement_timeout='1ms'");
  assert.match(await refusal(mark(a)),/statement timeout/);await c.query('rollback');
  assert.equal(await one('select content_deleted_at v from runtime_sessions where id=$1',[a.session]),null);
  assert.equal((await content(a.session)).visible,1000);assert.deepEqual(await money(a),before);
  // The same 8-second ceiling as staging; the mark itself must stay under 1 second (plan 6.1 V2-9).
  await c.query('begin');await c.query("set local statement_timeout='8s'");
  let start=performance.now();
  assert.equal((await mark(a)).status,'deleted');
  report.samples.markMs=Math.round(performance.now()-start);await c.query('commit');
  assert.ok(report.samples.markMs<1000,`mark ${report.samples.markMs} ms`);
  assert.deepEqual(await content(a.session),{visible:0,text:1000,total:1000},'out of the history at once, text cleared below');
  assert.match(await refusal(open(a)),/TURN_SESSION_ERASED/);
  start=performance.now();
  const swept=await one('select content_erasure_sweep_sessions(200,null,null) v');
  report.samples.cleanupMs=Math.round(performance.now()-start);
  assert.ok(swept.cleaned>=1&&swept.failed===0,JSON.stringify(swept));
  assert.ok(report.samples.cleanupMs<1000,`cleanup ${report.samples.cleanupMs} ms`);
  assert.deepEqual(await content(a.session),{visible:0,text:0,total:1000});assert.equal(await raws(a.session),0);
  assert.equal(await one("select count(*)::int v from session_messages where session_id=$1 and content_hash<>encode(sha256(''::bytea),'hex')",[a.session]),0);
  assert.deepEqual(await money(a),before,'turns, receipts and the ledger are billing records: unchanged');
  assert.equal(await one('select count(*)::int v from turn_calls where actor_id=$1 and turn_id>=$2',[a.actor,first]),500);
  assert.equal((await mark(a)).alreadyDeleted,true);
  const other=await account();
  assert.match(await refusal(mark(other,a.session)),/CONTENT_NOT_FOUND/);
  report.checks.push(`conversation-erasure: 500 turns / 1000 messages / 500 response bodies: timeout rolls back marker and money; mark ${report.samples.markMs} ms (< 1 s), cleanup ${report.samples.cleanupMs} ms; text and bodies gone, billing records unchanged; repeat no-op; other actor refused`);
 }
 // 2. content-erasure/instant "mark": owner only, the marker commits, the history is gone and the next turn refused at once.
 {
  const a=await account();await turn(a);
  for(const role of ['anon','authenticated']){
   await c.query('set role '+role);
   for(const sql of ['select content_erasure_mark_session($1,$2)',"select content_erasure_confirm($1,'session',$2,null)"])
    assert.match(await refusal(c.query(sql,[a.actor,a.session])),/permission denied/);
   await c.query('reset role');
  }
  const stranger=await account();
  assert.match(await refusal(mark(stranger,a.session)),/CONTENT_NOT_FOUND/);
  assert.equal((await content(a.session)).visible,2,'a refused deletion hides nothing');
  const r=await mark(a);
  assert.deepEqual([r.status,r.alreadyDeleted],['deleted',false]);
  assert.deepEqual(await content(a.session),{visible:0,text:2,total:2});
  assert.match(await refusal(open(a)),/TURN_SESSION_ERASED/);
  assert.equal(await one("select count(*)::int v from session_messages where session_id=$1 and visible and deleted_at is null",[a.session]),0);
  assert.equal((await mark(a)).alreadyDeleted,true);
  report.checks.push('instant mark: anon/authenticated denied, other actor CONTENT_NOT_FOUND (nothing hidden); owner mark hides the history at once, next turn refused, repeat no-op');
 }
 // 3. content-erasure/instant "cleanup" and "busy other conversation": the cleanup clears only the marked conversation.
 {
  const a=await account();await turn(a);
  const kept=await newSession(a);await turn(a,{session:kept});
  const p=await peer();
  try{
   await p.query('begin');await p.query('select 1 from runtime_sessions where id=$1 for update',[kept]);
   await mark(a);const r=await cleanup(a);
   assert.equal(r.status,'deleted');
   await p.query('rollback');
  }finally{await p.end();}
  assert.deepEqual(await content(a.session),{visible:0,text:0,total:2});assert.equal(await raws(a.session),0);
  assert.deepEqual(await content(kept),{visible:2,text:2,total:2},'the other conversation is untouched');assert.equal(await raws(kept),1);
  assert.equal((await cleanup(a)).alreadyDeleted,true);
  report.checks.push('instant cleanup: clears the marked conversation (text, bodies), repeat no-op; a busy other conversation of the same account blocks neither mark nor cleanup and keeps its content');
 }
 // 4. content-erasure/instant "same conversation locked": a turn closing on it holds the session; bounded wait, then busy;
 //    and the deletion racing the real turn_open / turn_close in both orders without deadlock.
 {
  const a=await account();await turn(a);
  const o=await open(a);await begin(a,o.turnId);await record(a,o.turnId);
  const p=await peer();
  try{
   await p.query('begin');await close(a,o.turnId,undefined,p);
   assert.match(await refusal(mark(a)),/CONTENT_ERASURE_BUSY/);
   await p.query('rollback');
  }finally{await p.end();}
  assert.equal(await one('select content_deleted_at v from runtime_sessions where id=$1',[a.session]),null);
  assert.equal((await content(a.session)).visible,2,'nothing marked or hidden');
  // The real turn functions racing the mark (#1521 review): all take the account row, then the session, then the turn.
  const pidOf=async client=>one('select pg_backend_pid() v',[],client);
  // (a) Mark first: a turn_close and a turn_open of the same conversation wait for it, then close erased / are refused.
  {
   const d=await peer(),p1=await peer(),p2=await peer();
   try{
    await d.query('begin');assert.equal((await mark(a,a.session,d)).status,'deleted');
    const closing=close(a,o.turnId,undefined,p1).then(v=>({v}),e=>({e:e.message}));
    const opening=open(a,{client:p2}).then(v=>({v}),e=>({e:e.message}));
    await blocked(d,await pidOf(p1));await blocked(d,await pidOf(p2));
    await d.query('commit');
    assert.equal((await closing).v?.closeKind,'erased');
    assert.match((await opening).e??'',/TURN_SESSION_ERASED/);
   }finally{await d.end();await p1.end();await p2.end();}
   assert.deepEqual(await content(a.session),{visible:0,text:2,total:2},'the waiting close saved nothing');
  }
  // (b) Close first: the mark waits on the account row; once the close commits it deletes and hides what the close saved.
  // (c) Open first: the same, and the turn that opened then closes erased.
  for(const first of ['close','open']){
   const b=await account();await turn(b);
   const ob=first==='close'?await open(b):null;
   const p=await peer();
   try{
    await p.query('begin');
    const held=first==='close'?await close(b,ob.turnId,undefined,p):await open(b,{client:p});
    const marking=mark(b).then(v=>({v}),e=>({e:e.message}));
    await blocked(p,await pidOf(c));
    await p.query('commit');
    assert.equal((await marking).v?.status,'deleted',first);
    if(first==='open')assert.equal((await close(b,held.turnId)).closeKind,'erased');
   }finally{await p.end();}
   assert.equal((await content(b.session)).visible,0,first);
  }
  report.checks.push('instant same conversation locked: a closing turn holds the session; mark waits its bound, reports busy and marks nothing; with the real turn_open/turn_close in both orders no deadlock: mark first -> close erased and open refused; close or open first -> mark waits, then deletes and hides what was saved');
 }
 // 5. content-erasure/instant "same conversation generating" and turn-core 7: deleted while a turn runs.
 {
  const a=await account();await turn(a);
  const o=await open(a);await begin(a,o.turnId,1);await record(a,o.turnId,1);
  await mark(a);
  const r=await cleanup(a);assert.equal(r.status,'deleted');
  assert.equal(await raws(a.session),0,'the running turn\'s earlier body is removed too');
  assert.equal(await one('select erased_at v from runtime_sessions where id=$1',[a.session]),null,'shell kept while the turn is open');
  await begin(a,o.turnId,2);
  const late=await record(a,o.turnId,2);
  assert.equal(late.sessionTombstoned,true);
  assert.equal(await raws(a.session),0,'a receipt after the deletion stores no body');
  const closed=await close(a,o.turnId);
  assert.equal(closed.closeKind,'erased');
  assert.deepEqual(await content(a.session),{visible:0,text:0,total:2},'nothing saved from the running turn');
  // Billing follows the receipts (deletion-abort rule): two known calls, N = ceil(100 x 0.02 x 6) = 12.
  assert.deepEqual([closed.chargedCredits,closed.settlement],[12,'done']);
  // The session shell stayed un-erased while the turn was open (an erased row is immutable; the close releases it there);
  // the next cleanup pass erases it.
  assert.equal(await one('select active_turn_id v from runtime_sessions where id=$1',[a.session]),null);
  assert.notEqual((await cleanup(a)).status,undefined);
  assert.notEqual(await one('select erased_at v from runtime_sessions where id=$1',[a.session]),null);
  report.checks.push('instant generating: deleted mid-turn; session shell kept until the turn closes (then erased); earlier body cleared, later receipt keeps billing and stores no body, close is erased and saves nothing, charged by receipts');
 }
 // 6. A receipt holding its turn row: the cleanup reports busy (NOWAIT) and changes nothing; the sweep keeps it pending.
 {
  const a=await account();await turn(a);
  const o=await open(a);await begin(a,o.turnId);
  await mark(a);
  const p=await peer();
  try{
   await p.query('begin');await p.query('select 1 from turns where actor_id=$1 and id=$2 for update',[a.actor,o.turnId]);
   assert.match(await refusal(cleanup(a)),/CONTENT_ERASURE_BUSY/);
   assert.deepEqual(await content(a.session),{visible:0,text:2,total:2});assert.equal(await raws(a.session),1);
   const swept=await one('select content_erasure_sweep_sessions(200,null,null) v');
   assert.ok(swept.pending>=1,JSON.stringify(swept));
   await p.query('rollback');
  }finally{await p.end();}
  assert.equal((await cleanup(a)).status,'deleted');
  assert.deepEqual(await content(a.session),{visible:0,text:0,total:2});
  report.checks.push('cleanup vs a receipt holding the turn: busy, nothing changed, sweep pending; cleans once released');
 }
 // 7. Sweep (content-erasure/instant "sweep"): an erasing account's conversations are left to account erasure.
 {
  const a=await account();await turn(a);await mark(a);
  await c.query('insert into account_erasure_requests(profile_id,request_id) values($1,$2)',[a.actor,randomUUID()]);
  await one('select content_erasure_sweep_sessions(200,null,null) v');
  assert.equal((await content(a.session)).text,2,'left to account erasure');
  report.checks.push('sweep skips an erasing account (its content goes through account erasure)');
 }
 // 8. content-erasure/cases "account erasure can follow": scrub_turns and the erasure proof (account_erasure_body_remaining).
 {
  const a=await account();await turn(a);
  const second=await newSession(a);await turn(a,{session:second});
  const running=await open(a,{session:second});await begin(a,running.turnId);await record(a,running.turnId);
  const base=await one('select account_erasure_body_remaining($1) v',[a.actor]);
  // As account_erasure_confirm leaves it (an earlier transaction): the profile closed, the request recorded.
  await c.query("update profiles set status='deleted',is_deleted='true',deleted_at=now() where id=$1",[a.actor]);
  await c.query("insert into account_erasure_requests(profile_id,request_id,confirmed_at) values($1,$2,now()-interval '1 minute')",[a.actor,randomUUID()]);
  const before=await money(a);
  const s1=await one('select account_erasure_scrub_turns($1) v',[a.actor]);
  assert.deepEqual([s1.session_messages,s1.turn_call_raw,s1.turn_call_raw_skipped],[4,2,1],'the open turn keeps its body until it closes');
  assert.equal(Number(base)-Number(await one('select account_erasure_body_remaining($1) v',[a.actor])),4+2,'proof counted the text and bodies');
  assert.equal(Number(await one('select account_erasure_body_remaining($1) v',[a.actor]))>=1,true,'the open turn\'s body still counts as remaining');
  const r1=await one('select account_erasure_scrub_runtime($1) v',[a.actor]);
  assert.deepEqual([r1.runtime_sessions,r1.runtime_sessions_skipped],[1,1],'the session with an open turn is left for later');
  assert.equal((await close(a,running.turnId)).closeKind,'erased');
  const r2=await one('select account_erasure_scrub_runtime($1) v',[a.actor]);
  assert.deepEqual([r2.runtime_sessions,r2.runtime_sessions_skipped],[1,0],'erased once the turn closed');
  const s2=await one('select account_erasure_scrub_turns($1) v',[a.actor]);
  assert.deepEqual([s2.turn_call_raw,s2.turn_call_raw_skipped,s2.session_messages_skipped],[1,0,0]);
  assert.equal(await one('select count(*)::int v from turn_call_raw r join turn_calls c on c.turn_id=r.turn_id and c.seq=r.seq where c.actor_id=$1',[a.actor]),0);
  const after=await money(a);
  assert.deepEqual(after.calls,before.calls,'receipts keep their billing fields');
  report.checks.push('account erasure: scrub_runtime leaves a session with an open turn until it closes (the close still works), scrub_turns empties messages and closed-turn bodies, an open turn is counted remaining until it closes erased; body_remaining counts what is left; receipts keep billing');
 }
 // 9. Voice source revocation (Owner 10-23): replies written with a deleted version leave the history; others stay.
 {
  const a=await account(),version=randomUUID(),kept=randomUUID();
  for(const [id,n] of [[version,1],[kept,2]])
   await c.query(`insert into voice_profile_versions(id,actor_id,request_id,version,status,profile,confirmed_at)
    values($1,$2,$3,$4,'confirmed','{"tone":"x"}',now())`,[id,a.actor,randomUUID(),n]);
  await c.query('insert into voice_profiles(actor_id,confirmed_version_id,enabled) values($1,$2,true)',[a.actor,version]);
  const voiced=await turn(a,{pol:policy({voiceVersionId:version})});
  const plain=await turn(a);
  const other=await newSession(a);await turn(a,{session:other,pol:policy({voiceVersionId:kept})});
  const stranger=await account();
  const visible=async session=>(await c.query('select turn_id,visible from session_messages where session_id=$1 order by seq',[session])).rows;
  // Deny: another account naming this version deletes nothing and hides nothing.
  await c.query('begin');await c.query('set local role service_role');
  await c.query('select voice_profile_delete($1,$2)',[stranger.actor,version]);await c.query('commit');
  assert.ok((await visible(a.session)).every(r=>r.visible));
  await c.query('begin');await c.query('set local role service_role');
  await c.query('select voice_profile_delete($1,$2)',[a.actor,version]);await c.query('commit');
  assert.deepEqual((await visible(a.session)).map(r=>[Number(r.turn_id),r.visible]),[[voiced,false],[voiced,false],[plain,true],[plain,true]]);
  assert.ok((await visible(other)).every(r=>r.visible),'a reply written with another version stays');
  assert.deepEqual((await open(a)).history.map(h=>h.content),['PRIVATE_Q','PRIVATE_A'],'the next turn reads only the plain turn');
  report.checks.push('voice revocation: deleting a version hides the replies written with it (both messages), keeps plain replies and those of another version; the next turn reads only what is left');
 }
 // 10. Voice revocation racing a closing turn, both orders, and a receipt holding the turn row.
 {
  for(const closeFirst of [true,false]){
   const a=await account(),version=randomUUID();
   await c.query(`insert into voice_profile_versions(id,actor_id,request_id,version,status,profile,confirmed_at)
    values($1,$2,$3,1,'confirmed','{"tone":"x"}',now())`,[version,a.actor,randomUUID()]);
   await c.query('insert into voice_profiles(actor_id,confirmed_version_id,enabled) values($1,$2,true)',[a.actor,version]);
   const o=await open(a,{pol:policy({voiceVersionId:version})});await begin(a,o.turnId);await record(a,o.turnId);
   const p=await peer(),d=await peer();
   try{
    const pidP=await one('select pg_backend_pid() v',[],p),pidD=await one('select pg_backend_pid() v',[],d);
    await d.query('begin');await d.query('set local role service_role');
    if(closeFirst){
     await p.query('begin');const closing=await close(a,o.turnId,undefined,p);assert.equal(closing.closeKind,'completed');
     const deleting=d.query('select voice_profile_delete($1,$2)',[a.actor,version]);
     await blocked(p,pidD);await p.query('commit');await deleting;await d.query('commit');
    }else{
     await d.query('select voice_profile_delete($1,$2)',[a.actor,version]);
     const closing=close(a,o.turnId,undefined,p);
     await blocked(d,pidP);await d.query('commit');
     assert.equal((await closing).closeKind,'erased');
    }
   }finally{await p.end();await d.end();}
   assert.equal((await content(a.session)).visible,0,closeFirst?'committed messages hidden by the deletion':'nothing saved');
  }
  // A receipt holding the turn row (call writes lock only their turn): the deletion waits for it (no deadlock: the
  // receipt needs nothing the deletion holds), then deletes; the turn then closes erased.
  {
   const a=await account(),version=randomUUID();
   await c.query(`insert into voice_profile_versions(id,actor_id,request_id,version,status,profile,confirmed_at)
    values($1,$2,$3,1,'confirmed','{"tone":"x"}',now())`,[version,a.actor,randomUUID()]);
   await c.query('insert into voice_profiles(actor_id,confirmed_version_id,enabled) values($1,$2,true)',[a.actor,version]);
   const o=await open(a,{pol:policy({voiceVersionId:version})});await begin(a,o.turnId);
   const p=await peer(),d=await peer();
   try{
    await p.query('begin');await record(a,o.turnId,1,'RAW_PRIVATE_BODY',p);
    await d.query('begin');await d.query('set local role service_role');
    const deleting=d.query('select voice_profile_delete($1,$2)',[a.actor,version]);
    await blocked(p,await one('select pg_backend_pid() v',[],d));
    await p.query('commit');await deleting;await d.query('commit');
   }finally{await p.end();await d.end();}
   assert.equal(await one('select count(*)::int v from voice_profile_versions where id=$1',[version]),0);
   assert.equal((await close(a,o.turnId)).closeKind,'erased');
   assert.equal((await content(a.session)).total,0);
  }
  report.checks.push('voice revocation vs a closing turn (real functions): close first -> the deletion waits (account row) and hides its committed messages; deletion first -> the close waits, closes erased and saves nothing; a receipt holding its turn -> the deletion waits, then deletes, the turn closes erased');
 }
 // 11. content_erasure_turn_check (replaces content_erasure_runtime_check): allow and every deny.
 {
  const a=await account();const t=await turn(a);
  const check=(actor,turnId)=>c.query('select content_erasure_turn_check($1,$2)',[actor,turnId]);
  await check(a.actor,t);
  const stranger=await account();
  assert.match(await refusal(check(stranger.actor,t)),/CONTENT_NOT_FOUND/);
  assert.match(await refusal(check(a.actor,t+1000000)),/CONTENT_NOT_FOUND/);
  await mark(a);
  assert.match(await refusal(check(a.actor,t)),/CONTENT_ERASED/);
  const e=await account();const te=await turn(e);
  await c.query('insert into account_erasure_requests(profile_id,request_id) values($1,$2)',[e.actor,randomUUID()]);
  assert.match(await refusal(check(e.actor,te)),/CONTENT_ERASED/);
  for(const role of ['anon','authenticated','service_role'])
   assert.equal(await one("select has_function_privilege($1,'public.content_erasure_turn_check(uuid,bigint)','EXECUTE') v",[role]),false,role);
  report.checks.push('turn check: live turn allowed; other actor and unknown turn CONTENT_NOT_FOUND; deleted conversation and erasing account CONTENT_ERASED; not callable by any API role');
 }
 // 12. The new statements use their indexes (no sequential scan on the core-path tables).
 {
  await c.query('begin');await c.query('set local enable_seqscan=off');
  try{
   const plans=[];
   for(const sql of [
    "explain update session_messages set visible=false where session_id='00000000-0000-0000-0000-000000000001'::uuid and (visible or deleted_at is null)",
    "explain delete from turn_call_raw r using turns t where t.actor_id='00000000-0000-0000-0000-000000000001'::uuid and t.session_id=any(array['00000000-0000-0000-0000-000000000001'::uuid]) and r.turn_id=t.id",
    "explain select 1 from turns where actor_id='00000000-0000-0000-0000-000000000001'::uuid and policy->>'voiceVersionId'=any(array['x']) and policy ? 'voiceVersionId' and state<>'closed' for update",
    "explain select count(*) from turn_call_raw r join turn_calls c on c.turn_id=r.turn_id and c.seq=r.seq where c.actor_id='00000000-0000-0000-0000-000000000001'::uuid"])
    plans.push((await c.query(sql)).rows.map(r=>r['QUERY PLAN']).join('\n'));
   for(const plan of plans)assert.doesNotMatch(plan,/Seq Scan on (turns|turn_calls|turn_call_raw|session_messages)\b/,plan);
  }finally{await c.query('rollback');}
  report.checks.push('index use: message hide, body delete, voice lookup and the erasure proof count use indexes');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
