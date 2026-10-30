/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-7b: the jury and compare functions lock only what the main path may lock (ENGINEERING 5: the own profile, the
// own conversation, the turn row). Review and compare rows are written on the owner key and only while still in the state read;
// these scenarios run them against the paths that change those rows concurrently.
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
const settle=promise=>promise.then(v=>({v}),e=>({e:e.message,code:e.code}));
const pause=()=>new Promise(r=>setTimeout(r,300));
const FIXED=1500,stopLoss={limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5};
const juryPolicy={q:100,uTurnUsd:0.7,gCredits:FIXED+180,minCredits:FIXED+180,fixedCredits:FIXED,uModelCredits:60,historyItems:0,
 inputBytes:1000,limits:{model:7,paidTools:0,freeTools:0,decisions:0},stopLoss};
try{
 await c.query(`insert into membership_plans(id,name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes)
  values($1,'Gold fixture','gold',true,true,500000000) on conflict(level) do update set allow_fusion_review=true,allow_fusion_compare=true`,
  [randomUUID()]);
 async function account(credits=3000){
  const actor=randomUUID(),session=randomUUID();
  await c.query("insert into profiles(id,credits,membership_level) values($1,$2,'gold')",[actor,credits]);
  await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
   values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
  const id=randomUUID();
  await c.query(`insert into fusion_reviews(id,actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
   materials,materials_hash,config,state,round,phase,attempt) values($1,$2,$3,$4,$5,$6,$7,'h','{}',$8,
   '{"maxRounds":2,"path":"turn"}','running',1,'review',1)`,[id,actor,randomUUID(),randomUUID(),randomUUID(),session,randomUUID(),hash('m')]);
  return {actor,session,review:id};
 }
 const open=(a,client=c)=>one('select turn_fusion_open($1,$2,$3,$4,$5,$6) v',
  [a.actor,a.session,randomUUID(),'jury',JSON.stringify(juryPolicy),JSON.stringify({reviewId:a.review})],client);
 const begin=(a,turn,seq)=>one('select turn_fusion_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
  [a.actor,turn,seq,'model',randomUUID(),null,null,hash('r'+turn+seq),0.1,6]);
 const record=(a,turn,seq,client=c)=>one('select turn_fusion_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) v',[a.actor,turn,seq,'ok',0.05,0.05,
  '{}',null,hash('p'+turn+seq),'raw body',JSON.stringify({phase:'fusion_review',body:'opinion',verdict:'usable'})],client);
 const reviewState=a=>one('select state v from fusion_reviews where id=$1',[a.review]);

 // 1. A chat closing in the draft conversation (turn_close: account, then conversation) while a jury opens on it: the jury takes
 // the account first too, so it waits instead of deadlocking.
 {
  const a=await account(),closer=await peer(),opener=await peer();
  try{
   await closer.query('begin');
   await closer.query('select 1 from profiles where id=$1 for update',[a.actor]);
   const opening=settle(open(a,opener));
   await pause();
   await closer.query("set local lock_timeout='3s'");
   await closer.query('select 1 from runtime_sessions where id=$1 for update',[a.session]);
   await closer.query('commit');
   assert.ok((await opening).v?.turnId,'the jury opens after the close');
  }finally{await closer.end();await opener.end();}
  report.checks.push('a jury opening while a chat closes in its draft conversation waits (account, then conversation), never deadlocks');
 }
 // 2. Another path ends the review (an archived business: incomplete) while the jury opens: the open read it running, its
 // write finds it ended and refuses; nothing is frozen and the other path's end stays.
 {
  const a=await account(),ender=await peer();
  try{
   await ender.query('begin');
   await ender.query("update fusion_reviews set state='incomplete',ended_at=now() where id=$1",[a.review]);
   const opening=settle(open(a));
   await pause();
   await ender.query('commit');
   assert.match((await opening).e??'',/TURN_PRODUCT_CONFLICT/);
  }finally{await ender.end();}
  assert.equal(await reviewState(a),'incomplete');
  assert.equal(await one('select count(*)::int v from turns where actor_id=$1',[a.actor]),0,'the refused open leaves no turn');
  assert.equal(await one('select credits v from profiles where id=$1',[a.actor]),3000,'nothing frozen');
  report.checks.push('a review ended by another path while its jury opens: the open is a conflict, rolled back, the other end kept');
 }
 // 3. The same while the jury closes: the close settles its turn, and the review keeps the other path's end.
 {
  const a=await account(),o=await open(a),ender=await peer();
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  try{
   await ender.query('begin');
   await ender.query("update fusion_reviews set state='incomplete',ended_at=now() where id=$1",[a.review]);
   const closing=settle(one('select turn_fusion_close($1,$2,$3,$4,$5,$6,$7) v',[a.actor,o.turnId,'completed',true,false,null,
    JSON.stringify({state:'completed',outcome:{kind:'revised'}})]));
   await pause();
   await ender.query('commit');
   const closed=await closing;
   assert.ok(closed.v && !closed.e,'the turn closes: '+JSON.stringify(closed));
   assert.equal(closed.v.chargedCredits,0,'that end settles the turn: the price is not charged');
  }finally{await ender.end();}
  assert.equal(await reviewState(a),'incomplete','the other path\'s end is not overwritten');
  assert.equal(await one('select credits v from profiles where id=$1',[a.actor]),3000,'everything refunded');
  report.checks.push('a review ended by another path while its jury closes: the close is undone and that end settles the turn, refunded');
 }
 // 3b. Ended by another path before the close starts: the close settles by that end (incomplete refunds), whatever the caller holds.
 {
  const a=await account(),o=await open(a);
  await begin(a,o.turnId,1);
  await record(a,o.turnId,1);
  await c.query("update fusion_reviews set state='incomplete',outcome='{\"kind\":\"source_archived\"}',ended_at=now() where id=$1",[a.review]);
  const closed=await one('select turn_fusion_close($1,$2,$3,$4,$5,$6,$7) v',[a.actor,o.turnId,'completed',true,false,null,
   JSON.stringify({state:'completed',outcome:{kind:'revised'}})]);
  assert.equal(closed.chargedCredits,0,'no fixed price for a review ended elsewhere');
  assert.equal(await reviewState(a),'incomplete');
  assert.equal(await one('select credits v from profiles where id=$1',[a.actor]),3000);
  report.checks.push('a review ended by another path before its close: the close settles by that end, the fixed price is not charged');
 }
 // 3c. The general recovery job closes a jury whose review another path ended unfinished, before fusion-recovery does: refunded.
 for(const action of ['interrupt','expire']){
  const a=await account(),o=await open(a);
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  if(action==='interrupt')await c.query("update turns set state='running',pause_reason=null where id=$1",[o.turnId]);
  await c.query("update fusion_reviews set state='incomplete',ended_at=now() where id=$1",[a.review]);
  await c.query("update turns set updated_at=now()-interval '25 hours' where id=$1",[o.turnId]);
  const done=await one('select turn_recover($1,$2,$3) v',[a.actor,o.turnId,action]);
  assert.equal(done.chargedCredits,0,action+': '+JSON.stringify(done));
  assert.equal(await one('select credits v from profiles where id=$1',[a.actor]),3000,action);
 }
 report.checks.push('turn_recover before fusion-recovery on a review ended unfinished: interrupted or expired, it refunds everything');
 // 4. A deletion of the review (content_erasure_confirm locks the conversations first, NOWAIT) and a receipt: while the receipt
 // holds the conversation the deletion fails fast; a deletion that holds it first makes the receipt wait and see the review
 // gone (the receipt is kept, the answer and the raw body are not).
 {
  const a=await account(),o=await open(a);
  await begin(a,o.turnId,1);await begin(a,o.turnId,2);
  const writer=await peer(),eraser=await peer();
  try{
   await writer.query('begin');
   await record(a,o.turnId,1,writer);
   await eraser.query('begin');
   const nowait=await settle(eraser.query('select 1 from runtime_sessions where id=$1 and actor_id=$2 for update nowait',[a.session,a.actor]));
   assert.equal(nowait.code,'55P03','the erasure fails fast while a receipt is written');
   await eraser.query('rollback');
   await writer.query('commit');
   await eraser.query('begin');
   await eraser.query('select 1 from runtime_sessions where id=$1 and actor_id=$2 for update nowait',[a.session,a.actor]);
   await eraser.query('delete from fusion_reviews where id=$1',[a.review]);
   const recording=settle(record(a,o.turnId,2,writer));
   await pause();
   await eraser.query('commit');
   assert.equal((await recording).v?.productGone,true);
  }finally{await writer.end();await eraser.end();}
  assert.equal(await one('select count(*)::int v from fusion_turn_outputs where turn_id=$1',[o.turnId]),0,'no answer left');
  assert.equal(await one('select count(*)::int v from turn_call_raw where turn_id=$1',[o.turnId]),0,'no raw body left');
  assert.equal(await one("select count(*)::int v from turn_calls where turn_id=$1 and status='ok'",[o.turnId]),2,'both receipts kept');
  report.checks.push('a review deletion and a receipt serialize on the conversation: the deletion fails fast during the receipt, a receipt after the deletion keeps billing only');
 }
 // 5. Two relays claim the same step at once: one claim, the other answers from the claimed state.
 {
  const a=await account();await open(a);
  const from={round:1,phase:'review',attempt:1},to={state:'claim',fromSeq:1};
  const q1=await peer(),q2=await peer();
  try{
   await q1.query('begin');
   await one('select fusion_review_turn_step($1,$2,$3,$4) v',[a.actor,a.review,JSON.stringify(from),JSON.stringify(to)],q1);
   const second=settle(one('select fusion_review_turn_step($1,$2,$3,$4) v',[a.actor,a.review,JSON.stringify(from),JSON.stringify(to)],q2));
   await pause();
   await q1.query('commit');
   assert.ok((await second).v,'the second claim answers: '+JSON.stringify(await second));
  }finally{await q1.end();await q2.end();}
  assert.equal(await one('select jsonb_array_length(steps) v from fusion_reviews where id=$1',[a.review]),1,'one claim');
  report.checks.push('two concurrent claims of one step make one claim; the second answers from it');
 }
 console.log(JSON.stringify(report,null,1));
}finally{await db.close();}
