/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-7b: compare, jury and jury adoption on the per-turn core (turn_fusion_open / turn_fusion_begin /
// turn_fusion_record / turn_fusion_close, fusion_review_turn_step, fusion_compare_turn_adopt, turn_fusion_recovery).
// The fusion suites' money and admission scenarios on turns (plan 6.1 V2-7b: normal, duplicate, concurrent, failure, 24 hours):
// Gold gate, fixed price and its delivery rule, the group's temporary bound, the wait between groups, the 24-hour end, the
// 3-unfinished version rule, deleted reviews, compare bounds <= 500 with per-column rounding, adoption, one jury adoption.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {localDb,root} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[],client=c)=>(await client.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const {Client}=createRequire(resolve(root,'package.json'))('pg');
const peer=async()=>{const p=new Client({host:c.host,port:c.port,user:'postgres',database:c.database});await p.connect();return p;};
const refusal=async(promise)=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const q=100,m=6,FIXED=1500;
const stopLoss={limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5};
// A jury: the fixed price plus the largest group's bound (3 seats x ceil(100 x 0.1 x 6) = 180) in the freeze.
const juryPolicy=(over={})=>({q,uTurnUsd:0.7,gCredits:FIXED+180,minCredits:FIXED+180,fixedCredits:FIXED,uModelCredits:60,historyItems:0,
 inputBytes:1000,limits:{model:7,paidTools:0,freeTools:0,decisions:0},stopLoss,...over});
const comparePolicy=(over={})=>({q,uTurnUsd:0.2,gCredits:120,minCredits:120,uModelCredits:60,historyItems:0,inputBytes:1000,
 limits:{model:2,paidTools:0,freeTools:0,decisions:0},stopLoss,...over});
await c.query(`insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
 values($1,'Gold fixture','gold',true,true,500000000) on conflict(level) do update set allow_fusion_review=true,allow_fusion_compare=true`,[randomUUID()]);
await c.query(`insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
 values($1,'Pro fixture','pro',true,true,500000000) on conflict(level) do update set allow_fusion_review=true,allow_fusion_compare=true`,[randomUUID()]);
async function account(credits=3000,level='gold'){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits,membership_level) values($1,$2,$3)',[actor,credits,level]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session,credits,version:randomUUID()};
}
async function review(a,{state='running',version=a.version,outcome=null,adoption=null}={}){
 const id=randomUUID();
 await c.query(`insert into fusion_reviews(id,actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
  materials,materials_hash,config,state,round,phase,attempt,outcome,adoption,ended_at) values($1,$2,$3,$4,$5,$6,$7,'h','{}',$8,
  '{"maxRounds":2,"path":"turn"}',$9,1,'review',1,$10,$11,case when $9 in ('running','paused') then null else now() end)`,
 [id,a.actor,randomUUID(),randomUUID(),randomUUID(),a.session,version,hash('m'),state,outcome&&JSON.stringify(outcome),adoption&&JSON.stringify(adoption)]);
 return id;
}
const open=(a,{kind='jury',request=randomUUID(),pol=juryPolicy(),product={},session=a.session,client=c}={})=>
 one('select turn_fusion_open($1,$2,$3,$4,$5,$6) v',[a.actor,session,request,kind,JSON.stringify(pol),JSON.stringify(product)],client);
