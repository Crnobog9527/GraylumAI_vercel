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
 // A report's close: its text is the kind result (turn_report_apply), never a conversation message.
 // With it, the report identity Node builds from the source turn_open read (frozenReport), which the publish chain reads.
 const identityOf=async(a,turn)=>{
  const {session_id:session,policy}=(await c.query('select session_id,policy from turns where id=$1',[turn])).rows[0];
  const source=await one('select report_source($1,$2,$3,$4) v',[a.actor,session,policy.report.projectId,policy.report.roundId]);
  return {version:1,projectId:policy.report.projectId,roundId:policy.report.roundId,evidenceIds:[],snapshotHash:source.snapshotHash,
   packageHash:'b'.repeat(64),workflowHash:'c'.repeat(64),templateHash:'d'.repeat(64),sections:['One','Two'],maxCharacters:12000};
 };
 const closeReport=async(a,turn,kind,{text=null,delivered=false}={})=>
  one("select turn_close($1,$2,$3,'[]',$4,false,null,$5) v",[a.actor,turn,kind,delivered,
   text===null?null:JSON.stringify({body:text,reportGeneration:await identityOf(a,turn)})]);
 const body='## One\nFirst part of the report.\n## Two\nSecond part.';
 // 1. Admission: everything is checked inside turn_open, under the open's locks, and a refusal freezes nothing.
 {
  const a=await account(1000),src=await reportSource(a);
  const refused=async(pol,pattern,extra={},_why='')=>{
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
  await refused(reportPolicy(src,{stopChargeable:false}),/TURN_POLICY_INVALID/,{},'only turn_stop writes a stop decision');
  await c.query("update profiles set membership_level='free' where id=$1",[a.actor]);
  await refused(reportPolicy(src),/REPORT_MEMBERSHIP_REQUIRED/);
  await c.query("update profiles set membership_level='gold' where id=$1",[a.actor]);
  // The confirmed facts and the benchmark gate are read by Node before opening (B1); under turn_open's locks the round must be
  // this conversation's draft: another round of the same account is refused.
  // Membership (#1523 review): Node calls report_membership_check before opening, which reads the subscription's period end, not
  // only the cached level. A Gold-level account whose Stripe subscription ended is refused there; the active one passes.
  {
   const m=await account(1000);
   await c.query("update profiles set membership_level='gold' where id=$1",[m.actor]);
   const plan=await one("select id v from membership_plans where level='gold' limit 1")
    ??await one("insert into membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes) values('Report turn fixture','gold',true,true,1048576) returning id v");
   const sub=randomUUID(),external='turn-report-'+sub;
   await c.query(`insert into user_subscriptions(id,user_id,membership_plan_id,stripe_subscription_id,status,billing_cycle,current_period_end,
     payment_channel,merchant_namespace,payment_mode,contract_snapshot) values($1,$2,$3,$4,'active','monthly',now()+interval '1 month','stripe','turn-report','test',$5)`,
    [sub,m.actor,plan,external,JSON.stringify({version:1,item_type:'membership_plan',item_id:plan,item_updated_at:'2026-10-05T00:00:00Z',
     billing_cycle:'monthly',currency:'usd',unit:'major',price:'19.99',discount:'0.00',tax_behavior:'unspecified',credits:100,bonus_credits:0})]);
   await c.query(`insert into payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,subscription_id)
     values('stripe','turn-report','test','subscription',$1,$2)`,[external,sub]);
   const check=async()=>{await c.query('set role service_role');
    try{return await one('select report_membership_check($1)::text v',[m.actor]);}finally{await c.query('reset role');}};
   await check();
   await c.query("update user_subscriptions set current_period_end=now()-interval '1 second' where id=$1",[sub]);
   assert.match(await refusal(check()),/REPORT_MEMBERSHIP_REQUIRED/,'an ended subscription is refused although the cached level is gold');
  }
  // An archived business is read-only (0324): its draft's report does not open (nothing frozen); unarchived, it does.
  const business=await one("insert into opc_businesses(actor_id,name) values($1,'archived business') returning id v",[a.actor]);
  await c.query('insert into opc_draft_businesses(draft_id,business_id) values($1,$2)',[src.draft,business]);
  await c.query('update opc_businesses set archived_at=now() where id=$1',[business]);
  await refused(reportPolicy(src),/OPC_BUSINESS_ARCHIVED/);
  await c.query('update opc_businesses set archived_at=null where id=$1',[business]);
  const elsewhere=await reportSource(a);
  await refused(reportPolicy(src,{report:{projectId:elsewhere.project,roundId:elsewhere.round,moduleId:src.module}}),/REPORT_SOURCE_CONFLICT/);
  await c.query("update system_settings set value='{\"enabled\":false}' where key='runtime_report_generation'");
  await refused(reportPolicy(src),/REPORT_DISABLED/);
  await c.query("update system_settings set value='{\"enabled\":true}' where key='runtime_report_generation'");
  const poor=await account(520),poorSrc=await reportSource(poor);
  assert.match(await refusal(openReport(poor,poorSrc)),/TURN_INSUFFICIENT_CREDITS/);
  assert.equal(await balance(poor),520,'the fixed price and the call bound must both be covered, or nothing is frozen');
  // Admitted: the whole 500 + the call bound is frozen; nothing of the source comes back (Node read it before opening).
  const o=await openReport(a,src);
  assert.deepEqual([o.reservedCredits,o.history,await balance(a)],[530,[],470]);
  assert.equal(o.kindContext,null);
  const policy=await one('select policy v from turns where id=$1',[o.turnId]);
  assert.deepEqual([policy.bucket,policy.fixedCredits,policy.report.roundId],[-1,500,src.round],'a report reserves the large-kind stop-loss row');
  // Its result is only {body}; anything else is refused and changes nothing.
  const own=await identityOf(a,o.turnId);
  for(const bad of [{body:1},{body:'x'},{body:'x',reportGeneration:own,extra:1},['x'],
   {body:'x',reportGeneration:{...own,roundId:randomUUID()}},{body:'x',reportGeneration:{...own,sections:'One'}}])
   assert.match(await refusal(one("select turn_close($1,$2,'completed','[]',true,false,null,$3) v",[a.actor,o.turnId,JSON.stringify(bad)])),
    /TURN_KIND_RESULT_INVALID/);
  assert.equal(await one('select state v from turns where id=$1',[o.turnId]),'running');
  await close(a,o.turnId,'failed',{messages:[],delivered:false});
  assert.equal(await balance(a),1000);
  report.checks.push('report admission in turn_open: switch, today\'s price, one-call shape, the round is this conversation\'s and of the quoted module, membership, fixed price + call bound all frozen or nothing');
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
  const closed=await closeReport(a,o.turnId,'completed',{text:body,delivered:true});
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
  // The same round's report on the old path (#1523 review): one still going, charged, or complete and not settled yet blocks
  // a new start here, by report_fee_hold's rule; one refunded, or charged for a user stop, does not.
  {
   const legacy=async(state,{exec='running',settle=null,complete=false}={})=>{
    const o2=await account(2000),src2=await reportSource(o2),id=randomUUID();
    const hold=await one("select pre_deduct_id v from atomic_pre_deduct($1,500,'old report fixture',$2)",[o2.actor,randomUUID()]);
    await c.query(`insert into runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result)
      values($1,$2,$3,$4,$5,0,$6,$7)`,[id,o2.actor,src2.session,randomUUID(),
      JSON.stringify({reportGeneration:{projectId:src2.project,roundId:src2.round,sections:['One','Two'],maxCharacters:12000}}),exec,
      complete?JSON.stringify({body,completeness:'complete'}):null]);
    await c.query(`insert into report_fees(execution_id,actor_id,credits,pre_deduct_id,state,charged_credits,settle_reason,settled_at)
      values($1,$2,500,$3,$4,$5,$6,$7)`,[id,o2.actor,hold,state,state==='held'?null:state==='charged'?500:0,
      state==='held'?null:settle??'settled',state==='held'?null:new Date().toISOString()]);
    return openReport(o2,src2).then(()=>'opened',e=>e.message);
   };
   assert.match(await legacy('held'),/REPORT_ALREADY_EXISTS/,'an old-path report still going');
   assert.match(await legacy('held',{exec:'completed',complete:true}),/REPORT_ALREADY_EXISTS/,'complete, price not settled yet');
   assert.match(await legacy('charged',{exec:'completed'}),/REPORT_ALREADY_EXISTS/,'charged (a complete report)');
   assert.equal(await legacy('refunded',{exec:'completed'}),'opened','refunded: a new start pays again');
   assert.equal(await legacy('charged',{exec:'cancelled',settle:'user_stop'}),'opened','a charged stop is no report');
  }
  report.checks.push('a complete report pays 500 once, its text is stored hidden from history and read back; same request replays, a double click and two concurrent starts freeze once; a standing report blocks a second paid start, on either path (old-path held or charged blocks; refunded or a charged stop does not)');
 }
 // 3. Nothing delivered pays nothing (Owner 10-17): cut off, failed, interrupted, deleted; settled now even with an unknown cost.
 {
  const a=await account(1000);
  const cut=await reportSource(a),o1=await openReport(a,cut);
  await begin(a,o1.turnId,1,{upper:0.05});await record(a,o1.turnId,1,{n:0.04});
  const c1=await closeReport(a,o1.turnId,'completed',{text:'## One\nCut',delivered:false});
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
  const c3=await closeReport(a,o3.turnId,'completed',{text:body,delivered:true});
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
  const c1=await closeReport(a,o1.turnId,'completed',{text:body,delivered:true});
  assert.deepEqual([c1.closeKind,c1.chargedCredits],['stopped',0]);
  assert.equal((await read(a,s1)).body,body.slice(0,7),'kept what the user saw');
  assert.equal((await read(a,s1)).delivered,false,'a stopped report is never a complete one');
  assert.equal(await balance(a),3000);
  // Stop 2: aborted stream, cost unknown: free, settled now.
  const s2=await reportSource(a),o2=await openReport(a,s2);
  await begin(a,o2.turnId,1,{upper:0.5});await identity(a,o2.turnId,1,'gen-stop-2');
  assert.equal((await stop(a,o2.turnId)).chargeable,false);
  const c2=await closeReport(a,o2.turnId,'stopped',{text:'## One',delivered:false});
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
  const c3=await closeReport(a,o3.turnId,'interrupted',{text:'## One\nPartial',delivered:false});
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
  assert.equal((await closeReport(a,o4.turnId,'completed',{text:body,delivered:true})).chargedCredits,500);
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
   await stop(a,o0.turnId);await closeReport(a,o0.turnId,'completed',{text:body,delivered:true});
   const sx=await reportSource(a),sy=await reportSource(a),x=await openReport(a,sx),y=await openReport(a,sy);
   for(const o of [x,y]){await begin(a,o.turnId,1,{upper:0.5});await record(a,o.turnId,1,{n:0.2});}
   const told=await Promise.all([stop(a,x.turnId,{client:p1,confirmed:true}),stop(a,y.turnId,{client:p2,confirmed:true})]);
   assert.deepEqual(told.map(v=>v.chargeable).sort(),[false,true]);
   const charged=[await closeReport(a,x.turnId,'completed',{text:body,delivered:true}),
    await closeReport(a,y.turnId,'completed',{text:body,delivered:true})].map(v=>v.chargedCredits);
   assert.deepEqual(charged,told.map(v=>v.chargeable?120:0),'each close charges what its stop said');
  }finally{await p1.end();await p2.end();}
  report.checks.push('two stops at once with one free stop left: exactly one free, and each close charges what its stop told the user');
 }

 // 6. Plan 2.7/4.4 (#1523 review, controller A1): a report generated on the turn path is read and edited through the existing
 // report document chain, by its turn's request id; a stopped or cut-off one is readable but never a publish candidate. Publishing
 // it into artifact_versions (the evidence link in opc_result_links and the erasure rules) is V2-7a2. The old path's executions
 // are untouched (packages/db/tests/report-finalization).
 {
  const doc=(a,id,action,request=null,revision=null,body=null,hash=null)=>
   one('select report_document($1,$2,$3,$4,$5,$6,$7,null) v',[a.actor,id,action,request,revision,body,hash]);
  const a=await account(1000),src=await reportSource(a),request=randomUUID();
  const o=await openReport(a,src,{request});
  await begin(a,o.turnId,1,{upper:0.05});await record(a,o.turnId,1,{n:0.03});
  await closeReport(a,o.turnId,'completed',{text:body,delivered:true});
  const policy=await one('select policy v from turns where id=$1',[o.turnId]);
  assert.equal(policy.reportGeneration.roundId,src.round,'the report identity is frozen with the closed turn');
  const read=await doc(a,request,'read');
  assert.deepEqual([read.body,read.candidate,read.finalized,read.completeness,read.revision],[body,true,false,'complete',0]);
  const edited=body.replace('Second part.','Second part, edited.');
  const saved=await doc(a,request,'save',randomUUID(),0,edited);
  assert.deepEqual([saved.body,saved.revision,saved.manuallyEdited],[edited,1,true]);
  assert.equal((await doc(a,request,'read')).candidate,true,'still a publish candidate after the edit');
  // Someone else's request id, or a turn that is not a kept report, has nothing to open.
  assert.match(await refusal(doc(await account(),request,'read')),/REPORT_EXECUTION_REQUIRED/);
  // A stopped report: readable, not a candidate, so it cannot be published.
  const b=await account(1000),srcB=await reportSource(b),stopRequest=randomUUID();
  const s1=await openReport(b,srcB,{request:stopRequest});
  await begin(b,s1.turnId,1,{upper:0.05});await record(b,s1.turnId,1,{n:0.03});
  await stop(b,s1.turnId,{stopAt:9});
  await closeReport(b,s1.turnId,'completed',{text:body,delivered:true});
  const stoppedDoc=await doc(b,stopRequest,'read');
  assert.deepEqual([stoppedDoc.body,stoppedDoc.candidate,stoppedDoc.completeness],[body.slice(0,9),false,'stopped']);
  // A deleted conversation: the report can no longer be opened.
  await c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[srcB.session]);
  assert.match(await refusal(doc(b,stopRequest,'read')),/CONTENT_ERASED|REPORT_EXECUTION_REQUIRED/);
  report.checks.push('a turn-path report is read and edited by its request id (publishing is V2-7a2); a stopped one is readable, never a candidate; another account or a deleted conversation cannot open it');
 }
}
