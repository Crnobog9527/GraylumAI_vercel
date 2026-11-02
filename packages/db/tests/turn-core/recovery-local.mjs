/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-8: turn_recovery_claim / turn_recover (the runtime-recovery job on turns) and turn_open(resume_of).
// Plan 6.1 row V2-8 acceptance: two instances never process the same turn, a repeated run changes nothing twice, a late
// receipt is settled once, a paused turn is refunded after 24 hours, a running one interrupted after 15 minutes; resume after
// a top-up charges the work done once; ordinary chat cannot be stopped (the old stop-round scenario as a refusal).
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {localDb,read,root} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
// V2-7a: a report opens only for a Gold account's confirmed round of its own conversation (turn_report_admit).
db.sql(read('packages/db/tests/content-erasure/fixture.sql'));db.sql(read('packages/db/tests/turn-core/report-fixture.sql'));
const one=async(sql,args=[],client=c)=>(await client.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const {Client}=createRequire(resolve(root,'package.json'))('pg');
const peer=async()=>{const p=new Client({host:c.host,port:c.port,user:'postgres',database:c.database});await p.connect();return p;};
const refusal=async(promise)=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const policy=(over={})=>({q:100,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:100,inputBytes:1000,
 limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5},...over});
async function account(credits=1000){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,$2)',[actor,credits]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session,credits};
}
const open=(a,{kind='chat',request=randomUUID(),pol=policy(),resumeOf=null,client=c}={})=>
 one('select turn_open($1,$2,$3,$4,$5,$6) v',[a.actor,a.session,request,kind,JSON.stringify(pol),resumeOf],client);
const begin=(a,turn,seq,{kind='model',paid=null,upper=0.02,tool=null}={})=>
 one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
  [a.actor,turn,seq,kind,kind==='tool'?null:randomUUID(),kind==='tool'?(tool??'research_search'):null,paid,hash('r'+turn+seq),upper,6]);
const identity=(a,turn,seq,id='gen-'+seq)=>one('select turn_call_identity($1,$2,$3,$4) v',[a.actor,turn,seq,id]);
const record=(a,turn,seq,{n=0.01,raw='[{"choices":[]}]'}={})=>
 one("select turn_call_record($1,$2,$3,'ok',$4,$4,'{}',null,$5,$6) v",[a.actor,turn,seq,n,hash('p'+turn+seq),raw]);
const close=(a,turn,kind='completed')=>one("select turn_close($1,$2,$3,'[]',false,false,null) v",[a.actor,turn,kind]);
const claim=(limit=50,client=c)=>one('select turn_recovery_claim($1) v',[limit],client);
const recover=(a,turn,action,client=c)=>one('select turn_recover($1,$2,$3) v',[a.actor,turn,action],client);
const turn=(a,id)=>c.query('select state,close_kind,failure_code,charged_credits,settlement,resume_of::int resume_of,recovery_lease_until from turns where actor_id=$1 and id=$2',
 [a.actor,id]).then(r=>r.rows[0]);