const begin=(a,turn,seq,{upper=0.1,client=c}={})=>one('select turn_fusion_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,'model',randomUUID(),null,null,hash('r'+turn+seq),upper,m],client);
const record=(a,turn,seq,{status='ok',n=0.05,actual=0.05,output,deliverable=false,client=c}={})=>
 one('select turn_fusion_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v',[a.actor,turn,seq,status,status==='ok'?n:status==='unusable'?0:null,
  ['ok','unusable'].includes(status)?actual:null,JSON.stringify(deliverable?{deliverable:true}:{}),null,hash('p'+turn+seq),null,
  output===undefined?null:JSON.stringify(output)],client);
const close=(a,turn,kind='completed',{delivered=false,refundAll=false,failure=null,product={}}={})=>
 one('select turn_fusion_close($1,$2,$3,$4,$5,$6,$7) v',[a.actor,turn,kind,delivered,refundAll,failure,JSON.stringify(product)]);
const step=(a,id,from,to)=>one('select fusion_review_turn_step($1,$2,$3,$4) v',[a.actor,id,JSON.stringify(from),JSON.stringify(to)]);
const balance=a=>one('select credits v from profiles where id=$1',[a.actor]);
const ledger=a=>one('select sum(amount)::int v from credit_transactions where user_id=$1',[a.actor]);
const turnRow=(a,id)=>c.query('select * from turns where actor_id=$1 and id=$2',[a.actor,id]).then(r=>r.rows[0]);
const seat=(body='opinion')=>({phase:'fusion_review',body,verdict:'usable'});
try{
 // 1. Gold only (record D, 10-20): Free and Pro are refused with nothing frozen, the review untouched; Gold opens.
 {
  for(const level of ['free','pro']){
   const a=await account(3000,level),rv=await review(a);
   assert.match(await refusal(open(a,{product:{reviewId:rv}})),/TURN_MEMBERSHIP_REQUIRED/);
   assert.match(await refusal(open(a,{kind:'compare',pol:comparePolicy(),product:{question:'q',questionHash:hash('q'),
    requestHash:hash('r'),snapshotHash:hash('s')}})),/TURN_MEMBERSHIP_REQUIRED/);
   assert.equal(await balance(a),3000);
   assert.equal(await one('select count(*)::int v from turns where actor_id=$1',[a.actor]),0);
   assert.equal(await one('select turn_id v from fusion_reviews where id=$1',[rv]),null);
  }
  const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv}});
  assert.equal(o.reservedCredits,FIXED+180);assert.equal(o.reviewId,rv);
  // #1522 review: a new jury waits for its first group (paused, awaiting_user), so the 24-hour rule covers a group never sent.
  assert.deepEqual(await one("select jsonb_build_array(state,pause_reason) v from turns where id=$1",[o.turnId]),['paused','awaiting_user']);
  await c.query("update turns set updated_at=now()-interval '25 hours' where id=$1",[o.turnId]);
  await one('select turn_fusion_recovery(50) v');
  assert.deepEqual([(await one('select close_kind v from turns where id=$1',[o.turnId])),await one('select charged_credits v from turns where id=$1',[o.turnId])],
   ['expired',0],'a first group never sent: ended at 24 hours, fixed price and bound refunded');
  assert.equal(await one('select credits v from profiles where id=$1',[a.actor]),3000);
  assert.equal(await one('select turn_id::int v from fusion_reviews where id=$1',[rv]),o.turnId);
  report.checks.push('Gold only: Free and Pro are refused for review and compare with nothing frozen and no turn; Gold freezes the fixed price plus the group bound; a new jury waits for its first group and ends refunded at 24 hours if it is never sent');
 }
 // 2. Normal jury: three seats in parallel (one begin each, in sequence), the wait between groups, the summary, the fixed
 // price once; the seats' costs are recorded for the platform only; the review record and its read model follow the turn.
 {
  const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv}}),t=o.turnId;
  await step(a,rv,{round:1,phase:'review',attempt:1},{state:'claim',fromSeq:1});
  for(const s of [1,2,3])assert.equal((await begin(a,t,s)).status,'dispatched');
  assert.equal(await balance(a),3000-FIXED-180,'the freeze is taken once at open, not per seat');
  await record(a,t,1,{output:seat('a')});await record(a,t,2,{status:'unusable',output:{...seat('bad'),verdict:'format_invalid'}});
  assert.equal((await turnRow(a,t)).state,'running','a seat still in flight keeps the turn running');
  await record(a,t,3,{output:seat('c')});
  assert.deepEqual([(await turnRow(a,t)).state,(await turnRow(a,t)).pause_reason],['paused','awaiting_user'],
   'nothing left in flight: the jury waits between groups');
  await step(a,rv,{round:1,phase:'review',attempt:1},{state:'running',round:1,phase:'summary',attempt:1});
  await step(a,rv,{round:1,phase:'summary',attempt:1},{state:'claim',fromSeq:4});
  assert.equal((await begin(a,t,4)).status,'dispatched');
  assert.equal((await turnRow(a,t)).state,'running','the next group resumes the turn');
  await record(a,t,4,{output:{phase:'fusion_summary',body:'revised',verdict:'usable'},deliverable:true});
  const view=await one('select fusion_review_read($1,$2) v',[a.actor,rv]);
  assert.deepEqual(view.calls.map(x=>[x.phase,x.verdict]),[['fusion_review','usable'],['fusion_review','format_invalid'],
   ['fusion_review','usable'],['fusion_summary','usable']]);
  assert.equal(view.calls[3].groupId,view.steps[1].groupId,'calls are grouped by the step whose first sequence they follow');
  assert.equal((await one('select fusion_call_output_read($1,$2) v',[a.actor,view.calls[0].callId])).body,'a');
  assert.equal(view.fee.state,'held');
  const closed=await close(a,t,'completed',{delivered:true,product:{state:'completed',outcome:{kind:'revised'}}});
  assert.equal(closed.chargedCredits,FIXED);
  assert.equal(await balance(a),3000-FIXED);assert.equal(await ledger(a),3000-FIXED,'the records add up to the balance');
  const after=await one('select fusion_review_read($1,$2) v',[a.actor,rv]);
  assert.deepEqual([after.state,after.fee.state,after.fee.chargedCredits],['completed','charged',FIXED]);
  assert.ok(Number(await one('select absorbed_credits v from turns where id=$1',[t]))>=0);
  assert.equal(await one("select count(*)::int v from runtime_sessions where id=$1 and active_turn_id is not null",[a.session]),0,
   'the jury never occupied its draft conversation');
  report.checks.push('normal jury: three seats begun in sequence and recorded in parallel, the wait between groups, the summary; the fixed price charged once; seats cost the user nothing on their own; review record and read model follow the turn');
 }
 // 3. Delivery rule (fusion_review_fee_settle_internal): no change, a failed revision and an incomplete review refund all; an
 // interruption pays the known usage, at most the fixed price; a deliverable summary pays the price however the turn ends.
 {
  const run=async(fn)=>{const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv}});return fn(a,rv,o.turnId);};
  const noChange=await run(async(a,rv,t)=>{await begin(a,t,1);await record(a,t,1,{output:seat()});
   return (await close(a,t,'completed',{product:{state:'completed',outcome:{kind:'no_change'}}})).chargedCredits;});
  const failed=await run(async(a,rv,t)=>{await begin(a,t,1);await record(a,t,1,{output:seat()});
   return (await close(a,t,'failed',{refundAll:true,failure:'revision_failed',product:{state:'revision_failed',outcome:{kind:'revision_failed'}}})).chargedCredits;});
  const small=await run(async(a,rv,t)=>{await begin(a,t,1);await record(a,t,1,{n:0.05});
   return (await close(a,t,'interrupted',{product:{state:'interrupted',outcome:{kind:'interrupted'}}})).chargedCredits;});
  const large=await run(async(a,rv,t)=>{for(const s of [1,2,3]){await begin(a,t,s);await record(a,t,s,{n:3});}
   return (await close(a,t,'interrupted')).chargedCredits;});
  const delivered=await run(async(a,rv,t)=>{await begin(a,t,1);await record(a,t,1,{n:0.01,deliverable:true});
   return (await close(a,t,'interrupted')).chargedCredits;});
  assert.deepEqual([noChange,failed,small,large,delivered],[0,0,30,FIXED,FIXED]);
  report.checks.push('jury delivery rule: no change, revision failed and incomplete refund all; interrupted pays min(fixed, known usage) (30, capped at 1500); a deliverable summary pays the price however it ends');
 }
 // 4. The group's temporary bound (10-13): the freeze above the fixed price covers the calls in flight; a call that does not fit
 // waits for credits before it is sent; a finished group's bound is free again.
 {
  const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv},pol:juryPolicy({gCredits:FIXED+120,minCredits:FIXED+120})});
  await begin(a,o.turnId,1);await begin(a,o.turnId,2);
  assert.equal((await begin(a,o.turnId,3)).paused,true,'1500 + 60 + 60 in flight: a third seat (60) does not fit the 1620 freeze');
  assert.equal((await turnRow(a,o.turnId)).pause_reason,'waiting_credits');
  const b=await account(),rb=await review(b),ob=await open(b,{product:{reviewId:rb},pol:juryPolicy({gCredits:FIXED+120,minCredits:FIXED+120})});
  for(const s of [1,2]){await begin(b,ob.turnId,s);await record(b,ob.turnId,s,{n:2});}
  assert.equal((await begin(b,ob.turnId,3)).status,'dispatched','finished calls no longer count, whatever they cost');
  const short=await account(1600);
  assert.match(await refusal(open(short,{product:{reviewId:await review(short)}})),/TURN_INSUFFICIENT_CREDITS/,
   'below fee + temporary bound nothing opens');
  assert.equal(await balance(short),1600);
  report.checks.push('temporary bound: only calls in flight count against the freeze above the fixed price; a seat that does not fit pauses for credits before sending; below fee + bound nothing opens');
 }
 // 5. Duplicate: a repeated open is the same turn (one freeze); a repeated receipt with the same answer changes nothing, a
 // different answer conflicts; concurrent opens of one request make one turn; a second jury for the same review is refused.
 {
  const a=await account(),rv=await review(a),request=randomUUID();
  const p1=await peer(),p2=await peer();
  try{
   const [x,y]=await Promise.all([open(a,{request,product:{reviewId:rv},client:p1}),open(a,{request,product:{reviewId:rv},client:p2})]);
   assert.equal(x.turnId,y.turnId);assert.equal(x.replay!==y.replay,true);
  }finally{await p1.end();await p2.end();}
  const again=await open(a,{request,product:{reviewId:rv}});
  assert.equal(again.replay,true);assert.equal(await balance(a),3000-FIXED-180);
  assert.match(await refusal(open(a,{product:{reviewId:rv}})),/TURN_PRODUCT_CONFLICT/);
  await begin(a,again.turnId,1);await record(a,again.turnId,1,{output:seat('same')});
  await record(a,again.turnId,1,{output:seat('same')});
  assert.match(await refusal(record(a,again.turnId,1,{output:seat('other')})),/TURN_CALL_CONFLICT/);
  const first=await close(a,again.turnId,'completed',{product:{state:'completed',outcome:{kind:'no_change'}}});
  const repeat=await close(a,again.turnId,'completed',{product:{state:'completed',outcome:{kind:'no_change'}}});
  assert.equal(repeat.replay,true);assert.equal(repeat.chargedCredits,first.chargedCredits);
  assert.equal(await balance(a),3000);assert.equal(await ledger(a),3000);
  report.checks.push('duplicate: concurrent and repeated opens of one request make one turn and one freeze; a second jury for the review is refused; a repeated receipt is a no-op, a different answer conflicts; a repeated close replays');
 }
 // 6. Concurrent with the conversation: the jury does not occupy its draft conversation, a chat turn opens there meanwhile;
 // a compare does occupy its conversation, and only one compare runs per user.
 {
  const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv}});
  const chat=await one('select turn_open($1,$2,$3,$4,$5) v',[a.actor,a.session,randomUUID(),'chat',JSON.stringify({q,uTurnUsd:0.1,
   gCredits:60,minCredits:10,uModelCredits:30,historyItems:10,inputBytes:1000,limits:{model:1,paidTools:0,freeTools:0},stopLoss})]);
  assert.ok(chat.turnId&&o.turnId);
  const b=await account();
  const cp={question:'which?',questionHash:hash('which?'),requestHash:hash('r'),snapshotHash:hash('s')};
  const cmp=await open(b,{kind:'compare',pol:comparePolicy(),product:cp});
  assert.ok(cmp.compareId);
  const other=randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [other,b.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  assert.match(await refusal(open(b,{kind:'compare',session:other,pol:comparePolicy(),product:cp})),/TURN_COMPARE_ACTIVE/);
  assert.match(await refusal(one('select turn_open($1,$2,$3,$4,$5) v',[b.actor,b.session,randomUUID(),'chat',JSON.stringify({q,uTurnUsd:0.1,
   gCredits:60,minCredits:10,uModelCredits:30,historyItems:10,inputBytes:1000,limits:{model:1,paidTools:0,freeTools:0},stopLoss})])),
   /TURN_SESSION_BUSY/,'a compare is a turn of its conversation');
  // Two compares opened at the same time in two conversations of one account: one opens, the other is refused (#1522 review).
  const d=await account(),second=randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [second,d.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  const q1=await peer(),q2=await peer();
  try{
   await q1.query('begin');
   const first=await open(d,{kind:'compare',pol:comparePolicy(),product:cp,client:q1});
   const racing=open(d,{kind:'compare',session:second,pol:comparePolicy(),product:cp,client:q2}).then(v=>({v}),e=>({e:e.message}));
   await new Promise(r=>setTimeout(r,300));
   await q1.query('commit');
   assert.ok(first.turnId);
   assert.match((await racing).e??'',/TURN_COMPARE_ACTIVE/);
  }finally{await q1.end();await q2.end();}
  assert.equal(await one("select count(*)::int v from turns where actor_id=$1 and kind='compare'",[d.actor]),1);
  assert.equal(await one('select count(*)::int v from fusion_compares where actor_id=$1',[d.actor]),1);
  // #1522 review: a free chat closing in a conversation (turn_close locks the account, then the conversation) while a compare
  // opens there: the compare takes the account first too, so it waits instead of deadlocking.
  const k=await account(),closer=await peer(),opener=await peer();
  try{
   await closer.query('begin');
   await closer.query('select 1 from profiles where id=$1 for update',[k.actor]);
   const opening=open(k,{kind:'compare',pol:comparePolicy(),product:cp,client:opener}).then(v=>({v}),e=>({e:e.message}));
   await new Promise(r=>setTimeout(r,300));
   await closer.query("set local lock_timeout='3s'");
   await closer.query('select 1 from runtime_sessions where id=$1 for update',[k.session]);
   await closer.query('commit');
   const opened=await opening;
   assert.ok(opened.v?.turnId,'the compare opens after the close: '+JSON.stringify(opened));
  }finally{await closer.end();await opener.end();}
  report.checks.push('concurrency: a jury leaves its draft conversation free (a chat turn opens meanwhile); a compare occupies its conversation; one compare per user, also for two opened at once in two conversations; a compare opening while a chat closes waits, never deadlocks');
 }
 // 7. Compare: at least two models, bounds <= 500 credits; N columns; each column rounded on its own; a refused column costs
 // nothing; adoption appends the question and the chosen answer once; a conversation that moved on gets a quote.
 {
  const a=await account(),cp={question:'which?',questionHash:hash('which?'),requestHash:hash('r'),snapshotHash:hash('s')};
  assert.match(await refusal(open(a,{kind:'compare',pol:comparePolicy({gCredits:501,minCredits:501}),product:cp})),/TURN_COMPARE_LIMIT/);
  assert.match(await refusal(open(a,{kind:'compare',pol:comparePolicy({limits:{model:1,paidTools:0,freeTools:0,decisions:0}}),product:cp})),/TURN_POLICY_INVALID/);
  assert.equal(await one('select count(*)::int v from fusion_compares where actor_id=$1',[a.actor]),0,'a refused compare records nothing');
  const o=await open(a,{kind:'compare',pol:comparePolicy({limits:{model:3,paidTools:0,freeTools:0,decisions:0},gCredits:180,minCredits:180}),product:cp});
  for(const s of [1,2,3])await begin(a,o.turnId,s);
  // ceil(100 x 0.0011 x 6) = 1 per column: two delivered columns cost 2, where one rounding of the sum would be ceil(1.32) = 2;
  // with 0.0021: 2 + 2 = 4 against ceil(2.52) = 3.
  await record(a,o.turnId,1,{n:0.0021,output:{phase:'fusion_compare',body:'one',verdict:'usable'}});
  await record(a,o.turnId,2,{n:0.0021,output:{phase:'fusion_compare',body:'two',verdict:'usable'}});
  await record(a,o.turnId,3,{status:'unusable',actual:0.01});
  const closed=await close(a,o.turnId,'completed',{delivered:true});
  assert.equal(closed.chargedCredits,4,'each column is rounded on its own');
  assert.equal(await one('select state v from fusion_compares where id=$1',[o.compareId]),'finished');
  const adopted=await one('select fusion_compare_turn_adopt($1,$2,$3) v',[a.actor,o.compareId,2]);
  assert.equal(adopted.state,'adopted');
  assert.deepEqual((await c.query('select role,content from session_messages where session_id=$1 order by seq',[a.session])).rows,
   [{role:'user',content:'which?'},{role:'assistant',content:'two'}]);
  assert.equal((await one('select fusion_compare_turn_adopt($1,$2,$3) v',[a.actor,o.compareId,2])).replay,true);
  // The history a compare sizes on (read before the open): the owner's conversation only.
  const admit=(actor,deps=[])=>one('select fusion_compare_turn_admit($1,$2,10,$3) v',[actor,a.session,JSON.stringify(deps)]);
  assert.deepEqual((await admit(a.actor)).history.map(x=>x.content),['which?','two']);
  assert.deepEqual((await admit(randomUUID())).history,[]);
  assert.match(await refusal(one('select fusion_compare_turn_adopt($1,$2,$3) v',[a.actor,o.compareId,1])),/FUSION_COMPARE_ADOPTED/);
  assert.match(await refusal(one('select fusion_compare_turn_adopt($1,$2,$3) v',[a.actor,o.compareId,3])),/FUSION_COMPARE_ADOPTED|FUSION_COMPARE_INVALID/);
  const o2=await open(a,{kind:'compare',pol:comparePolicy(),product:cp});
  for(const s of [1,2]){await begin(a,o2.turnId,s);await record(a,o2.turnId,s,{n:0.001,output:{phase:'fusion_compare',body:'x'+s,verdict:'usable'}});}
  await close(a,o2.turnId,'completed',{delivered:true});
  await c.query(`insert into session_messages(session_id,seq,role,turn_id,content,content_hash) values($1,3,'user',$2,'later',$3)`,
   [a.session,o2.turnId,hash('later')]);
  assert.equal((await one('select fusion_compare_turn_adopt($1,$2,$3) v',[a.actor,o2.compareId,1])).state,'quoted',
   'the conversation moved on: the answer comes back as a quote, nothing recorded');
  assert.equal(await one('select count(*)::int v from session_messages where session_id=$1',[a.session]),3);
  // #1522 review: the compare deleted (a workspace source it read was deleted): its adopted copy leaves the history.
  await c.query('delete from fusion_compares where id=$1',[o.compareId]);
  assert.deepEqual((await c.query('select content,visible from session_messages where session_id=$1 and turn_id=$2 order by seq',
   [a.session,o.turnId])).rows,[{content:'',visible:false},{content:'',visible:false}]);
  assert.equal(await one('select content v from session_messages where session_id=$1 and seq=3',[a.session]),'later','other messages stay');
  report.checks.push('compare: >= 2 models and <= 500 credits or nothing is recorded; N columns each rounded on its own (4, not 3); a refused column is free; adoption appends question and answer once, replays, refuses another column; a moved-on conversation gets a quote');
 }
 // 8. The 3-unfinished version rule (10-20) and jury adoption (once per adopted review, no fee).
 {
  const a=await account();
  for(let i=0;i<3;i++)await review(a,{state:'incomplete'});
  assert.match(await refusal(open(a,{product:{reviewId:await review(a)}})),/TURN_JURY_VERSION_BLOCKED/);
  const fresh=await account(),done=await review(fresh,{state:'completed',outcome:{kind:'revised'},adoption:{state:'recorded',versionId:randomUUID()}});
  const adoptPolicy=juryPolicy({gCredits:0,minCredits:0,fixedCredits:0,limits:{model:1,paidTools:0,freeTools:0,decisions:0}});
  const notAdopted=await review(fresh,{state:'completed',outcome:{kind:'revised'}});
  assert.match(await refusal(open(fresh,{kind:'jury_adopt',pol:adoptPolicy,product:{reviewId:notAdopted}})),/TURN_PRODUCT_CONFLICT/);
  const ad=await open(fresh,{kind:'jury_adopt',pol:adoptPolicy,product:{reviewId:done}});
  assert.equal(ad.reservedCredits,0);
  await begin(fresh,ad.turnId,1);await record(fresh,ad.turnId,1,{n:0.2});
  assert.equal((await close(fresh,ad.turnId,'completed',{delivered:true})).chargedCredits,0,'re-finalizing an adopted review is free');
  assert.match(await refusal(open(fresh,{kind:'jury_adopt',pol:adoptPolicy,product:{reviewId:done}})),/TURN_JURY_ADOPT_USED/);
  assert.equal(await balance(fresh),3000);
  report.checks.push('three incomplete or failed reviews of one version block the next; jury_adopt only after a recorded adoption, once, at no charge');
 }
 // 9. 24 hours (Owner 10-27): a jury waiting 23 hours is kept; at 25 hours recovery ends it (known usage, at most the price;
 // the review interrupted); a second run changes nothing; a deleted review refunds its turn; a closed turn ends its record.
 {
  const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv}});
  await step(a,rv,{round:1,phase:'review',attempt:1},{state:'claim',fromSeq:1});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.05,output:seat()});
  await c.query("update turns set updated_at=now()-interval '23 hours' where id=$1",[o.turnId]);
  assert.equal((await one('select turn_fusion_recovery(50) v')).expired,0);
  await c.query("update turns set updated_at=now()-interval '25 hours' where id=$1",[o.turnId]);
  // #1522 review: a relay resuming a jury while recovery runs. Recovery waits on the turn, reads it again and keeps it running.
  {
   const r=await account(),rr=await review(r),orr=await open(r,{product:{reviewId:rr}});
   await begin(r,orr.turnId,1);await record(r,orr.turnId,1,{output:seat()});
   await c.query("update turns set updated_at=now()-interval '25 hours' where id=$1",[orr.turnId]);
   const p=await peer();
   try{
    await p.query('begin');
    await begin(r,orr.turnId,2,{client:p});
    const recovering=one('select turn_fusion_recovery(50) v');
    await new Promise(res=>setTimeout(res,300));
    await p.query('commit');
    await recovering;
   }finally{await p.end();}
   const kept=await turnRow(r,orr.turnId);
   assert.deepEqual([kept.state,kept.close_kind],['running',null],'a jury resumed meanwhile is not ended');
   assert.equal(await one('select state v from fusion_reviews where id=$1',[rr]),'running');
  }
  const run1=await one('select turn_fusion_recovery(50) v');
  assert.equal(run1.failed,0);
  const t=await turnRow(a,o.turnId);
  assert.deepEqual([t.state,t.close_kind,t.charged_credits],['closed','expired',30]);
  assert.equal(await one('select state v from fusion_reviews where id=$1',[rv]),'interrupted');
  const run2=await one('select turn_fusion_recovery(50) v');
  assert.equal((await turnRow(a,o.turnId)).charged_credits,30,'a second run changes nothing');
  assert.equal(run2.failed,0);
  assert.equal(await balance(a),3000-30);assert.equal(await ledger(a),3000-30);
  // Draft deleted while the review waits: its review row goes, the turn is refunded in full.
  const b=await account(),rb=await review(b),ob=await open(b,{product:{reviewId:rb}});
  await begin(b,ob.turnId,1);
  await c.query('delete from fusion_reviews where id=$1',[rb]);
  assert.equal((await record(b,ob.turnId,1,{n:0.05,output:seat()})).productGone,true,'a deleted review stores no answer');
  assert.equal(await one('select count(*)::int v from fusion_turn_outputs where turn_id=$1',[ob.turnId]),0);
  assert.ok((await one('select turn_fusion_recovery(50) v')).orphaned>=1);
  assert.deepEqual([(await turnRow(b,ob.turnId)).close_kind,(await turnRow(b,ob.turnId)).charged_credits],['failed',0]);
  assert.equal(await balance(b),3000);
  // #1522 review: the review ended by another path (archived business) while its turn waits: the turn closes by the review's
  // end before the 24-hour end could charge it; an incomplete review refunds everything.
  const e=await account(),re=await review(e),oe=await open(e,{product:{reviewId:re}});
  await begin(e,oe.turnId,1);await record(e,oe.turnId,1,{n:0.05,output:seat()});
  await c.query(`update fusion_reviews set state='incomplete',outcome='{"kind":"source_archived"}',ended_at=now() where id=$1`,[re]);
  await c.query("update turns set updated_at=now()-interval '25 hours' where id=$1",[oe.turnId]);
  await one('select turn_fusion_recovery(50) v');
  assert.deepEqual([(await turnRow(e,oe.turnId)).close_kind,(await turnRow(e,oe.turnId)).charged_credits],['failed',0]);
  assert.equal(await balance(e),3000);
  // Another path closed the turn (the crash sweep): the review record ends on the next run.
  const d=await account(),rd=await review(d),od=await open(d,{product:{reviewId:rd}});
  await one('select turn_close($1,$2,$3,$4,$5,$6,$7) v',[d.actor,od.turnId,'interrupted','[]',false,false,null]);
  await one('select turn_fusion_recovery(50) v');
  assert.equal(await one('select state v from fusion_reviews where id=$1',[rd]),'interrupted');
  report.checks.push('24 hours: kept at 23 h, ended at 25 h with min(fixed, known usage) = 30 and the review interrupted; second run idempotent; a deleted review stores no answer and its turn is refunded; a turn closed elsewhere ends its review');
 }
 // 10. Erasure follows the product rows: deleting a review or a compare deletes its saved answers.
 {
  const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv}});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{output:seat('secret')});
  await close(a,o.turnId,'completed',{product:{state:'completed',outcome:{kind:'no_change'}}});
  await c.query('delete from fusion_reviews where id=$1',[rv]);
  assert.equal(await one('select count(*)::int v from fusion_turn_outputs where turn_id=$1',[o.turnId]),0);
  assert.equal(await one('select count(*)::int v from turn_calls where turn_id=$1',[o.turnId]),1,'the billing record stays');
  // #1522 review: the raw provider responses go with the review too, and a receipt arriving after the deletion stores none.
  const b=await account(),rb=await review(b),ob=await open(b,{product:{reviewId:rb}});
  const rawRecord=(seq)=>one('select turn_fusion_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v',[b.actor,ob.turnId,seq,'ok',0.01,0.01,'{}',null,
   hash('raw'+seq),'{"choices":[{"message":{"content":"secret"}}]}',JSON.stringify(seat('secret'))]);
  await begin(b,ob.turnId,1);await begin(b,ob.turnId,2);
  await rawRecord(1);
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[ob.turnId]),1);
  await c.query('delete from fusion_reviews where id=$1',[rb]);
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[ob.turnId]),0,'deleted with the review');
  assert.equal((await rawRecord(2)).productGone,true);
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[ob.turnId]),0,'a late receipt stores no raw response');
  assert.equal(await one("select count(*)::int v from turn_calls where turn_id=$1 and status='ok'",[ob.turnId]),2,'both receipts recorded');
  report.checks.push('deleting a review (draft deletion, account erasure) deletes its saved answers and its raw provider responses; a late receipt keeps billing only; the billing records stay');
 }
 // 12. #1522 review: the 7-day breaker counts the turn path's platform-borne cost (the read before the open returns it, the
 // service compares it with the settings); a compare's workspace sources are frozen with its record (content deletion finds it
 // by them) and a revoked source is refused by the read before the open.
 {
  const a=await account(),cp={question:'q',questionHash:hash('q'),requestHash:hash('r'),snapshotHash:hash('s')};
  const admit=(deps=[])=>one('select fusion_compare_turn_admit($1,$2,10,$3) v',[a.actor,a.session,JSON.stringify(deps)]);
  assert.match(await refusal(admit([{sourceVersionId:randomUUID()}])),/FUSION_COMPARE_SOURCE_REVOKED/);
  assert.match(await refusal(admit([{sourceVersionId:'x'}])),/TURN_POLICY_INVALID/);
  assert.equal((await admit()).positioned,false,'no confirmed positioning');
  assert.match(await refusal(open(a,{kind:'compare',pol:comparePolicy(),product:{...cp,workspaceDependencies:[{sourceVersionId:'x'}]}})),
   /TURN_POLICY_INVALID/);
  const o=await open(a,{kind:'compare',pol:comparePolicy(),product:{...cp,workspaceDependencies:[]}});
  assert.deepEqual(await one('select workspace_dependencies v from fusion_compares where id=$1',[o.compareId]),[]);
  // Both columns cost 1.5 USD and nothing was delivered: refunded, the platform bears 3 USD (>= the 2 USD default line).
  for(const s of [1,2]){await begin(a,o.turnId,s);await record(a,o.turnId,s,{status:'unusable',actual:1.5});}
  await close(a,o.turnId,'failed',{refundAll:true,failure:'compare_no_answer'});
  const usage=await one('select fusion_review_breaker_usage($1) v',[a.actor]);
  assert.ok(Number(usage.platformUsd)>=3,JSON.stringify(usage));
  assert.ok(Number((await admit()).breaker.platformUsd)>=3,'the read before the open returns the statistic');
  // A refunded jury counts too (no change: everything refunded, the seats' cost borne by the platform).
  const j=await account(),rv=await review(j),t=(await open(j,{product:{reviewId:rv}})).turnId;
  await begin(j,t,1);await record(j,t,1,{n:0.5,actual:0.5,output:seat()});
  await close(j,t,'completed',{product:{state:'completed',outcome:{kind:'no_change'}}});
  assert.ok(Number((await one('select fusion_review_breaker_usage($1) v',[j.actor])).platformUsd)>=0.5);
  report.checks.push('breaker: refunded compare and jury turns count as platform-borne, returned by the read before the open; a compare freezes its workspace sources; a revoked or malformed source is refused before the open, a malformed one by the open too');
 }
 // 13. #1522 review: a complete answer whose cost is not final yet is kept (turn_fusion_output) while the call stays open.
 {
  const a=await account(),rv=await review(a),o=await open(a,{product:{reviewId:rv}});
  await begin(a,o.turnId,1);await one('select turn_call_identity($1,$2,$3,$4) v',[a.actor,o.turnId,1,'gen-pending']);
  const saved=await one('select turn_fusion_output($1,$2,$3,$4) v',[a.actor,o.turnId,1,JSON.stringify(seat('kept'))]);
  assert.equal(saved.productGone,false);
  assert.deepEqual((await c.query('select o.body,c.status from fusion_turn_outputs o join turn_calls c using(turn_id,seq) where o.turn_id=$1',[o.turnId])).rows,
   [{body:'kept',status:'identified'}]);
  await one('select turn_fusion_output($1,$2,$3,$4) v',[a.actor,o.turnId,1,JSON.stringify(seat('kept'))]);
  assert.match(await refusal(one('select turn_fusion_output($1,$2,$3,$4) v',[a.actor,o.turnId,1,JSON.stringify(seat('other'))])),/TURN_CALL_CONFLICT/);
  await begin(a,o.turnId,2);await record(a,o.turnId,2,{output:seat('done')});
  assert.match(await refusal(one('select turn_fusion_output($1,$2,$3,$4) v',[a.actor,o.turnId,2,JSON.stringify(seat('x'))])),/TURN_CALL_DENIED/,
   'a call with its final receipt keeps the answer of its receipt');
  // #1522 review: a deliverable revision saved before its cost was final still pays the fixed price once settled.
  const d=await account(),rd=await review(d),od=await open(d,{product:{reviewId:rd}});
  await begin(d,od.turnId,1);await one('select turn_call_identity($1,$2,$3,$4) v',[d.actor,od.turnId,1,'gen-summary']);
  await one('select turn_fusion_output($1,$2,$3,$4) v',[d.actor,od.turnId,1,
   JSON.stringify({phase:'fusion_summary',body:'revised',verdict:'usable',deliverable:true})]);
  const pending=await close(d,od.turnId,'completed',{delivered:true,product:{state:'completed',outcome:{kind:'revised'}}});
  assert.deepEqual([pending.settlement,pending.chargedCredits],['pending',null],'the cost is not known yet');
  // The receipt arrives later (no deliverable mark in its usage): the settlement still charges the price.
  await one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[d.actor,od.turnId,1,'ok',0.05,0.05,'{}',null,hash('late'),null]);
  assert.equal((await close(d,od.turnId,'completed')).chargedCredits,FIXED);
  report.checks.push('a complete answer whose cost is not final is saved and judged while its call stays open; repeat is a no-op, a different body conflicts, a settled call refuses; a deliverable revision saved so still pays the fixed price');
 }
 // 11. Only the service role calls the new functions; clients cannot read the saved answers.
 {
  for(const f of ['turn_fusion_open','turn_fusion_begin','turn_fusion_record','turn_fusion_close','fusion_review_turn_step',
   'fusion_compare_turn_adopt','fusion_compare_turn_admit','fusion_review_turn_source','turn_fusion_recovery','turn_fusion_ended_review',
   'turn_fusion_output']){
   for(const role of ['anon','authenticated'])
    assert.equal(await one(`select bool_or(has_function_privilege($1,p.oid,'execute')) v from pg_proc p where proname=$2`,[role,f]),false,f+' '+role);
   assert.equal(await one(`select bool_or(has_function_privilege('service_role',p.oid,'execute')) v from pg_proc p where proname=$1`,[f]),true,f);
  }
  for(const role of ['anon','authenticated','service_role'])
   assert.equal(await one(`select has_table_privilege($1,'public.fusion_turn_outputs','select') v`,[role]),false);
  report.checks.push('the eleven functions are service role only; no client role reads fusion_turn_outputs');
 }
 console.log(JSON.stringify(report,null,1));
}finally{await db.close();}
