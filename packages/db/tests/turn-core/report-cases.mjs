/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-7a (kind=report): admission inside turn_open, the fixed price, duplicate and concurrent starts, failures that
// pay nothing, the user's stop (turn_stop: first two in 24 hours free, then confirmed and charged what was generated, at most the
// fixed price; what the user saw is what is kept), the hidden report text and turn_report_read.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function reportCases(t){
 const {c,one,open,begin,identity,record,close,balance,account,reportSource,reportPolicy,openReport,refusal,peer,report}=t;
 const stop=(a,turn,{confirmed=false,stopAt=null,client=c}={})=>
  client.query('select turn_stop($1,$2,$3,$4) v',[a.actor,turn,confirmed,stopAt]).then(r=>r.rows[0].v);
 const read=(a,src,turn=null)=>one('select turn_report_read($1,$2,$3,$4) v',[a.actor,src.session,src.round,turn]);
 const reply=text=>[{role:'assistant',content:text}];
 const body='## One\nFirst part of the report.\n## Two\nSecond part.';
 // 1. Admission: everything is checked inside turn_open, under the open's locks, and a refusal freezes nothing.
 {
  const a=await account(1000),src=await reportSource(a);
  const refused=async(pol,pattern,extra={})=>{
   assert.match(await refusal(open(a,{kind:'report',session:src.session,pol,...extra})),pattern);
   assert.equal(await balance(a),1000,'a refused report freezes nothing');
  };
  await refused(reportPolicy(src,{fixedCredits:400,gCredits:430,minCredits:430}),/REPORT_PRICE_CHANGED/);
  await refused(reportPolicy(src,{minCredits:500}),/TURN_POLICY_INVALID/);
  await refused(reportPolicy(src,{gCredits:480,minCredits:480}),/TURN_POLICY_INVALID/);
  await refused(reportPolicy(src,{limits:{model:2,paidTools:0,freeTools:1}}),/TURN_POLICY_INVALID/);
  await refused(reportPolicy(src,{historyItems:4}),/TURN_POLICY_INVALID/);
  await refused(reportPolicy(src,{report:{projectId:src.project,roundId:src.round,moduleId:randomUUID()}}),/REPORT_SOURCE_CONFLICT/);
  const {report:_r,...plain}=reportPolicy(src);
  await refused(plain,/TURN_POLICY_INVALID/);
  assert.match(await refusal(open(a,{pol:reportPolicy(src)})),/TURN_POLICY_INVALID/,'only a report carries a report');
  await c.query("update profiles set membership_level='free' where id=$1",[a.actor]);
  await refused(reportPolicy(src),/REPORT_MEMBERSHIP_REQUIRED/);
  await c.query("update profiles set membership_level='gold' where id=$1",[a.actor]);
  await c.query("update artifact_rounds set steps=jsonb_set(steps,'{s,valid}','false') where id=$1",[src.round]);
  await refused(reportPolicy(src),/REPORT_CONFIRMATION_REQUIRED/);
  await c.query("update artifact_rounds set steps=jsonb_set(steps,'{s,valid}','true') where id=$1",[src.round]);
  await c.query('update research_benchmarks set qualified=false where session_id=$1',[src.session]);
  await refused(reportPolicy(src),/REPORT_BENCHMARKS_REQUIRED/);
  await c.query('update research_benchmarks set qualified=true where session_id=$1',[src.session]);
  await c.query("update system_settings set value='{\"enabled\":false}' where key='runtime_report_generation'");
  await refused(reportPolicy(src),/REPORT_DISABLED/);
  await c.query("update system_settings set value='{\"enabled\":true}' where key='runtime_report_generation'");
  const poor=await account(520),poorSrc=await reportSource(poor);
  assert.match(await refusal(openReport(poor,poorSrc)),/TURN_INSUFFICIENT_CREDITS/);
  assert.equal(await balance(poor),520,'the fixed price and the call bound must both be covered, or nothing is frozen');
  // Admitted: the whole 500 + the call bound is frozen; the frozen identity, the source and the benchmark table come back.
  const o=await openReport(a,src);
  assert.deepEqual([o.reservedCredits,o.history,await balance(a)],[530,[],470]);
  assert.equal(o.report.frozen.roundId,src.round);assert.equal(o.report.frozen.moduleId,src.module);
  assert.match(o.report.frozen.snapshotHash,/^[0-9a-f]{64}$/);
  assert.deepEqual(o.report.frozen.sections,['One','Two']);
  assert.equal(o.report.benchmarks.rows.length,3);
  assert.equal(o.report.source.snapshot.steps.s.body,'CONFIRMED_FACTS');
  const policy=await one('select policy v from turns where id=$1',[o.turnId]);
  assert.deepEqual([policy.bucket,policy.fixedCredits,policy.report.snapshotHash],[-1,500,o.report.frozen.snapshotHash],
   'a report reserves the large-kind stop-loss row and freezes its identity');
  await close(a,o.turnId,'failed',{messages:[],delivered:false});
  assert.equal(await balance(a),1000);
  report.checks.push('report admission in turn_open: switch, today\'s price, one-call shape, the round\'s module, membership, confirmed facts, benchmarks, fixed price + call bound all frozen or nothing; returns identity, source and benchmarks');
 }
 // 2. A complete report pays the fixed price once; its text is the turn's, hidden from the conversation history; a second paid
 // start of the round is refused while it stands. Duplicate submits (same request, a double click) and two at once freeze once.
 {
  const a=await account(1000),src=await reportSource(a),request=randomUUID();
  const o=await openReport(a,src,{request});
  assert.equal((await openReport(a,src,{request})).replay,true,'the same request is the same turn');
  assert.match(await refusal(openReport(a,src)),/TURN_SESSION_BUSY/,'a double click while it runs opens nothing');
  assert.equal(await balance(a),470,'frozen once');
  await begin(a,o.turnId,1,{upper:0.05});await record(a,o.turnId,1,{n:0.03});
  const closed=await close(a,o.turnId,'completed',{messages:reply(body),delivered:true});
  assert.deepEqual([closed.closeKind,closed.chargedCredits,closed.absorbedCredits],['completed',500,0]);
  assert.equal(await balance(a),500);
  assert.deepEqual((await c.query('select role,visible,content from session_messages where turn_id=$1',[o.turnId])).rows,
   [{role:'assistant',visible:false,content:body}]);
  const next=await read(a,src);
  assert.deepEqual([next.turnId,next.closeKind,next.delivered,next.chargedCredits,next.body],[o.turnId,'completed',true,500,body]);
  assert.match(await refusal(openReport(a,src)),/REPORT_ALREADY_EXISTS/,'one paid report per round');
  assert.equal(await balance(a),500);
  // Two starts at once on another round: one opens, the other is refused; one freeze.
  const b=await account(1000),srcB=await reportSource(b),p1=await peer(),p2=await peer();
  try{
   const both=await Promise.allSettled([openReport(b,srcB,{client:p1}),openReport(b,srcB,{client:p2})]);
   assert.deepEqual(both.map(r=>r.status).sort(),['fulfilled','rejected']);
   assert.match(String(both.find(r=>r.status==='rejected').reason),/TURN_SESSION_BUSY/);
   assert.equal(await balance(b),470);
  }finally{await p1.end();await p2.end();}
  report.checks.push('a complete report pays 500 once, its text is stored hidden from history and read back; same request replays, a double click and two concurrent starts freeze once; a standing report blocks a second paid start');
 }
 // 3. Nothing delivered pays nothing (Owner 10-17): cut off, failed, interrupted, deleted; settled now even with an unknown cost.
 {
  const a=await account(1000);
  const cut=await reportSource(a),o1=await openReport(a,cut);
  await begin(a,o1.turnId,1,{upper:0.05});await record(a,o1.turnId,1,{n:0.04});
  const c1=await close(a,o1.turnId,'completed',{messages:reply('## One\nCut'),delivered:false});
  assert.deepEqual([c1.chargedCredits,c1.absorbedCredits,await balance(a)],[0,24,1000],'a cut-off report pays nothing; Graylum absorbs it');
  assert.equal((await read(a,cut)).body,'## One\nCut','the cut-off text is kept to read');
  const o2=await openReport(a,cut);
  assert.equal(o2.replay,false,'a cut-off report does not block a new start, which pays again');
  await begin(a,o2.turnId,1,{upper:0.05});await identity(a,o2.turnId,1,'gen-report-unknown');
  const c2=await close(a,o2.turnId,'interrupted',{messages:[],delivered:false});
  assert.deepEqual([c2.chargedCredits,c2.settlement,await balance(a)],[0,'pending',1000],
   'an interrupted report settles the user now; only its provider cost waits for recovery');
  const gone=await reportSource(a),o3=await openReport(a,gone);
  await begin(a,o3.turnId,1,{upper:0.05});await record(a,o3.turnId,1,{n:0.04});
  await c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[gone.session]);
  const c3=await close(a,o3.turnId,'completed',{messages:reply(body),delivered:true});
  assert.deepEqual([c3.closeKind,c3.chargedCredits,await balance(a)],['erased',0,1000],'deleted while generating: nothing kept, nothing paid');
  report.checks.push('a cut-off, failed, interrupted (unknown cost) or deleted report pays nothing and settles the user at once');
 }
 // 4. Stops (Owner 10-27/10-28): only reports; first two in 24 hours free; the third asks, then charges what was generated (at
 // most 500), frozen at the stop; what the user saw is kept; repeated presses change nothing.
 {
  const a=await account(3000),chat=await open(a);
  assert.match(await refusal(stop(a,chat.turnId)),/TURN_STOP_NOT_ALLOWED/,'a chat has no stop');
  await close(a,chat.turnId,'completed',{messages:[]});
  // Stop 1: the reply finished before the stop reached the turn: still the stopped report, cut to what was shown.
  const s1=await reportSource(a),o1=await openReport(a,s1);
  await begin(a,o1.turnId,1,{upper:0.5});await record(a,o1.turnId,1,{n:0.2});
  const st1=await stop(a,o1.turnId,{stopAt:7});
  assert.deepEqual([st1.state,st1.chargeable,st1.replay],['stopping',false,false]);
  assert.deepEqual([(await stop(a,o1.turnId,{stopAt:99})).replay,(await stop(a,o1.turnId)).state],[true,'stopping'],'pressed again: unchanged');
  assert.match(await refusal(begin(a,o1.turnId,2,{upper:0.5})),/TURN_NOT_RUNNING|TURN_CALL_LIMIT/);
  const c1=await close(a,o1.turnId,'completed',{messages:reply(body),delivered:true});
  assert.deepEqual([c1.closeKind,c1.chargedCredits],['stopped',0]);
  assert.equal((await read(a,s1)).body,body.slice(0,7),'kept what the user saw');
  assert.equal((await read(a,s1)).delivered,false,'a stopped report is never a complete one');
  assert.equal(await balance(a),3000);
  // Stop 2: aborted stream, cost unknown: free, settled now.
  const s2=await reportSource(a),o2=await openReport(a,s2);
  await begin(a,o2.turnId,1,{upper:0.5});await identity(a,o2.turnId,1,'gen-stop-2');
  assert.equal((await stop(a,o2.turnId)).chargeable,false);
  const c2=await close(a,o2.turnId,'stopped',{messages:reply('## One'),delivered:false});
  assert.deepEqual([c2.closeKind,c2.chargedCredits,c2.settlement,await balance(a)],['stopped',0,'pending',3000]);
  // Stop 3: asks first; nothing changes until confirmed; then charged what was generated, at most the fixed price.
  const s3=await reportSource(a),o3=await openReport(a,s3);
  await begin(a,o3.turnId,1,{upper:0.5});await identity(a,o3.turnId,1,'gen-stop-3');
  const ask=await stop(a,o3.turnId,{stopAt:5});
  assert.deepEqual([ask.state,ask.chargeable,ask.fixedCredits],['confirmation_required',true,500]);
  assert.equal(await one('select state v from turns where id=$1',[o3.turnId]),'running','declined: it keeps generating');
  const st3=await stop(a,o3.turnId,{confirmed:true,stopAt:5});
  assert.deepEqual([st3.state,st3.chargeable],['stopping',true]);
  // The aborted stream: its cost is unknown, so this charge waits for recovery's receipt, then is what was generated.
  const c3=await close(a,o3.turnId,'interrupted',{messages:reply('## One\nPartial'),delivered:false});
  assert.deepEqual([c3.closeKind,c3.chargedCredits,c3.settlement],['stopped',null,'pending']);
  assert.equal(await balance(a),2470,'the freeze waits for the cost');
  await record(a,o3.turnId,1,{n:0.2});
  const late=await close(a,o3.turnId,'interrupted');
  assert.deepEqual([late.closeKind,late.chargedCredits,late.settlement],['stopped',120,'done']);
  assert.equal(await balance(a),2880);
  assert.equal((await read(a,s3)).body,'## On','cut to the 5 characters the user saw');
  // A fourth, generated past the price: at most 500.
  const s4=await reportSource(a),o4=await openReport(a,s4);
  await begin(a,o4.turnId,1,{upper:0.8});await record(a,o4.turnId,1,{n:0.9});
  assert.equal((await stop(a,o4.turnId,{confirmed:true})).chargeable,true);
  assert.equal((await close(a,o4.turnId,'completed',{messages:reply(body),delivered:true})).chargedCredits,500);
  // A stop after the report closed tells what happened.
  const after=await stop(a,o4.turnId);
  assert.deepEqual([after.state,after.closeKind,after.chargedCredits,after.replay],['closed','stopped',500,true]);
  report.checks.push('stop: reports only; 1st and 2nd in 24 hours free (settled at once even with unknown cost); 3rd asks, then charges what was generated (120), at most 500; repeated presses unchanged; text cut to what was shown');
 }
 // 5. Two stops at once in two sessions, one free stop left: exactly one is free (the account row serializes them); the told
 // decision is what each close charges.
 {
  const a=await account(3000),p1=await peer(),p2=await peer();
  try{
   const s0=await reportSource(a),o0=await openReport(a,s0);
   await begin(a,o0.turnId,1,{upper:0.5});await record(a,o0.turnId,1,{n:0.2});
   await stop(a,o0.turnId);await close(a,o0.turnId,'completed',{messages:reply(body),delivered:true});
   const sx=await reportSource(a),sy=await reportSource(a),x=await openReport(a,sx),y=await openReport(a,sy);
   for(const o of [x,y]){await begin(a,o.turnId,1,{upper:0.5});await record(a,o.turnId,1,{n:0.2});}
   const told=await Promise.all([stop(a,x.turnId,{client:p1,confirmed:true}),stop(a,y.turnId,{client:p2,confirmed:true})]);
   assert.deepEqual(told.map(v=>v.chargeable).sort(),[false,true]);
   const charged=[await close(a,x.turnId,'completed',{messages:reply(body),delivered:true}),
    await close(a,y.turnId,'completed',{messages:reply(body),delivered:true})].map(v=>v.chargedCredits);
   assert.deepEqual(charged,told.map(v=>v.chargeable?120:0),'each close charges what its stop said');
  }finally{await p1.end();await p2.end();}
  report.checks.push('two stops at once with one free stop left: exactly one free, and each close charges what its stop told the user');
 }
}