const age=(a,id,interval)=>c.query(`update turns set updated_at=now()-interval '${interval}' where actor_id=$1 and id=$2`,[a.actor,id]);
const balance=a=>one('select credits v from profiles where id=$1',[a.actor]);
const spends=a=>one("select coalesce(sum(-amount),0)::int v from credit_transactions where user_id=$1 and reason_code='turn_spend'",[a.actor]);
const ids=items=>items.map(i=>i.turnId);
// A running chat turn with one known receipt (N = ceil(100 x 0.01 x 6) = 6), left by a dead instance.
async function stale(interval='16 minutes'){
 const a=await account(),o=await open(a);
 await begin(a,o.turnId,1);await record(a,o.turnId,1);
 await age(a,o.turnId,interval);
 return {a,id:o.turnId};
}
// A turn paused for credits, its freeze capped by the balance (0422 start threshold): L = 30 = the balance, G = 60, H = min(G, 30) = 30; one call
// used 12, the next needs G_i = 24 and 18 < min(24, L) pauses it.
async function paused(){
 const a=await account(30),o=await open(a,{pol:policy({gCredits:60,minCredits:30,uModelCredits:20})});
 await begin(a,o.turnId,1,{upper:0.02});await record(a,o.turnId,1,{n:0.02});
 assert.equal((await begin(a,o.turnId,2,{upper:0.04})).paused,true);
 return {a,id:o.turnId};
}
try{
 // 1. Two instances at once: disjoint claims (SKIP LOCKED + lease); both then try every turn; each turn closes and settles once.
 {
  const turns=[];for(let i=0;i<60;i++)turns.push(await stale());
  const [p1,p2]=[await peer(),await peer()];
  try{
   const [x,y]=await Promise.all([claim(50,p1),claim(50,p2)]);
   const mine=new Set(turns.map(t=>t.id)),got=[...ids(x),...ids(y)].filter(id=>mine.has(id));
   assert.equal(new Set(got).size,got.length,'no turn claimed by both instances');
   assert.ok(x.length<=50&&y.length<=50);
   const rest=await claim(50);
   assert.equal(new Set([...got,...ids(rest)].filter(id=>mine.has(id))).size,60,'every due turn claimed once across runs');
   assert.equal((await claim(50)).filter(i=>mine.has(i.turnId)).length,0,'leased turns are not claimed again');
   // Worst case: both instances recover every turn concurrently.
   const results=await Promise.all(turns.flatMap(t=>[recover(t.a,t.id,'interrupt',p1),recover(t.a,t.id,'interrupt',p2)]));
   assert.equal(results.filter(r=>!r.skipped).length,60,'exactly one close per turn');
  }finally{await p1.end();await p2.end();}
  for(const t of turns){
   assert.deepEqual(await turn(t.a,t.id).then(r=>[r.state,r.close_kind,r.charged_credits,r.settlement,r.recovery_lease_until]),
    ['closed','interrupted',6,'done',null]);
   assert.equal(await balance(t.a),994);assert.equal(await spends(t.a),6);
  }
  report.checks.push('two concurrent instances: claims disjoint (SKIP LOCKED, lease), both recovering every turn closes each once (D=6, one spend row)');
 }
 // 2. Due rules and repeated runs: 15 minutes running, 24 hours paused; a repeated recover and a repeated claim do nothing.
 {
  const young=await stale('5 minutes'),old=await stale();
  const p=await paused(),q=await paused();
  await age(p.a,p.id,'25 hours');await age(q.a,q.id,'23 hours');
  const got=await claim();
  const action=new Map(got.map(i=>[i.turnId,i.action]));
  assert.equal(action.get(old.id),'interrupt');assert.equal(action.get(p.id),'expire');
  assert.ok(!action.has(young.id)&&!action.has(q.id),'not due yet');
  await recover(old.a,old.id,'interrupt');
  assert.equal((await recover(old.a,old.id,'interrupt')).skipped,true,'a repeated run is skipped');
  // Expire: the paused turn delivered nothing for 24 hours: D = 0, the whole freeze back (Owner 10-25).
  const expired=await recover(p.a,p.id,'expire');
  assert.deepEqual([expired.closeKind,expired.chargedCredits,expired.settlement],['expired',0,'done']);
  assert.equal(await balance(p.a),30);assert.equal(await spends(p.a),0);
  assert.equal(await one('select active_turn_id v from runtime_sessions where id=$1',[p.a.session]),null);
  assert.equal((await recover(p.a,p.id,'expire')).skipped,true);
  // The wrong action for the state, or not yet due under the lock, is skipped and changes nothing.
  assert.equal((await recover(young.a,young.id,'interrupt')).skipped,true);
  assert.equal((await recover(q.a,q.id,'expire')).skipped,true);
  assert.equal((await recover(q.a,q.id,'interrupt')).skipped,true);
  assert.equal((await turn(q.a,q.id)).state,'paused');
  assert.match(await refusal(recover(q.a,q.id,'other')),/TURN_RECOVERY_INVALID/);
  assert.match(await refusal(claim(51)),/TURN_RECOVERY_INVALID/);
  // A lease that ran out (an instance died) is claimed again.
  const lost=await stale();
  assert.ok(ids(await claim()).includes(lost.id));
  assert.ok(!ids(await claim()).includes(lost.id));
  await c.query("update turns set recovery_lease_until=now()-interval '1 second' where id=$1",[lost.id]);
  assert.ok(ids(await claim()).includes(lost.id),'claimed again after the lease');
  await recover(lost.a,lost.id,'interrupt');
  report.checks.push('running 15 min -> interrupted, paused 24 h -> expired with a full refund; younger turns untouched; repeated runs and wrong actions skipped; a dead lease is reclaimed');
 }
 // 3. Late receipt: an interrupted turn with an unknown model cost is claimed for settlement with its provider id; the receipt
 // found by lookup settles it once. A receipt the API itself wrote late is settled too. No provider id: left for review.
 {
  const pricing={version:'nominal-v1',pricingHash:'a'.repeat(64),endpointTag:'synthetic/exact',
   tiers:[{minPromptTokens:0,prompt:'2',completion:'10',request:'0'}],timeOfDay:[]};
  const a=await account(),o=await open(a,{pol:policy({model:'test/model',pricing})});
  // The catalog may change after the call: the claim still names what the turn froze.
  await begin(a,o.turnId,1);await identity(a,o.turnId,1,'gen-late');
  await age(a,o.turnId,'16 minutes');
  assert.ok(ids(await claim()).includes(o.turnId));
  const interrupted=await recover(a,o.turnId,'interrupt');
  assert.deepEqual([interrupted.chargedCredits,interrupted.settlement],[null,'pending']);
  assert.equal(await balance(a),940,'the freeze stays while the model cost is unknown');
  const item=(await claim()).find(i=>i.turnId===o.turnId);
  assert.equal(item?.action,'settle');
  assert.deepEqual(item.calls,[{seq:1,providerId:'gen-late',model:'test/model',pricing,upperUsd:'0.020000000000'}]);
  assert.equal((await claim()).find(i=>i.turnId===o.turnId),undefined,'not looked up again within the lease');
  await record(a,o.turnId,1);
  const settled=await recover(a,o.turnId,'settle');
  assert.deepEqual([settled.closeKind,settled.chargedCredits,settled.settlement],['interrupted',6,'done']);
  assert.equal(await balance(a),994);
  assert.equal((await recover(a,o.turnId,'settle')).skipped,true);
  assert.equal(await spends(a),6);
  await c.query("update turns set recovery_lease_until=null where id=$1",[o.turnId]);
  assert.equal((await claim()).find(i=>i.turnId===o.turnId),undefined,'settled turns are never claimed');
  // A late receipt written by the API before any lookup: claimed with nothing to look up, settled.
  const b=await account(),ob=await open(b);
  await begin(b,ob.turnId,1);await identity(b,ob.turnId,1,'gen-api');
  await close(b,ob.turnId,'interrupted');
  await c.query("update turns set recovery_lease_until=now()+interval '1 hour' where id=$1",[ob.turnId]);
  await record(b,ob.turnId,1);
  await c.query("update turns set recovery_lease_until=null where id=$1",[ob.turnId]);
  const late=(await claim()).find(i=>i.turnId===ob.turnId);
  assert.equal(late?.action,'settle');assert.deepEqual(late.calls,[]);
  assert.equal((await recover(b,ob.turnId,'settle')).chargedCredits,6);
  // No provider id, or an unknown third-party tool: nothing to look up, never claimed, never presumed free.
  const d=await account(),od=await open(d);
  await begin(d,od.turnId,1);await close(d,od.turnId,'interrupted');
  const e=await account(),oe=await open(e);
  await begin(e,oe.turnId,1);await record(e,oe.turnId,1);await begin(e,oe.turnId,2,{kind:'tool',paid:true,upper:0.02});
  assert.equal((await close(e,oe.turnId)).settlement,'pending');
  const left=ids(await claim());
  assert.ok(!left.includes(od.turnId)&&!left.includes(oe.turnId));
  assert.equal(await balance(d),940);assert.equal(await balance(e),994);
  report.checks.push('late receipt: interrupted with unknown model cost -> claimed for settlement with its provider id -> receipt -> settled once (D=6); an API-written late receipt settles; no provider id / unknown tool stays pending, never presumed free');
 }
 // 4. Every kind is recovered (aligned with V2-7b): a jury left running or paused between groups closes here; a report its
 // user was stopping closes as stopped.
 {
  const a=await account(),j=await open(a,{kind:'jury',pol:policy({gCredits:60})});
  await age(a,j.turnId,'16 minutes');
  const b=await account(),k=await open(b,{kind:'jury',pol:policy({gCredits:60})});
  await c.query("update turns set state='paused',pause_reason='awaiting_user',updated_at=now()-interval '25 hours' where id=$1",[k.turnId]);
  const got=new Map((await claim()).map(i=>[i.turnId,i.action]));
  assert.equal(got.get(j.turnId),'interrupt');assert.equal(got.get(k.turnId),'expire');
  assert.equal((await recover(a,j.turnId,'interrupt')).closeKind,'interrupted');
  assert.equal((await recover(b,k.turnId,'expire')).closeKind,'expired');
  assert.equal(await one('select failure_code v from turns where id=$1',[k.turnId]),'recovery_expired');
  const r=await account(),src=await one('select turn_test.report_source($1) v',[r.actor]);
  const rep=await open({...r,session:src.session},{kind:'report',pol:policy({gCredits:530,minCredits:530,fixedCredits:500,historyItems:0,
   limits:{model:1,paidTools:0,freeTools:0},report:{projectId:src.project,roundId:src.round,moduleId:src.module}})});
  await begin(r,rep.turnId,1,{upper:0.5});await record(r,rep.turnId,1,{n:0.2});
  await c.query("update turns set state='stopping',updated_at=now()-interval '16 minutes' where id=$1",[rep.turnId]);
  assert.equal((await claim()).find(i=>i.turnId===rep.turnId)?.action,'interrupt');
  const stopped=await recover(r,rep.turnId,'interrupt');
  assert.deepEqual([stopped.closeKind,stopped.chargedCredits],['stopped',0],'the first stop in 24 hours is free');
  report.checks.push('jury turns are recovered too (interrupt; expire after 24 h paused awaiting_user with refund_all false); a stuck stopping report closes as stopped under the 24-hour stop rule');
 }
 // 4b. What a resume replays (V2-10): the paused turn's receipts through the turns it continued, what its limits leave, and the same
 // refusals as the resume itself. Reading writes nothing.
 {
  const a=await account(30),o=await open(a,{pol:policy({gCredits:60,minCredits:30,uModelCredits:20})});
  await begin(a,o.turnId,1,{upper:0.02});
  await record(a,o.turnId,1,{n:0.02,raw:JSON.stringify({choices:[{message:{tool_calls:[{function:{arguments:'{"q":"early"}'}}]}}]})});
  await begin(a,o.turnId,2,{kind:'tool',paid:true,upper:0.01});await record(a,o.turnId,2,{n:0.01,raw:'[{"vendor":"v"}]'});
  assert.equal((await begin(a,o.turnId,3,{upper:0.04})).paused,true);
  const before=await turn(a,o.turnId);
  const read=await one('select turn_resume_read($1,$2,$3) v',[a.actor,a.session,o.turnId]);
  assert.deepEqual(read.limits,{model:2,paidTools:0,freeTools:1,decisions:0});
  assert.deepEqual(read.calls.map(x=>[x.seq,x.callKind,x.body]),[[1,'model',read.calls[0].body],[2,'tool','[{"vendor":"v"}]']]);
  assert.deepEqual(await turn(a,o.turnId),before,'reading changes nothing');
  const other=await account();
  assert.match(await refusal(one('select turn_resume_read($1,$2,$3) v',[other.actor,other.session,o.turnId])),/TURN_RESUME_DENIED/);
  assert.match(await refusal(one('select turn_resume_read($1,$2,$3) v',[other.actor,a.session,o.turnId])),/TURN_SESSION_DENIED/);
  const running=await account(),r=await open(running);
  assert.match(await refusal(one('select turn_resume_read($1,$2,$3) v',[running.actor,running.session,r.turnId])),/TURN_RESUME_DENIED/);
  // A deleted conversation has no breakpoint: its receipts' bodies are gone with it, and the read is refused.
  const marked=async at=>{await c.query("set session_replication_role=replica");
   await c.query('update runtime_sessions set content_deleted_at=$2 where id=$1',[a.session,at]);await c.query("set session_replication_role=origin");};
  await marked(new Date());
  assert.match(await refusal(one('select turn_resume_read($1,$2,$3) v',[a.actor,a.session,o.turnId])),/TURN_SESSION_ERASED/);
  await marked(null);
  // What the user asked is saved once at the pause, hidden from every reader, and given back to the resume.
  assert.equal(await one('select turn_pause_save($1,$2,$3) v',[a.actor,o.turnId,JSON.stringify({kind:'chat',text:'早起'})]),true);
  assert.equal(await one('select turn_pause_save($1,$2,$3) v',[a.actor,o.turnId,JSON.stringify({kind:'chat',text:'again'})]),true);
  assert.deepEqual((await one('select turn_resume_read($1,$2,$3) v',[a.actor,a.session,o.turnId])).input,{kind:'chat',text:'早起'});
  assert.equal(await one('select count(*)::int v from session_messages where session_id=$1',[a.session]),1,'saved once');
  assert.equal(await one('select turn_pause_save($1,$2,$3) v',[running.actor,r.turnId,'{}']),false,'only at a pause');
  // The view shows the paid call behind a reply, under the turn that saved it, with what was asked.
  await c.query("insert into session_messages(session_id,seq,role,turn_id,content,content_hash) values($1,2,'assistant',$2,'好',repeat('a',64))",[a.session,o.turnId]);
  await c.query("set session_replication_role=replica");
  await c.query(`update runtime_sessions set scope=jsonb_build_object('kind','work_item','workItemId',gen_random_uuid()) where id=$1`,[a.session]);
  await c.query("set session_replication_role=origin");
  // A benchmark lookup settles in several rows: a later row names the same question.
  await c.query("set session_replication_role=replica");
  await c.query(`insert into turn_calls select (x.r).* from (select jsonb_populate_record(c,'{"seq":5}') r from turn_calls c where turn_id=$1 and seq=2) x`,[o.turnId]);
  await c.query("set session_replication_role=origin");
  const view=await one('select turn_session_view($1,$2,0) v',[a.actor,a.session]);
  assert.deepEqual(view.calls.map(x=>[x.turnId,x.seq,x.status,x.arguments]),[[o.turnId,2,'ok','{"q":"early"}'],[o.turnId,5,'ok','{"q":"early"}']]);
  assert.deepEqual(view.messages.map(m=>m.content),['好'],'the saved input is no message');
  // A 24-hour expiry ends the paused turn, and what it kept goes with it.
  await age(a,o.turnId,'25 hours');
  await one("select turn_close($1,$2,'expired','[]',false,true,'expired') v",[a.actor,o.turnId]);
  assert.equal(await one("select count(*)::int v from session_messages where session_id=$1 and not visible",[a.session]),0);
  report.checks.push('turn_resume_read gives limits and receipts, writes nothing, refuses as a resume; the view lists paid calls');
 }
 // 4c. A receipt with no completion (finished by the recovery lookup) cannot be replayed: that call runs again and the user pays for
 // it once. The first attempt carries nothing; it stays the platform's, recorded as absorbed. The saved input goes with the resume.
 {
  const a=await account(30),o=await open(a,{pol:policy({gCredits:60,minCredits:30,uModelCredits:20})});
  await begin(a,o.turnId,1,{upper:0.02});await record(a,o.turnId,1,{n:0.02,raw:'{"choices":[{"message":{"content":"x"}}]}'});
  await begin(a,o.turnId,2,{upper:0.02});await record(a,o.turnId,2,{n:0.02,raw:'{"data":{"model":"m"}}'});
  assert.equal((await begin(a,o.turnId,3,{upper:0.04})).paused,true);
  await one('select turn_pause_save($1,$2,$3) v',[a.actor,o.turnId,'{"kind":"chat","text":"hi"}']);
  await c.query('update profiles set credits=credits+100 where id=$1',[a.actor]);
  const read=await one('select turn_resume_read($1,$2,$3) v',[a.actor,a.session,o.turnId]);
  assert.deepEqual([read.calls.map(x=>x.seq),read.limits.model],[[1],2],'the unreplayable call is not replayed and uses no limit');
  const r=await open(a,{resumeOf:o.turnId,pol:policy({gCredits:40,minCredits:10,uModelCredits:20,limits:{model:2,paidTools:0,freeTools:1}})});
  assert.equal(await one("select (policy->>'carriedCredits')::int v from turns where id=$1",[r.turnId]),12,'only the replayed call is carried');
  assert.equal((await c.query("select absorbed_credits a from turns where id=$1",[o.turnId])).rows[0].a,12,'the first attempt is absorbed');
  assert.equal(await one("select count(*)::int v from session_messages where session_id=$1",[a.session]),0,'the saved input ended with the paused turn');
  // The continuation made that call again and pauses in turn: its own receipts follow the first turn's good ones, nothing is lost.
  await begin(a,r.turnId,1,{upper:0.02});await record(a,r.turnId,1,{n:0.02,raw:'{"choices":[{"message":{"content":"y"}}]}'});
  await c.query("update turns set state='paused',pause_reason='waiting_credits' where id=$1",[r.turnId]);
  assert.deepEqual((await one('select turn_resume_read($1,$2,$3) v',[a.actor,a.session,r.turnId])).calls.map(x=>x.body),
   ['{"choices":[{"message":{"content":"x"}}]}','{"choices":[{"message":{"content":"y"}}]}']);
  report.checks.push('a receipt that cannot be replayed carries no charge and is absorbed; the saved input ends with the turn');
 }
 // 4d. A continuation's first real tool call follows the model receipt of the turn it continued: what was asked is found along the chain.
 {
  const a=await account(30),o=await open(a,{pol:policy({gCredits:60,minCredits:30,uModelCredits:20})});
  await begin(a,o.turnId,1,{upper:0.02});
  await record(a,o.turnId,1,{n:0.02,raw:JSON.stringify({choices:[{message:{tool_calls:[{function:{arguments:'{"q":"chain"}'}}]}}]})});
  assert.equal((await begin(a,o.turnId,2,{kind:'tool',paid:true,upper:0.04})).paused,true);
  await c.query('update profiles set credits=credits+100 where id=$1',[a.actor]);
  const k=await open(a,{resumeOf:o.turnId,pol:policy({gCredits:60,minCredits:10,uModelCredits:20,limits:{model:2,paidTools:1,freeTools:0}})});
  await begin(a,k.turnId,1,{kind:'tool',paid:true,upper:0.01});await record(a,k.turnId,1,{n:0.01,raw:'[{"vendor":"v"}]'});
  await c.query("insert into session_messages(session_id,seq,role,turn_id,content,content_hash) values($1,1,'assistant',$2,'后',repeat('b',64))",[a.session,k.turnId]);
  await c.query("set session_replication_role=replica");
  await c.query(`update runtime_sessions set scope=jsonb_build_object('kind','work_item','workItemId',gen_random_uuid()) where id=$1`,[a.session]);
  await c.query("set session_replication_role=origin");
  const chained=await one('select turn_session_view($1,$2,0) v',[a.actor,a.session]);
  assert.deepEqual(chained.calls.map(x=>[x.turnId,x.seq,x.arguments]),[[k.turnId,1,'{"q":"chain"}']]);
  report.checks.push('a continuation\'s tool call finds its question in the continued turn\'s model receipt');
 }
 // 5. Resume after a top-up (2.2): the paused turn closes and charges its known receipt once, the new turn freezes for what is
 // left of the limits; refusals roll back and keep the turn paused.
 {
  const p=await paused();
  const resumed=(over={},request=randomUUID())=>open(p.a,{request,resumeOf:p.id,
   pol:policy({gCredits:60,minCredits:20,uModelCredits:20,limits:{model:2,paidTools:1,freeTools:1},...over})});
  // Still short: the paused turn's 30 back minus the 12 it carries leaves 18, below the start threshold of 20. Nothing changes.
  assert.match(await refusal(resumed()),/TURN_INSUFFICIENT_CREDITS/);
  assert.deepEqual(await turn(p.a,p.id).then(r=>[r.state,r.charged_credits]),['paused',null]);
  assert.equal(await balance(p.a),0);
  // More calls than the paused turn has left.
  await c.query('update profiles set credits=credits+100 where id=$1',[p.a.actor]);
  assert.match(await refusal(resumed({limits:{model:3,paidTools:1,freeTools:1}})),/TURN_POLICY_INVALID/);
  assert.match(await refusal(resumed({},randomUUID()).then(()=>open(p.a))),/TURN_SESSION_BUSY/,'a plain open while resuming is busy');
  const r=(await c.query("select id::int id from turns where actor_id=$1 and resume_of=$2",[p.a.actor,p.id])).rows[0].id;
  // The paused segment is refunded in full (30 back) and its N = ceil(100 x 0.02 x 6) = 12 is carried: the new turn holds
  // min(60 + 12, 100 + 30) = 72, of which 60 for its own calls.
  assert.deepEqual(await turn(p.a,p.id).then(t=>[t.state,t.close_kind,t.failure_code,t.charged_credits]),['closed','failed','resumed',0]);
  assert.deepEqual(await turn(p.a,r).then(t=>[t.state,t.resume_of]),['running',p.id]);
  assert.deepEqual(await c.query("select reserved_credits r,(policy->>'carriedCredits')::int k,(policy->>'heldCredits')::int h from turns where id=$1",[r]).then(x=>x.rows[0]),{r:60,k:12,h:72});
  assert.equal(await balance(p.a),58);assert.equal(await spends(p.a),0,'nothing charged until the chain settles');
  assert.equal(await one('select active_turn_id::int v from runtime_sessions where id=$1',[p.a.session]),r);
  assert.match(await refusal(resumed()),/TURN_RESUME_DENIED/,'a closed turn cannot be resumed again');
  // The resumed turn continues and closes normally: the work is charged once across both turns (6 + carried 12).
  await begin(p.a,r,1);await record(p.a,r,1);
  assert.equal((await one("select turn_close($1,$2,'completed','[]',true,false,null) v",[p.a.actor,r])).chargedCredits,18);
  assert.equal(await balance(p.a),112);assert.equal(await spends(p.a),18);
  assert.deepEqual(await c.query('select absorbed_credits a from turns where id=any($1) order by id',[[p.id,r]]).then(x=>x.rows.map(y=>y.a)),[0,0],
   'the carried 12 is charged by the continuation, not absorbed by the paused turn');
  // Replay of the resume request: the same turn; with another resume_of: a conflict.
  const q=await paused(),request=randomUUID();
  await c.query('update profiles set credits=credits+100 where id=$1',[q.a.actor]);
  const pol=policy({gCredits:60,minCredits:10,uModelCredits:20,limits:{model:2,paidTools:1,freeTools:1}});
  const first=await open(q.a,{request,resumeOf:q.id,pol});
  assert.deepEqual(await open(q.a,{request,resumeOf:q.id,pol}),{...first,replay:true});
  assert.match(await refusal(open(q.a,{request,pol})),/TURN_REQUEST_CONFLICT/);
  // Only this session's turn paused for credits: not a running one, not another session's.
  const s=await account(),running=await open(s);
  assert.match(await refusal(open(s,{resumeOf:running.turnId})),/TURN_RESUME_DENIED/);
  const w=await paused();
  await c.query("update turns set pause_reason='awaiting_user' where id=$1",[w.id]);
  await c.query('update profiles set credits=credits+100 where id=$1',[w.a.actor]);
  assert.match(await refusal(open(w.a,{resumeOf:w.id,pol})),/TURN_RESUME_DENIED/);
  assert.match(await refusal(open(w.a,{resumeOf:w.id,kind:'mentor',pol})),/TURN_RESUME_DENIED/);
  // Resume racing the 24-hour expiry: exactly one wins, and the money matches the winner.
  const x=await paused();
  await c.query('update profiles set credits=credits+100 where id=$1',[x.a.actor]);
  await age(x.a,x.id,'25 hours');
  const [p1,p2]=[await peer(),await peer()];
  try{
   const [exp,res]=await Promise.all([recover(x.a,x.id,'expire',p1).then(v=>v,e=>({error:e.message})),
    open(x.a,{resumeOf:x.id,pol,client:p2}).then(v=>v,e=>({error:e.message}))]);
   const won=exp.closeKind==='expired'?'expire':'resume';
   if(won==='expire'){assert.match(res.error??'',/TURN_RESUME_DENIED/);assert.equal(await balance(x.a),130);}
   else{assert.equal(exp.skipped,true);assert.equal(res.state,'running');assert.equal(await balance(x.a),58);}
   report.resumeExpiryRace=won;
  }finally{await p1.end();await p2.end();}
  // A fixed price stays the fixed price across a resume (#1519 review): 500, not 500 + what the paused segment used. A fixed-price
  // turn that pauses is a jury's (a report freezes its whole price at open and never pauses, V2-7a).
  {
   // The balance covers the price (a jury never opens below it, V2-7b), not the second call's temporary bound.
   const f=await account(520);
   const fp=(o={})=>policy({gCredits:600,fixedCredits:500,minCredits:30,uModelCredits:20,...o});
   const o=await open(f,{kind:'jury',pol:fp()});
   await begin(f,o.turnId,1,{upper:0.02});await record(f,o.turnId,1,{n:0.02});
   assert.equal((await begin(f,o.turnId,2,{upper:0.04})).paused,true);
   await c.query('update profiles set credits=credits+1000 where id=$1',[f.actor]);
   // A jury leaves its conversation free (V2-7b) and waits between groups, so nothing resumes one today; the turn is set as the
   // active one here to keep the core's rule under test.
   await c.query('update runtime_sessions set active_turn_id=$1 where id=$2',[o.turnId,f.session]);
   const n=await open(f,{kind:'jury',resumeOf:o.turnId,pol:fp({limits:{model:2,paidTools:1,freeTools:1}})});
   await begin(f,n.turnId,1);await record(f,n.turnId,1);
   await c.query(`update turn_calls set usage=coalesce(usage,'{}')||'{"deliverable":true}' where turn_id=$1`,[n.turnId]); // a deliverable revision
   assert.equal((await one("select turn_close($1,$2,'completed','[]',true,false,null) v",[f.actor,n.turnId])).chargedCredits,500);
   assert.equal(await spends(f),500);assert.equal(await balance(f),1020);
  }
  // Two resumes in a row (#1519 review): the second carries everything carried before, nothing is lost to a cap.
  {
   const g=await paused();                                         // segment 1: N = 12, carried
   await c.query('update profiles set credits=credits+100 where id=$1',[g.a.actor]);
   const t2=await open(g.a,{resumeOf:g.id,pol:policy({gCredits:10,minCredits:10,uModelCredits:20,limits:{model:2,paidTools:1,freeTools:1}})});
   assert.deepEqual(await c.query("select reserved_credits r,(policy->>'carriedCredits')::int k from turns where id=$1",[t2.turnId]).then(x=>x.rows[0]),{r:10,k:12});
   await begin(g.a,t2.turnId,1,{upper:0.01});await record(g.a,t2.turnId,1,{n:0.01});  // segment 2: N = 6
   assert.equal((await begin(g.a,t2.turnId,2,{upper:0.02})).paused,true,'4 left < 12: paused again');
   const t3=await open(g.a,{resumeOf:t2.turnId,pol:policy({gCredits:60,minCredits:10,uModelCredits:20,limits:{model:1,paidTools:1,freeTools:1}})});
   assert.equal(await one("select (policy->>'carriedCredits')::int v from turns where id=$1",[t3.turnId]),18,'6 + 12, not capped at 10');
   await begin(g.a,t3.turnId,1,{upper:0.01});await record(g.a,t3.turnId,1,{n:0.01});  // segment 3: N = 6
   assert.equal((await one("select turn_close($1,$2,'completed','[]',true,false,null) v",[g.a.actor,t3.turnId])).chargedCredits,24);
   assert.equal(await spends(g.a),24);assert.equal(await balance(g.a),106);
   // Carried credits are not borne by the platform: nothing absorbed anywhere in the chain (#1519 review).
   assert.equal(await one('select sum(absorbed_credits)::int v from turns where actor_id=$1',[g.a.actor]),0);
  }
  // A model call whose cost is not final yet: the resume waits for its receipt, then carries it (#1519 review).
  {
   const g=await account(30),o=await open(g,{pol:policy({gCredits:60,minCredits:30,uModelCredits:20})});
   await begin(g,o.turnId,1,{upper:0.02});await identity(g,o.turnId,1,'gen-open');            // usable answer, cost not final
   assert.equal((await begin(g,o.turnId,2,{upper:0.04})).paused,true,'30 - 12 held for the open call < 24');
   await c.query('update profiles set credits=credits+100 where id=$1',[g.actor]);
   const pol2=policy({gCredits:60,minCredits:10,uModelCredits:20,limits:{model:2,paidTools:1,freeTools:1}});
   assert.match(await refusal(open(g,{resumeOf:o.turnId,pol:pol2})),/TURN_RESUME_COST_PENDING/);
   assert.equal((await turn(g,o.turnId)).state,'paused');
   // The job claims the paused turn for a lookup of that cost (not for an expiry), once per lease, and records what it finds.
   const item=(await claim()).find(i=>i.turnId===o.turnId);
   assert.deepEqual([item?.action,item?.calls.map(k=>[k.seq,k.providerId])],['lookup',[[1,'gen-open']]]);
   assert.equal((await claim()).find(i=>i.turnId===o.turnId),undefined,'not again within the lease');
   await record(g,o.turnId,1,{n:0.02});                                                        // the receipt found: N = 12
   assert.equal((await turn(g,o.turnId)).state,'paused','a lookup only records; the turn stays paused');
   await c.query("update turns set recovery_lease_until=null where id=$1",[o.turnId]);
   assert.equal((await claim()).find(i=>i.turnId===o.turnId),undefined,'nothing left to look up');
   const n=await open(g,{resumeOf:o.turnId,pol:pol2});
   assert.equal(await one("select (policy->>'carriedCredits')::int v from turns where id=$1",[n.turnId]),12);
  }
  // The continuation paused again and expired: the whole chain is refunded (Owner 10-25), the carried part included.
  {
   const g=await paused();
   await c.query('update profiles set credits=credits+100 where id=$1',[g.a.actor]);
   const n=await open(g.a,{resumeOf:g.id,pol});
   await c.query("update turns set state='paused',pause_reason='waiting_credits',updated_at=now()-interval '25 hours' where id=$1",[n.turnId]);
   assert.equal((await recover(g.a,n.turnId,'expire')).chargedCredits,0);
   assert.equal(await spends(g.a),0);assert.equal(await balance(g.a),130);
  }
  // turn_resume_close is turn_close's refund-all close without the kind hooks (0438): the same paused turn, with a tool whose cost
  // is unknown, closed both ways ends the same, and the same late tool receipt settles the same.
  {
   const pausedWithTool=async()=>{
    const a=await account(30),o=await open(a,{pol:policy({gCredits:60,minCredits:30,uModelCredits:20})});
    await begin(a,o.turnId,1,{upper:0.02});await record(a,o.turnId,1,{n:0.02});
    await begin(a,o.turnId,2,{kind:'tool',paid:true,upper:0.01});await identity(a,o.turnId,2);
    assert.equal((await begin(a,o.turnId,3,{upper:0.04})).paused,true);
    await c.query('update profiles set credits=credits+100 where id=$1',[a.actor]);
    return {a,id:o.turnId};
   };
   const closed=async(p)=>({
    turn:(await c.query(`select state,pause_reason,close_kind,failure_code,charged_credits,settlement,stopped_by_user,delivered,
      policy ? 'closeRefundAll' refund_flag,closed_at=updated_at same_mark from turns where actor_id=$1 and id=$2`,[p.a.actor,p.id])).rows[0],
    calls:(await c.query('select seq,status,cost_pending from turn_calls where turn_id=$1 order by seq',[p.id])).rows,
    active:await one('select active_turn_id::int v from runtime_sessions where id=$1',[p.a.session])});
   const absorbed=p=>one('select absorbed_credits v from turns where actor_id=$1 and id=$2',[p.a.actor,p.id]);
   const day=()=>c.query('select coalesce(sum(reserved_usd),0)::float8 r,coalesce(sum(spent_usd),0)::float8 s from daily_spend where day=(now() at time zone \'UTC\')::date').then(x=>x.rows[0]);
   const moved=(from,to)=>({r:+(to.r-from.r).toFixed(6),s:+(to.s-from.s).toFixed(6)});
   const pol=policy({gCredits:60,minCredits:20,uModelCredits:20,limits:{model:1,paidTools:0,freeTools:1}});
   const x=await pausedWithTool(),y=await pausedWithTool();
   const d0=await day();
   const next=await open(x.a,{resumeOf:x.id,pol});
   const d1=await day();
   await one("select turn_close($1,$2,'failed','[]',false,true,'resumed') v",[y.a.actor,y.id]);
   const d2=await day();
   const [cx,cy]=[await closed(x),await closed(y)];
   assert.deepEqual(cx.turn,cy.turn);assert.deepEqual(cx.calls,cy.calls);
   assert.deepEqual(cx.calls.map(k=>[k.seq,k.status,k.cost_pending]).slice(0,2),[[1,'ok',false],[2,'unknown',true]]);
   assert.equal(cy.active,null);assert.equal(cx.active,next.turnId);
   assert.equal(cx.turn.settlement,'pending');
   assert.equal(await absorbed(y),12);assert.equal(await absorbed(x),0,'what is carried is not absorbed');
   // The new turn's reservation (0.1) aside, the stop-loss moved the same; the new hold (72) aside, so did the balance.
   const [mx,my]=[moved(d0,d1),moved(d1,d2)];
   assert.deepEqual({r:+(mx.r-0.1).toFixed(6),s:mx.s},my);
   assert.equal((await balance(x.a))+72,await balance(y.a));
   for(const p of [x,y]){
    await one("select turn_call_record($1,$2,2,'ok',0.01,0.01,'{}',null,$3,'body') v",[p.a.actor,p.id,hash('late'+p.id)]);
    await recover(p.a,p.id,'settle');
   }
   const [lx,ly]=[await closed(x),await closed(y)];
   assert.deepEqual(lx,{...ly,active:next.turnId});assert.equal(lx.turn.settlement,'done');
   assert.equal(lx.turn.charged_credits,0);
   assert.equal(await one("select coalesce(has_function_privilege('service_role','public.turn_resume_close(uuid,bigint,integer)','execute'),false) v"),false);
   report.checks.push('turn_resume_close matches turn_close on the same paused turn (state, calls, stop-loss, balance, late tool receipt); internal to turn_open');
  }
  report.checks.push('resume after top-up: the paused turn is refunded and its 12 carried into the new turn (charged once with it); a fixed price stays 500 across a resume; two resumes in a row carry everything (24 = 12 + 6 + 6); a model cost not final yet holds the resume until the recovery lookup records its receipt; an expired continuation refunds the whole chain, the new turn freezes within what is left of the limits; short credits, too many calls, wrong state/kind/session refused and rolled back; replay idempotent; a resume racing the 24-hour expiry has one winner');
 }
 // 6. Ordinary chat and mentor turns cannot be stopped (the old stop-round scenario, now a refusal); reports can.
 {
  const a=await account();
  for(const kind of ['chat','mentor']){
   // A mentor turn needs the mentor's own context to open (0423); the stop rule only reads the kind, so the turn is relabelled.
   const o=await open(a);
   await c.query('update turns set kind=$1 where id=$2',[kind,o.turnId]);
   assert.match(await refusal(close(a,o.turnId,'stopped')),/TURN_STOP_NOT_ALLOWED/);
   await close(a,o.turnId,'completed');
  }
  report.checks.push('chat and mentor turns refuse a stop (TURN_STOP_NOT_ALLOWED)');
 }
 // 7. Service role only; the claim's selections use the partial indexes (no sequential scan on turns or turn_calls).
 {
  for(const fn of ['turn_recovery_claim(integer)','turn_recover(uuid,bigint,text)'])
   for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]])
    assert.equal(await one("select has_function_privilege($1,$2,'EXECUTE') v",[role,'public.'+fn]),want,`${fn} ${role}`);
  const text=await one("select string_agg(pg_get_functiondef(oid),E'\\n') v from pg_proc where proname in ('turn_recovery_claim','turn_recover')");
  assert.doesNotMatch(text,/pg_advisory|CREATE\s+TEMP|set_config\(|(;|\bBEGIN|\bTHEN|\bLOOP|\bELSE)\s*SET\s+(?!LOCAL\b)/i);
  await c.query('begin');
  try{
   await c.query('set local enable_seqscan=off');
   const plans=[];
   for(const sql of [
    `select actor_id,id from turns where ((state in ('running','stopping') and updated_at<now()-interval '15 minutes')
      or (state='paused' and updated_at<now()-interval '24 hours'))
      and (recovery_lease_until is null or recovery_lease_until<=now()) order by updated_at limit 50 for update skip locked`,
    `select t.actor_id,t.id from turns t where t.settlement='pending' and t.state='closed'
      and (t.recovery_lease_until is null or t.recovery_lease_until<=now())
      and exists (select 1 from turn_calls k where k.turn_id=t.id and ((k.cost_pending and k.provider_id is not null and k.call_kind='model')
        or (not k.cost_pending and k.settled_at>t.updated_at)))
      order by t.recovery_lease_until nulls first,t.updated_at limit 50 for update of t skip locked`,
    `select t.actor_id,t.id from turns t where t.state='paused' and t.updated_at>=now()-interval '24 hours'
      and (t.recovery_lease_until is null or t.recovery_lease_until<=now())
      and exists (select 1 from turn_calls k where k.turn_id=t.id and k.call_kind='model'
        and k.status in ('dispatched','identified') and k.provider_id is not null)
      order by t.recovery_lease_until nulls first,t.updated_at limit 50 for update of t skip locked`]){
    const plan=(await c.query('explain '+sql)).rows.map(r=>r['QUERY PLAN']).join('\n');
    plans.push(plan);
    assert.doesNotMatch(plan,/Seq Scan on (turns|turn_calls)\b/,plan);
   }
   report.claimPlans=plans;
  }finally{await c.query('rollback');}
  report.checks.push('service role only; no advisory locks, session SET or temp tables; both claim selections use indexes (no sequential scan on turns/turn_calls)');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
