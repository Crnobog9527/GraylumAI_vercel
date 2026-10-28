/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-3 (0421): turn_open / turn_call_begin / turn_call_identity / turn_call_record / turn_close.
// Plan 6.1 acceptance: idempotency, concurrency, conservation, balance never negative, 402, unknown cost, stop (reports only,
// 24-hour rule), pause, tombstones, voice source revocation, the stop-loss reserve (P concurrent opens never exceed L,
// spent <= reserved, P below the pool refused, crash close releases, cross-day close), and the static rules: transaction-level
// locks only, no SET / advisory locks / temp tables, relation locks of turn_open <= 40, no sequential scan.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {localDb,read,root} from '../runtime-view-perf/local-db.mjs';
import {reportCases} from './report-cases.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
// V2-7a: a report opens only for a Gold account's confirmed round (turn_report_admit); the fixture builds one per call.
db.sql(read('packages/db/tests/content-erasure/fixture.sql'));db.sql(read('packages/db/tests/turn-core/report-fixture.sql'));
const one=async(sql,args=[],client=c)=>(await client.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const {Client}=createRequire(resolve(root,'package.json'))('pg');
const peer=async()=>{const p=new Client({host:c.host,port:c.port,user:'postgres',database:c.database});await p.connect();return p;};
const near=(x,y)=>Math.abs(Number(x)-Number(y))<1e-9;
const refusal=async(promise)=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const q=100,m=6;
// Node computes the policy from the catalog cache; these are the frozen numbers (2.5.3).
const policy=(over={})=>({q,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:100,inputBytes:1000,
 limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5},...over});
// A report's shape (turn_report_admit): one call, no tools or history, the whole fixed price plus the call's bound frozen.
const reportPolicy=(src,over={})=>policy({gCredits:530,minCredits:530,fixedCredits:500,historyItems:0,
 limits:{model:1,paidTools:0,freeTools:0},report:{projectId:src.project,roundId:src.round,moduleId:src.module},...over});
const reportSource=a=>one('select turn_test.report_source($1) v',[a.actor]);
const openReport=(a,src,extra={})=>open(a,{kind:'report',session:src.session,pol:reportPolicy(src),...extra});
async function account(credits=1000){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,$2)',[actor,credits]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session,credits};
}
// As the API calls it: the service role (a report's membership check reads payment facts only for it, as in production).
const open=async(a,{kind='chat',request=randomUUID(),pol=policy(),session=a.session,client=c}={})=>{
 await client.query('set role service_role');
 try{return await one('select turn_open($1,$2,$3,$4,$5) v',[a.actor,session,request,kind,JSON.stringify(pol)],client);}
 finally{await client.query('reset role');}
};
const begin=(a,turn,seq,{kind='model',paid=null,upper=0.02,tool=null,request=hash('r'+turn+seq)}={})=>
 one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
  [a.actor,turn,seq,kind,kind==='tool'?null:randomUUID(),kind==='tool'?(tool??'research_search'):null,paid,request,upper,m]);
const identity=(a,turn,seq,id='gen-'+seq)=>one('select turn_call_identity($1,$2,$3,$4) v',[a.actor,turn,seq,id]);
const record=(a,turn,seq,{status='ok',n=0.01,actual=0.01,raw='body'}={})=>
 one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
  [a.actor,turn,seq,status,status==='ok'?n:null,status==='ok'?actual:null,JSON.stringify({cache_read:0}),null,hash('p'+turn+seq),raw]);
const close=(a,turn,kind='completed',{messages=[{role:'user',content:'hi'},{role:'assistant',content:'hello'}],delivered=true,refundAll=false}={})=>
 one('select turn_close($1,$2,$3,$4,$5,$6,null) v',[a.actor,turn,kind,JSON.stringify(messages),delivered,refundAll]);
const balance=a=>one('select credits v from profiles where id=$1',[a.actor]);
const spends=a=>one("select coalesce(sum(-amount),0)::int v from credit_transactions where user_id=$1 and reason_code='turn_spend'",[a.actor]);
const today=()=>one("select (now() at time zone 'UTC')::date::text v");
const dayTotals=async()=>(await c.query("select coalesce(sum(reserved_usd),0)::numeric r,coalesce(sum(spent_usd),0)::numeric s from daily_spend where day=(now() at time zone 'UTC')::date")).rows[0];
try{
 // 1. A free-chat turn end to end: freeze H, three call writes, settle once, two messages, the session free again.
 {
  const a=await account();
  const o=await open(a);
  assert.deepEqual([o.state,o.replay,o.reservedCredits,o.history],['running',false,60,[]]);
  assert.equal(await balance(a),940,'H=min(G,A)=60 is frozen');
  assert.deepEqual(await begin(a,o.turnId,1),{state:'running',status:'dispatched',replay:false,sessionTombstoned:false,accountErasing:false,voiceSourceRevoked:false});
  assert.equal((await identity(a,o.turnId,1)).status,'identified');
  const r=await record(a,o.turnId,1,{n:0.01});
  assert.equal(r.creditsLow,false);
  const closed=await close(a,o.turnId);
  // N = ceil(q x n x m) = ceil(100 x 0.01 x 6) = 6; D = min(N, H) = 6; the rest of the freeze comes back.
  assert.deepEqual([closed.chargedCredits,closed.absorbedCredits,closed.settlement],[6,0,'done']);
  assert.equal(await balance(a),994);assert.equal(await spends(a),6,'one net spend row');
  assert.equal(await one('select active_turn_id v from runtime_sessions where id=$1',[a.session]),null);
  assert.deepEqual((await c.query('select seq,role,content from session_messages where session_id=$1 order by seq',[a.session])).rows,
   [{seq:1,role:'user',content:'hi'},{seq:2,role:'assistant',content:'hello'}]);
  const next=await open(a);
  assert.deepEqual(next.history.map(h=>h.content),['hi','hello'],'the next turn reads the visible history');
  await close(a,next.turnId,'failed',{messages:[],delivered:false,refundAll:true});
  assert.equal(await balance(a),994,'a white-listed failure refunds the whole freeze');
  report.checks.push('chat turn: freeze H, dispatched -> identified -> ok, settle D=min(N,H) once with one net spend row, history appended and read back; white-listed failure refunds all');
 }
 // 2. Idempotency: the same request, the same call, the same close.
 {
  const a=await account(),request=randomUUID();
  const o=await open(a,{request});
  assert.deepEqual((await open(a,{request})),{...o,replay:true});
  assert.match(await refusal(open(a,{request,kind:'mentor'})),/TURN_REQUEST_CONFLICT/);
  await begin(a,o.turnId,1);
  assert.equal((await begin(a,o.turnId,1)).replay,true);
  assert.match(await refusal(begin(a,o.turnId,1,{request:hash('other')})),/TURN_CALL_CONFLICT/);
  assert.match(await refusal(begin(a,o.turnId,3)),/TURN_CALL_SEQUENCE/);
  await record(a,o.turnId,1);await record(a,o.turnId,1);
  const first=await close(a,o.turnId),again=await close(a,o.turnId);
  assert.equal(again.replay,true);
  for(const k of ['turnId','closeKind','chargedCredits','absorbedCredits','settlement'])assert.equal(again[k],first[k],'close replays '+k);
  assert.equal(await spends(a),6);assert.equal(await one('select count(*)::int v from turns where actor_id=$1',[a.actor]),1);
  report.checks.push('idempotent: repeated request, repeated call, repeated receipt and repeated close change nothing');
 }
 // 3. Concurrency: one turn per session; two sessions of one actor in parallel; open racing a deletion and an erasure.
 {
  const a=await account(),busy=await open(a);
  assert.match(await refusal(open(a)),/TURN_SESSION_BUSY/);
  const other=randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [other,a.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  const p=await peer();
  try{
   const [x,y]=await Promise.all([open(a,{session:other}),close(a,busy.turnId,'completed',{messages:[]})]);
   assert.ok(x.turnId&&y.closeKind);
   // Open waits on the session lock a deletion holds, then refuses.
   const b=await account();
   await p.query('begin');await p.query('select 1 from runtime_sessions where id=$1 for update',[b.session]);
   const racing=open(b).then(v=>({v}),e=>({e:e.message}));
   await new Promise(r=>setTimeout(r,200));
   await p.query('update runtime_sessions set content_deleted_at=now() where id=$1',[b.session]);await p.query('commit');
   assert.match((await racing).e??'',/TURN_SESSION_ERASED/);
   const e=await account();
   await c.query('insert into account_erasure_requests(profile_id,request_id) values($1,$2)',[e.actor,randomUUID()]);
   assert.match(await refusal(open(e)),/TURN_ACCOUNT_ERASING/);
  }finally{await p.end();}
  report.checks.push('one running turn per session; two sessions of one actor run in parallel; an open racing a deletion or an erasure is refused');
 }
 // 4. Limits, pause and credits_low: the frozen model / paid / free limits; the freeze cannot be exceeded.
 {
  const a=await account(30);
  const o=await open(a,{pol:policy({gCredits:60,minCredits:10,uModelCredits:20})});
  assert.equal(o.reservedCredits,30,'H = min(G, A) when the balance is short');
  assert.equal((await begin(a,o.turnId,1,{upper:0.02})).status,'dispatched');
  const r1=await record(a,o.turnId,1,{n:0.02});
  assert.equal(r1.creditsLow,true,'30 - 12 used < 20 needed for one more model call');
  assert.equal((await begin(a,o.turnId,2,{upper:0.04})).paused,true,'18 left < 24 for the next call: paused before sending');
  assert.equal(await one('select pause_reason v from turns where actor_id=$1 and id=$2',[a.actor,o.turnId]),'waiting_credits');
  assert.match(await refusal(begin(a,o.turnId,2)),/TURN_NOT_RUNNING/);
  const expired=await close(a,o.turnId,'expired',{messages:[],delivered:false});
  assert.equal(expired.chargedCredits,0,'a paused turn expiring after 24 hours undelivered refunds');
  assert.equal(await balance(a),30);
  const b=await account(),t=(await open(b)).turnId;
  for(let i=1;i<=3;i++){await begin(b,t,i);await record(b,t,i,{n:0.001});}
  assert.match(await refusal(begin(b,t,4)),/TURN_CALL_LIMIT/,'model limit M');
  const t2=(await (async()=>{await close(b,t,'completed',{messages:[]});return open(b);})()).turnId;
  await begin(b,t2,1,{kind:'tool',paid:true,upper:0.01});await record(b,t2,1,{n:0.001});
  assert.match(await refusal(begin(b,t2,2,{kind:'tool',paid:true,upper:0.01})),/TURN_CALL_LIMIT/,'paid tool limit');
  await begin(b,t2,2,{kind:'tool',paid:false,upper:0,tool:'read_source'});await record(b,t2,2,{n:0});
  assert.match(await refusal(begin(b,t2,3,{kind:'tool',paid:false,upper:0,tool:'load_skill'})),/TURN_CALL_LIMIT/,'free tool limit');
  // Certainly-free attempts do not use a limit: a not_sent attempt is retried as a new seq.
  await begin(b,t2,3);await record(b,t2,3,{status:'not_sent'});
  assert.equal((await begin(b,t2,4)).status,'dispatched');
  await record(b,t2,4,{status:'rejected'});
  assert.match(await refusal(identity(b,t2,4)),/TURN_CALL_CONFLICT/,'a rejected attempt never gets a provider id later');
  report.checks.push('frozen limits M / paid / free hold; a short freeze pauses the turn before sending; credits_low warns; expiry refunds; not_sent and rejected attempts are retried without using a limit');
 }
 // 5. Unknown cost and 402: never presumed zero, never retried; the freeze and the stop-loss reservation stay for recovery.
 {
  const a=await account();
  const before=await dayTotals();
  const o=await open(a,{pol:policy({uTurnUsd:0.2})});
  await begin(a,o.turnId,1,{upper:0.02});await record(a,o.turnId,1,{status:'no_charge_402'});
  await begin(a,o.turnId,2,{upper:0.05});await identity(a,o.turnId,2);
  const closed=await close(a,o.turnId,'interrupted',{messages:[],delivered:false});
  assert.deepEqual([closed.settlement,closed.chargedCredits],['pending',null]);
  assert.deepEqual((await c.query('select status,cost_pending,provider_id from turn_calls where turn_id=$1 order by seq',[o.turnId])).rows,
   [{status:'no_charge_402',cost_pending:false,provider_id:null},{status:'unknown',cost_pending:true,provider_id:'gen-2'}]);
  assert.equal(await balance(a),940,'the freeze is kept until the unknown cost is known');
  const after=await dayTotals();
  assert.ok(near(Number(after.r)-Number(before.r),0.05),'only the unknown call keeps its U_i reserved');
  report.checks.push('402 costs nothing; a call without a final receipt becomes unknown/cost_pending, keeps the freeze and its stop-loss share; settlement pending');
 }
 // 6. Stop: only reports; the first two stops within 24 hours are free, then what was generated (at most the fixed price).
 {
  const a=await account();
  const chat=await open(a);
  assert.match(await refusal(close(a,chat.turnId,'stopped')),/TURN_STOP_NOT_ALLOWED/);
  await close(a,chat.turnId,'completed',{messages:[]});
  const charges=[],src=await reportSource(a);
  for(let i=0;i<3;i++){
   const r=await openReport(a,src);
   await begin(a,r.turnId,1,{upper:0.5});await record(a,r.turnId,1,{n:0.2});
   charges.push((await close(a,r.turnId,'stopped',{messages:[],delivered:false})).chargedCredits);
  }
  assert.deepEqual(charges,[0,0,120]);
  const r=await openReport(a,src);
  await begin(a,r.turnId,1,{upper:0.5});await record(a,r.turnId,1,{n:0.01});
  assert.equal((await close(a,r.turnId,'completed',{messages:[],delivered:true})).chargedCredits,500,'a delivered report is the fixed price');
  report.checks.push('only a report can be stopped; first two stops in 24 hours free, the third charges what was generated; a delivered report charges the fixed price');
 }
 // 7. Tombstones: a deleted conversation, an erasing account or a revoked voice source stops the turn and saves nothing.
 {
  const a=await account(),o=await open(a);
  await begin(a,o.turnId,1);
  await c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[a.session]);
  assert.equal((await record(a,o.turnId,1)).sessionTombstoned,true);
  const closed=await close(a,o.turnId,'completed');
  assert.equal(closed.closeKind,'erased');assert.equal(closed.chargedCredits,6,'the receipt is still charged (deletion abort)');
  assert.equal(await one('select count(*)::int v from session_messages where session_id=$1',[a.session]),0);
  const v=await account(),version=randomUUID();
  await c.query("insert into voice_profile_versions(id,actor_id,request_id,status,version) values($1,$2,$3,'confirmed',1)",[version,v.actor,randomUUID()]).catch(()=>{});
  await c.query('insert into voice_profiles(actor_id,confirmed_version_id,enabled) values($1,$2,true)',[v.actor,version]).catch(()=>{});
  const vo=await open(v,{pol:policy({voiceVersionId:version})});
  const voiceKnown=await one('select count(*)::int v from voice_profiles where actor_id=$1',[v.actor]);
  await begin(v,vo.turnId,1);
  if(voiceKnown){
   assert.equal((await record(v,vo.turnId,1)).voiceSourceRevoked,false);
   await c.query('update voice_profiles set enabled=false where actor_id=$1',[v.actor]);
  }
  assert.equal((await one('select turn_tombstones($1,$2,$3) v',[v.actor,v.session,JSON.stringify({voiceVersionId:version})])).voiceSourceRevoked,true);
  report.checks.push('a deleted conversation, an erasing account or a revoked voice source is returned by every call write; close saves nothing and closes erased');
 }
 // 8. Stop-loss (2.5.1): P concurrent opens near the limit never reserve more than L; spent <= reserved; P below the pool refused;
 // a crashed turn's reservation is released by its recovery close; a close the next day releases the opening day's row.
 {
  await c.query('delete from daily_spend');
  const L=3,pol=policy({uTurnUsd:0.5,stopLoss:{limitUsd:L,p:8,poolSize:8,uFastUsd:0.5,uBigUsd:0.5}});
  // B = 7 x 0.5 + 0.5 = 4 > L: nothing may open (the band is the price of correctness).
  assert.match(await refusal(open(await account(),{pol})),/STOP_LOSS_REACHED/);
  const pol2=policy({uTurnUsd:0.5,stopLoss:{limitUsd:6,p:4,poolSize:4,uFastUsd:0.5,uBigUsd:0.5}});
  const clients=await Promise.all(Array.from({length:4},peer));
  try{
   const accounts=[];for(let i=0;i<12;i++)accounts.push(await account());
   const results=[];
   for(let i=0;i<12;i+=4)results.push(...await Promise.all(clients.map((cl,j)=>open(accounts[i+j],{pol:pol2,client:cl}).then(v=>v,e=>e.message))));
   const totals=await dayTotals();
   assert.ok(Number(totals.r)+Number(totals.s)<=6,`reserved ${totals.r} within L`);
   assert.ok(results.some(r=>typeof r==='string'&&/STOP_LOSS_REACHED/.test(r)),'opens near the limit are refused');
   assert.ok(results.some(r=>r.turnId),'opens below the limit pass');
   for(const [i,r] of results.entries())if(r.turnId){
    await begin(accounts[i],r.turnId,1,{upper:0.05});await record(accounts[i],r.turnId,1,{n:0.03});
    await close(accounts[i],r.turnId,'completed',{messages:[]});
   }
   const settled=await dayTotals();
   assert.ok(Number(settled.s)<=Number(totals.r),'spent <= what was reserved');
   assert.equal(Number(settled.r),0,'every close released its reservation');
  }finally{await Promise.all(clients.map(cl=>cl.end()));}
  assert.match(await refusal(open(await account(),{pol:policy({stopLoss:{limitUsd:1000,p:4,poolSize:8,uFastUsd:1,uBigUsd:1}})})),/TURN_STOP_LOSS_CONFIG/);
  // A crashed turn: recovery closes it interrupted; with no call begun its whole reservation comes back.
  const a=await account(),crashed=await open(a);
  const reserved=Number((await dayTotals()).r);
  await close(a,crashed.turnId,'interrupted',{messages:[],delivered:false});
  assert.ok(near((await dayTotals()).r,reserved-0.1));
  // Opened yesterday, closed today: the opening day's row is released.
  const b=await account(),late=await open(b);
  await c.query("update turns set policy=jsonb_set(policy,'{day}',to_jsonb((current_date-1)::text)) where id=$1",[late.turnId]);
  await c.query("insert into daily_spend(day,bucket,reserved_usd) select current_date-1,(policy->>'bucket')::smallint,0.1 from turns where id=$1",[late.turnId]);
  await close(b,late.turnId,'completed',{messages:[]});
  assert.equal(Number(await one("select reserved_usd v from daily_spend where day=current_date-1")),0);
  report.checks.push('stop-loss: concurrent opens near L never reserve beyond it, spent <= reserved, P below the pool refused, crash and next-day closes release the opening row');
 }
 // 9. Conservation and a balance that never goes negative; an overrun is absorbed by the platform.
 {
  const a=await account(100),o=await open(a,{pol:policy({gCredits:20,minCredits:5})});
  await begin(a,o.turnId,1,{upper:0.03});await record(a,o.turnId,1,{n:0.1});
  const closed=await close(a,o.turnId);
  // N = ceil(100 x 0.1 x 6) = 60 > H = 20: the user pays 20, the platform absorbs 40.
  assert.deepEqual([closed.chargedCredits,closed.absorbedCredits],[20,40]);
  assert.equal(await balance(a),80);assert.ok(await balance(a)>=0);
  const ledger=await one("select sum(amount)::int v from credit_transactions where user_id=$1",[a.actor]);
  assert.equal(ledger,await balance(a),'the credit records add up to the balance');
  report.checks.push('conservation: charged + absorbed = N; the freeze never goes negative; the credit records add up to the balance');
 }
 // 11. Codex #1512 review: a final receipt racing turn_close, the same receipt twice at once, and report stops in two sessions
 // of one account at once (with one free stop already used, exactly one more is free).
 {
  const p1=await peer(),p2=await peer();
  try{
   const as=(client,a)=>client.query("select set_config('request.jwt.claim.sub',$1,false)",[a.actor]);
   const a=await account(),o=await open(a);
   await begin(a,o.turnId,1);await identity(a,o.turnId,1);
   const recordOn=client=>client.query('select turn_call_record($1,$2,1,$3,$4,$5,$6,null,$7,$8) v',
    [a.actor,o.turnId,'ok',0.01,0.01,'{}',hash('same'),'raw']).then(r=>({ok:r.rows[0].v}),e=>({error:e.message}));
   const closeOn=client=>client.query("select turn_close($1,$2,'interrupted','[]',false,false,null) v",[a.actor,o.turnId])
    .then(r=>({ok:r.rows[0].v}),e=>({error:e.message}));
   await as(p1,a);await as(p2,a);
   const [r1,cl,r2]=await Promise.all([recordOn(p1),closeOn(c),recordOn(p2)]);
   assert.ok(!r1.error&&!r2.error&&!cl.error,JSON.stringify([r1,cl,r2]));
   const call=(await c.query('select status,cost_pending,settled_at is not null s from turn_calls where turn_id=$1 and seq=1',[o.turnId])).rows[0];
   assert.deepEqual(call,{status:'ok',cost_pending:false,s:true},'the receipt is kept whichever came first');
   assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[o.turnId]),1,'one raw body');
   // A provider id that arrives after the close marked the call unknown is still stored for recovery.
   const b=await account(),o2=await open(b);await begin(b,o2.turnId,1);
   await close(b,o2.turnId,'interrupted',{messages:[],delivered:false});
   await identity(b,o2.turnId,1,'gen-late');
   assert.deepEqual((await c.query('select status,provider_id from turn_calls where turn_id=$1',[o2.turnId])).rows[0],{status:'unknown',provider_id:'gen-late'});
   // Report stops: one free stop used; two more in two sessions at once -> one free, one charged.
   const r=await account(2000),one1=await reportSource(r),other=await reportSource(r);
   const rep=src=>openReport(r,src);
   const first=await rep(one1);await begin(r,first.turnId,1,{upper:0.5});await record(r,first.turnId,1,{n:0.2});
   await close(r,first.turnId,'stopped',{messages:[],delivered:false});
   const x=await rep(one1),y=await rep(other);
   for(const t of [x,y]){await begin(r,t.turnId,1,{upper:0.5});await record(r,t.turnId,1,{n:0.2});}
   await as(p1,r);await as(p2,r);
   const stop=(client,t)=>client.query("select turn_close($1,$2,'stopped','[]',false,false,null) v",[r.actor,t.turnId]).then(v=>v.rows[0].v);
   const charged=(await Promise.all([stop(p1,x),stop(p2,y)])).map(v=>v.chargedCredits).sort((m,n)=>m-n);
   assert.deepEqual(charged,[0,120],'exactly one of the two concurrent stops is free');
  }finally{await p1.end();await p2.end();}
  report.checks.push('a receipt racing turn_close or arriving twice is kept once; a late provider id is stored; concurrent report stops of one account count serially');
 }
 // 12. #1508 review P1 (2.5.4): a freeze lowers the available balance exactly once. atomic_pre_deduct takes H out of
 // profiles.credits; nothing subtracts turns.reserved_credits again, so another session of the account sees the true remainder.
 {
  const a=await account(1000),other=randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [other,a.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  const first=await open(a,{pol:policy({gCredits:400,minCredits:10})});
  assert.equal(first.reservedCredits,400);
  assert.equal(await balance(a),600);
  assert.equal(await one('select credit_available($1) v',[a.actor]),600,'available = balance after the freeze, not 600 - 400');
  // The other session asks for more than is left and is frozen exactly the 600 that remain.
  const second=await open(a,{session:other,pol:policy({gCredits:1000,minCredits:10})});
  assert.equal(second.reservedCredits,600);
  await close(a,second.turnId,'failed',{messages:[],delivered:false,refundAll:true});
  assert.equal(await balance(a),600);
  // Close the first with D = 150: N = ceil(100 x 0.25 x 6) = 150; 250 of the freeze comes back.
  await begin(a,first.turnId,1,{upper:0.5});await record(a,first.turnId,1,{n:0.25});
  assert.equal((await close(a,first.turnId,'completed',{messages:[]})).chargedCredits,150);
  assert.equal(await balance(a),850);
  assert.deepEqual((await c.query("select amount from credit_transactions where user_id=$1 and reason_code='turn_spend'",[a.actor])).rows,[{amount:-150}]);
  report.checks.push('a freeze lowers the available balance once: 1000 -> freeze 400 -> 600 available to another session; close D=150 -> 850, one -150 record');
 }
 // 13. turn_open returns what the prompt needs from the account (no extra round trip): the reply language, and for a free chat
 // the positioning gate (confirmed positioning, refusals in 24 hours counted on turns closed for it).
 {
  const a=await account();
  await c.query("update profiles set reply_language='en' where id=$1",[a.actor]);
  const first=await open(a);
  assert.equal(first.replyLanguage,'en');
  assert.deepEqual(first.positioning,{positioned:false,refusals24h:0});
  await c.query("select turn_close($1,$2,'failed','[]',false,true,'positioning_required')",[a.actor,first.turnId]);
  assert.deepEqual((await open(a)).positioning,{positioned:false,refusals24h:1});
  const b=await account(),report=await openReport(b,await reportSource(b));
  assert.equal(report.positioning,null,'only a free chat is gated');
 }
 report.checks.push('turn_open returns the reply language and, for a free chat, the positioning gate with its 24-hour refusal count');
 // 14. #1512 review: (P1) a late receipt after the account began erasure keeps its billing fields but never stores the response
 // text; (P2) two sessions of one account in different stop-loss buckets size H under the account lock, so the second freezes
 // what is left instead of being refused.
 {
  const e=await account();
  const o=await open(e);await begin(e,o.turnId,1);await identity(e,o.turnId,1,'gen-erase');
  await close(e,o.turnId,'interrupted',{messages:[],delivered:false});
  await c.query('insert into account_erasure_requests(profile_id,request_id) values($1,$2)',[e.actor,randomUUID()]);
  const late=await record(e,o.turnId,1,{n:0.01,raw:'user content'});
  assert.equal(late.accountErasing,true);
  assert.deepEqual((await c.query('select status,cost_pending,nominal_usd::text n from turn_calls where turn_id=$1',[o.turnId])).rows,
   [{status:'ok',cost_pending:false,n:'0.010000000000'}]);
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[o.turnId]),0,'no response text after erasure began');
  // The same for a deleted conversation.
  const d=await account();
  const od=await open(d);await begin(d,od.turnId,1);
  await close(d,od.turnId,'interrupted',{messages:[],delivered:false});
  await c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[d.session]);
  await record(d,od.turnId,1,{raw:'user content'});
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[od.turnId]),0);

  // P2: balance 100, a chat (actor bucket) and a compare (bucket -1) each ask 80 with threshold 10, opened at the same time
  // (a report now needs its whole fixed price, V2-7a, so the large-kind bucket is a compare's here).
  const a=await account(100),other=randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [other,a.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  const p1=await peer(),p2=await peer();
  try{
   const frozen=(await Promise.all([
    open(a,{client:p1,pol:policy({gCredits:80,minCredits:10})}),
    open(a,{client:p2,kind:'compare',session:other,pol:policy({gCredits:80,minCredits:10})}),
   ])).map(v=>v.reservedCredits).sort((x,y)=>x-y);
   assert.deepEqual(frozen,[20,80],'the second open freezes the 20 left');
   assert.equal(await balance(a),0);
  }finally{await p1.end();await p2.end();}
  report.checks.push('a late receipt after erasure began or the conversation was deleted keeps billing, stores no response text; concurrent opens in different buckets freeze 80 then the 20 left');
 }
 // 15. Fable 10-28: the positioning check (decision) has the Decisions model's real upper bound. It needs no freeze and is never
 // charged to the user, takes no slot of M (its own limit), and its provider cost is spent on the stop-loss like any call.
 {
  const a=await account(1000);
  const o=await open(a,{pol:policy({gCredits:30,uModelCredits:30,uTurnUsd:0.1,limits:{model:1,paidTools:0,freeTools:0,decisions:1}})});
  assert.equal(o.reservedCredits,30);
  const before=await dayTotals();
  // The freeze (30) covers one model call (G_i = ceil(100 x 0.05 x 6) = 30); the decision's 0.05 takes none of it.
  assert.equal((await begin(a,o.turnId,1,{kind:'decision',upper:0.05})).paused,undefined);
  await record(a,o.turnId,1,{n:0.04,actual:0.04,raw:null});
  assert.match(await refusal(begin(a,o.turnId,2,{kind:'decision',upper:0.05})),/TURN_CALL_LIMIT/);
  assert.equal((await begin(a,o.turnId,2,{upper:0.05})).paused,undefined,'the decision takes no slot of M and no freeze');
  await record(a,o.turnId,2,{n:0.01});
  assert.match(await refusal(begin(a,o.turnId,3,{upper:0.05})),/TURN_CALL_LIMIT/);
  // N = ceil(100 x 0.01 x 6) = 6 from the model call only; the stop-loss spends both receipts (0.05) and releases U_turn.
  assert.equal((await close(a,o.turnId)).chargedCredits,6);
  assert.equal(await balance(a),994);
  const after=await dayTotals();
  assert.ok(near(Number(after.s)-Number(before.s),0.05),`spent ${after.s} - ${before.s}`);
  assert.ok(near(Number(before.r)-Number(after.r),0.1),`released ${before.r} - ${after.r}`);
  report.checks.push('the positioning check needs no freeze, is not charged, takes no slot of M (own limit 1), and its cost is spent on the stop-loss');
 }
 // 16. #1512 review: an erasure that holds the account row (as account_erasure_confirm) while a turn_open waits for it; once it
 // commits, the open re-checks under the lock and is refused: no freeze, no turn.
 {
  const a=await account(1000);
  const p1=await peer(),p2=await peer();
  try{
   await p1.query('begin');
   await p1.query('select 1 from profiles where id=$1 for update',[a.actor]);
   await p1.query("update profiles set status='deleted',is_deleted='true',deleted_at=clock_timestamp() where id=$1",[a.actor]);
   await p1.query('insert into account_erasure_requests(profile_id,request_id) values($1,$2)',[a.actor,randomUUID()]);
   const opening=refusal(open(a,{client:p2}));
   // Wait until the open is blocked on the account row, then let the erasure commit.
   for(let i=0;i<100&&!(await one("select count(*)::int v from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[p2.processID]));i++)
    await new Promise(r=>setTimeout(r,20));
   assert.equal(await one("select count(*)::int v from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[p2.processID]),1,'open waits');
   await p1.query('commit');
   assert.match(await opening,/TURN_ACCOUNT_ERASING/);
   assert.equal(await one('select count(*)::int v from turns where actor_id=$1',[a.actor]),0);
   assert.equal(await balance(a),1000);
  }finally{await p1.end();await p2.end();}
  report.checks.push('a turn_open waiting on an account erasure that commits is refused under the account lock: no freeze, no turn');
 }
 // 17. #1512 review: a subscription refunded while its credits are frozen. 100 granted, 60 frozen from the period, the grant is
 // reversed, the turn closes with D = 6: the 54 left are intercepted (never returned). The credit records still add up to the
 // balance: +100, -6 spend, -54 intercepted (not a spend).
 {
  const actor=randomUUID(),session=randomUUID(),grant=randomUUID(),subscription='sub_'+randomUUID(),invoice='in_'+randomUUID();
  const day=24*3600e3,start=new Date(Date.now()-day).toISOString(),end=new Date(Date.now()+day).toISOString();
  await c.query('insert into profiles(id,credits) values($1,100)',[actor]);
  await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
   values($1,100,'addition','grant','opening_grant','system',$2,0,100)`,[actor,'opening_grant:'+actor]);
  await c.query(`insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
   values($1,'Local fixture','pro',true,true,500000000) on conflict(level) do nothing`,[randomUUID()]);
  const plan=await one("select id v from membership_plans where level='pro'");
  await c.query(`insert into user_subscriptions(user_id,stripe_subscription_id,membership_plan_id,billing_cycle,current_period_start,
   current_period_end,status) values($1,$2,$3,'monthly',$4,$5,'active')`,[actor,subscription,plan,start,end]);
  await c.query(`insert into subscription_credit_grants(id,user_id,stripe_subscription_id,membership_plan_id,billing_cycle,grant_type,
   grant_period_key,period_start,period_end,total_periods,stripe_invoice_id,credits_granted,consumed_amount,idempotency_key)
   values($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,100,0,$9)`,
  [grant,actor,subscription,plan,'invoice:'+invoice,start,end,invoice,'grant:'+invoice]);
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  const a={actor,session,credits:100};
  const o=await open(a,{pol:policy({gCredits:60,minCredits:10})});
  assert.equal(o.reservedCredits,60);
  assert.equal(await one("select metadata->>'chargedGrantId' v from billing_history where id=(select (policy->>'holdId')::uuid from turns where id=$1)",[o.turnId]),grant,
   'the freeze came from the subscription period');
  await c.query("update subscription_credit_grants set status='reversed' where id=$1",[grant]);
  // G_i = ceil(100 x 0.1 x 6) = 60 fits the freeze; N = ceil(100 x 0.01 x 6) = 6.
  await begin(a,o.turnId,1,{upper:0.1});await record(a,o.turnId,1,{n:0.01});
  assert.equal((await close(a,o.turnId)).chargedCredits,6);
  assert.equal(await balance(a),40,'the intercepted 54 are not returned');
  assert.deepEqual((await c.query("select reason_code,amount,counts_as_spend from credit_transactions where user_id=$1 and source_id=$2 order by amount desc",
   [actor,String(o.turnId)])).rows,[{reason_code:'turn_spend',amount:-6,counts_as_spend:true},{reason_code:'turn_intercepted',amount:-54,counts_as_spend:false}]);
  assert.equal(await one('select sum(amount)::int v from credit_transactions where user_id=$1',[actor]),40,'records add up to the balance');
  report.checks.push('a subscription refunded during a freeze: D=6 spend plus 54 intercepted (not a spend); the credit records add up to the balance');
 }
 // 18. #1512 review: a result the provider charged for but that cannot be used (unusable) costs the user nothing, but its actual
 // cost is kept on the receipt and spent on the stop-loss.
 {
  const a=await account(1000);
  const o=await open(a);
  const before=await dayTotals();
  await begin(a,o.turnId,1);
  await one('select turn_call_record($1,$2,1,$3,null,0.02,$4,null,$5,null) v',[a.actor,o.turnId,'unusable',JSON.stringify({}),hash('unusable')]);
  assert.deepEqual((await c.query('select status,nominal_usd::float8 n,actual_usd::float8 c,cost_pending from turn_calls where turn_id=$1',[o.turnId])).rows,
   [{status:'unusable',n:0,c:0.02,cost_pending:false}]);
  assert.equal((await close(a,o.turnId,'failed',{messages:[],delivered:false})).chargedCredits,0);
  assert.equal(await balance(a),1000);
  const after=await dayTotals();
  assert.ok(near(Number(after.s)-Number(before.s),0.02),`spent ${after.s} - ${before.s}`);
  report.checks.push('an unusable result the provider charged for: the user pays 0, the receipt keeps the actual cost and the stop-loss spends it');
 }
 // 19. #1512 review: replaying an old request never reads back a deleted conversation or an erasing account's history.
 {
  for(const erase of [
   a=>c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[a.session]),
   a=>c.query('insert into account_erasure_requests(profile_id,request_id) values($1,$2)',[a.actor,randomUUID()]),
  ]){
   const a=await account(),request=randomUUID();
   const o=await open(a,{request});await close(a,o.turnId);
   assert.equal((await open(a,{request})).replay,true,'the same request replays while nothing is deleted');
   await erase(a);
   assert.match(await refusal(open(a,{request})),/TURN_SESSION_ERASED|TURN_ACCOUNT_ERASING/);
  }
  report.checks.push('a replay of an old request is refused once the conversation is deleted or the account is erasing: no history read back');
 }
 // 20. #1512 review (plan 2.5.2, Owner 10-13): a third-party tool timing out without a final receipt is 0 to the user. The known
 // model cost settles now and the rest of the freeze comes back; only the tool's provider cost and its stop-loss share wait.
 {
  const a=await account(1000);
  const o=await open(a,{pol:policy({gCredits:60})});
  const before=await dayTotals();
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.01}); // N = ceil(100 x 0.01 x 6) = 6
  await begin(a,o.turnId,2,{kind:'tool',paid:true,upper:0.02});  // the search tool times out: no final receipt
  const closed=await close(a,o.turnId);
  assert.equal(closed.chargedCredits,6);
  assert.equal(closed.settlement,'pending','the provider cost of the tool is still unknown');
  assert.equal(await balance(a),994,'the freeze minus the known model cost came back');
  assert.deepEqual((await c.query("select call_kind,status,cost_pending from turn_calls where turn_id=$1 order by seq",[o.turnId])).rows,
   [{call_kind:'model',status:'ok',cost_pending:false},{call_kind:'tool',status:'unknown',cost_pending:true}]);
  const after=await dayTotals();
  // U_turn 0.1 reserved at open; close spends 0.01 and keeps the tool's 0.02 reserved until recovery.
  assert.ok(near(Number(after.s)-Number(before.s),0.01));
  assert.ok(near(Number(before.r)-Number(after.r),0.08),`released ${before.r} - ${after.r}`);
  // A model call without a final receipt still holds the whole freeze.
  const b=await account(1000);
  const ob=await open(b,{pol:policy({gCredits:60})});
  await begin(b,ob.turnId,1);
  assert.deepEqual(await close(b,ob.turnId,'interrupted',{messages:[],delivered:false}).then(r=>[r.chargedCredits,r.settlement]),[null,'pending']);
  assert.equal(await balance(b),940);
  report.checks.push('an unknown third-party tool result is 0 to the user: the known model cost settles and the rest of the freeze comes back; an unknown model call still holds it');
 }
 // 21. #1512 review: closed first, the receipt late, then settled. turn_close on a closed turn still pending settles what became
 // known since, once: credits (D = 6, 54 back), the stop-loss (0.01 spent, the whole reservation released), settlement done; the
 // close and its messages are kept. A full refund owed at the close still applies when it settles later.
 {
  const a=await account(1000),before=await dayTotals();
  const o=await open(a,{pol:policy({gCredits:60})});
  await begin(a,o.turnId,1);await identity(a,o.turnId,1,'gen-late-settle');
  const first=await close(a,o.turnId,'interrupted',{messages:[],delivered:false});
  assert.deepEqual([first.chargedCredits,first.settlement],[null,'pending']);
  assert.equal(await balance(a),940);
  await record(a,o.turnId,1,{n:0.01});
  const settled=await close(a,o.turnId,'interrupted',{messages:[],delivered:false});
  assert.deepEqual([settled.closeKind,settled.chargedCredits,settled.settlement,settled.replay],['interrupted',6,'done',true]);
  assert.equal(await balance(a),994);
  const after=await dayTotals();
  assert.ok(near(Number(after.s)-Number(before.s),0.01),`spent ${after.s} - ${before.s}`);
  assert.ok(near(Number(after.r),Number(before.r)),`reserved ${after.r} vs ${before.r}`);
  // Again: nothing more happens.
  assert.equal((await close(a,o.turnId,'interrupted')).chargedCredits,6);
  assert.equal(await balance(a),994);
  assert.ok(near(Number((await dayTotals()).s),Number(after.s)));
  assert.equal(await spends(a),6);
  assert.equal(await one('select count(*)::int v from session_messages where session_id=$1',[a.session]),0);
  // A full refund owed at the close (failed, refundAll) is kept for the later settlement: D = 0.
  const b=await account(1000);
  const ob=await open(b,{pol:policy({gCredits:60})});
  await begin(b,ob.turnId,1);
  await c.query("select turn_close($1,$2,'failed','[]',false,true,'turn_failed')",[b.actor,ob.turnId]);
  await record(b,ob.turnId,1,{n:0.01});
  assert.equal((await close(b,ob.turnId,'failed')).chargedCredits,0);
  assert.equal(await balance(b),1000);
  report.checks.push('closed first, receipt late, settled by turn_close again: D=6 and 54 back once, stop-loss spent 0.01 and released, messages kept; a full refund owed at the close still applies');
 }
 // 22. The per-kind hook (controller 10-28): turn_open returns kindContext (null until a kind adds its branch); turn_close takes
 // p_kind_result and refuses it while no kind handles one, without closing the turn; the replay of a closed turn ignores it.
 {
  const a=await account();
  const o=await open(a);
  assert.ok('kindContext' in o);
  assert.equal(o.kindContext,null);
  assert.match(await refusal(c.query("select turn_close($1,$2,'completed','[]',true,false,null,'{\"draft\":1}') v",[a.actor,o.turnId])),
   /TURN_KIND_RESULT_UNSUPPORTED/);
  assert.equal(await one('select state v from turns where id=$1',[o.turnId]),'running','the refused close changed nothing');
  await close(a,o.turnId);
  assert.equal((await one("select turn_close($1,$2,'completed','[]',true,false,null,'{\"draft\":1}') v",[a.actor,o.turnId])).replay,true);
  assert.equal(await one("select count(*)::int v from pg_proc where proname='turn_close' and pronamespace='public'::regnamespace"),1,'one signature only');
  report.checks.push('the per-kind hook: turn_open returns kindContext null; turn_close refuses a kind result no kind handles yet, with one signature');
 }
 // 23. #1512 review: the later settlement keeps the close's decisions. (P1) A tool unknown at the close stays 0 to the user even
 // when the model receipt is also late: D counts the model only. (P2) A report stop that was the third at the close stays charged:
 // the close and the settlement count stops at the same instant, taken under the account lock.
 {
  const a=await account(1000);
  const o=await open(a,{pol:policy({gCredits:60})});
  await begin(a,o.turnId,1);await begin(a,o.turnId,2,{kind:'tool',paid:true,upper:0.02});
  await close(a,o.turnId,'interrupted',{messages:[],delivered:false});
  await record(a,o.turnId,1,{n:0.01});await record(a,o.turnId,2,{n:0.02});
  const settled=await close(a,o.turnId,'interrupted');
  assert.deepEqual([settled.chargedCredits,settled.settlement],[6,'done'],'D = 6 from the model; the late tool receipt (12) is not charged');
  assert.equal(await balance(a),994);

  const r=await account(2000),mine=await reportSource(r),other=await reportSource(r);
  const rep=src=>openReport(r,src);
  const used=await rep(mine);await begin(r,used.turnId,1,{upper:0.5});await record(r,used.turnId,1,{n:0.2});
  await close(r,used.turnId,'stopped',{messages:[],delivered:false});            // the one free stop already used
  const x=await rep(mine),y=await rep(other);
  await begin(r,x.turnId,1,{upper:0.5});await record(r,x.turnId,1,{n:0.2});
  await begin(r,y.turnId,1,{upper:0.5});                                          // y's model receipt will be late
  const p2=await peer();
  try{
   // y's transaction starts first, x closes and commits, then y closes: y's now() is earlier than x's close.
   await p2.query('begin');await p2.query('select 1');
   await close(r,x.turnId,'stopped',{messages:[],delivered:false});               // second stop: free
   await p2.query("select turn_close($1,$2,'stopped','[]',false,false,null)",[r.actor,y.turnId]);
   await p2.query('commit');
  }finally{await p2.end();}
  await record(r,y.turnId,1,{n:0.2});
  assert.equal((await close(r,y.turnId,'stopped')).chargedCredits,120,'the third stop is charged when it settles later');
  report.checks.push('a later settlement keeps the close: an unknown tool stays 0 to the user; a third report stop stays charged');
 }
 // V2-7a: kind=report (report-cases.mjs).
 await reportCases({c,one,open,begin,identity,record,close,balance,account,reportSource,reportPolicy,openReport,refusal,peer,report});
 // 10. Static rules and budget: service role only; transaction-level locks; turn_open holds <= 40 relation locks; indexes used.
 {
  for(const fn of ['turn_open(uuid,uuid,uuid,text,jsonb,bigint)','turn_call_begin(uuid,bigint,integer,text,uuid,text,boolean,text,numeric,numeric)',
   'turn_call_identity(uuid,bigint,integer,text)','turn_call_record(uuid,bigint,integer,text,numeric,numeric,jsonb,text,text,text)',
   'turn_close(uuid,bigint,text,jsonb,boolean,boolean,text,jsonb)','turn_stop(uuid,bigint,boolean,integer)',
   'turn_report_read(uuid,uuid,uuid,bigint)'])
   for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]])
    assert.equal(await one("select has_function_privilege($1,$2,'EXECUTE') v",[role,'public.'+fn]),want,`${fn} ${role}`);
  for(const fn of ['turn_settle_credits(uuid,uuid,integer,bigint)','turn_tombstones(uuid,uuid,jsonb)',
   'turn_user_charge(uuid,bigint,text,boolean,boolean,integer,integer,integer,timestamp with time zone)',
   'turn_report_admit(uuid,uuid,jsonb)'])
   assert.equal(await one("select has_function_privilege('service_role',$1,'EXECUTE') v",['public.'+fn]),false,fn);
  const text=await one("select string_agg(pg_get_functiondef(oid),E'\\n') v from pg_proc where proname like 'turn\\_%' and pronamespace='public'::regnamespace");
  // No advisory lock, temp table, session-level set_config or SET statement (the SET clauses of UPDATEs are not statements).
  assert.doesNotMatch(text,/pg_advisory|CREATE\s+TEMP|set_config\(|(;|\bBEGIN|\bTHEN|\bLOOP|\bELSE)\s*SET\s+(?!LOCAL\b)/i);
  // Relation locks held at the end of one open, per table (indexes and TOAST with their table).
  const lockedBy=async work=>{
   await c.query('begin');
   try{
    await work();
    return (await c.query(`select coalesce(t.relname,i.relname) tbl,count(*)::int n from pg_locks l join pg_class i on i.oid=l.relation
      left join pg_index x on x.indexrelid=i.oid left join pg_class t on t.oid=coalesce(x.indrelid,(select oid from pg_class where reltoastrelid=i.oid))
      where l.pid=pg_backend_pid() and l.locktype='relation' and i.relnamespace='public'::regnamespace group by 1`)).rows;
   }finally{await c.query('rollback');}
  };
  const a=await account();
  await c.query('begin');
  try{
   await open(a);
   // Counted per table (indexes and TOAST with their table). The ledger leaves (atomic_pre_deduct, credit_available and the
   // tables they read) are recorded but not budgeted, the same convention as the closure check (plan 5.2, 7.1).
   const byTable=(await c.query(`select coalesce(t.relname,i.relname) tbl,count(*)::int n from pg_locks l join pg_class i on i.oid=l.relation
     left join pg_index x on x.indexrelid=i.oid left join pg_class t on t.oid=coalesce(x.indrelid,(select oid from pg_class where reltoastrelid=i.oid))
     where l.pid=pg_backend_pid() and l.locktype='relation' and i.relnamespace='public'::regnamespace group by 1`)).rows;
   const ledger=new Set(['subscription_credit_grants','user_subscriptions','billing_history','credit_package_sources','credit_source_entries',
    'credit_source_entries_id_seq','credit_source_reviews','payment_orders','bill2_runs','pay_disputes']);
   const locks=byTable.filter(r=>!ledger.has(r.tbl)).reduce((n,r)=>n+r.n,0);
   report.turnOpenRelationLocks=locks;
   report.turnOpenLedgerLocks=byTable.filter(r=>ledger.has(r.tbl)).reduce((n,r)=>n+r.n,0);
   assert.ok(locks<=40,`turn_open relation locks ${locks}`);
  }finally{await c.query('rollback');}
  report.checks.push(`service role only (helpers unexposed); no advisory locks, session SET or temp tables; turn_open holds ${report.turnOpenRelationLocks} relation locks on core-path tables (<= 40) plus ${report.turnOpenLedgerLocks} in the ledger leaves`);
  // V2-7a: a report's open also reads its source (report_source, membership, benchmarks); the core-path tables stay <= 40 and
  // the source tables (the artifact, draft, research and payment-fact reads of the old report admission) are recorded apart.
  const r=await account(),src=await reportSource(r),chatTables=new Set((await lockedBy(()=>open(a))).map(x=>x.tbl));
  const ledger=new Set(['subscription_credit_grants','user_subscriptions','billing_history','credit_package_sources','credit_source_entries',
   'credit_source_entries_id_seq','credit_source_reviews','payment_orders','bill2_runs','pay_disputes']);
  const rows=await lockedBy(()=>openReport(r,src));
  const core=rows.filter(x=>chatTables.has(x.tbl)&&!ledger.has(x.tbl)).reduce((n,x)=>n+x.n,0);
  report.reportOpenRelationLocks={core,source:rows.filter(x=>!chatTables.has(x.tbl)&&!ledger.has(x.tbl)).reduce((n,x)=>n+x.n,0),
   ledger:rows.filter(x=>ledger.has(x.tbl)).reduce((n,x)=>n+x.n,0)};
  assert.ok(core<=40,`report turn_open core-path relation locks ${core}`);
  report.checks.push(`a report's turn_open: ${core} relation locks on core-path tables (<= 40), ${report.reportOpenRelationLocks.source} on its source reads, ${report.reportOpenRelationLocks.ledger} in the ledger leaves`);
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
