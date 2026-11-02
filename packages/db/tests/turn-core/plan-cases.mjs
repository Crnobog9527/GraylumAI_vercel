/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-10b A (kind=plan): allowed and refused opens, the metered charge (no fixed price, no membership gate, a body that
// is no usable plan still pays by usage), duplicate and concurrent requests, failures, the hidden plan text and plan_turn_read.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';

export async function planCases(t){
 const {c,one,open,begin,identity,record,close,balance,account,reportSource,policy,refusal,peer,report}=t;
 const q=100,m=6,request=randomUUID;
 const published=async a=>{
  const src=await reportSource(a);
  await c.query("update artifact_rounds set state='published' where id=$1",[src.round]);
  await c.query("update artifact_projects set current_version=1 where id=$1",[src.project]);
  await c.query(`insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
   values($1,$2,$3,1,'{"body":"CONFIRMED"}',$4,'[]')`,[randomUUID(),src.project,src.round,'e'.repeat(64)]);
  return src;
 };
 const hash=text=>createHash('sha256').update(text).digest('hex');
 const planPolicy=(src,req,over={},plan={})=>policy({gCredits:30,minCredits:10,uModelCredits:30,historyItems:100,
  limits:{model:1,paidTools:0,freeTools:0},plan:{moduleId:src.module,stepId:'s',requestId:req,inputHash:hash('week'),sourceChecked:true,
   sourceDrafts:[],...plan},...over});
 const openPlan=(a,src,req=request(),{over={},plan={},client=c}={})=>
  open(a,{kind:'plan',session:src.session,request:req,pol:planPolicy(src,req,over,plan),client});
 const closePlan=(a,turn,kind,{body=null,round,delivered=kind==='completed',refundAll=false}={})=>
  one("select turn_close($1,$2,$3,'[]',$4,$5,null,$6) v",[a.actor,turn,kind,delivered,refundAll,
   body===null?null:JSON.stringify({body,roundId:round})]);
 const read=(a,src,req)=>one('select plan_turn_read($1,$2,$3) v',[a.actor,src.session,req]);
 const call=async(a,turn,seq=1)=>{await begin(a,turn,seq,{upper:0.05});await identity(a,turn,seq);await record(a,turn,seq,{n:0.01,actual:0.01});};
 const items='[{"id":"00000000-0000-4000-8000-000000000001","platform":"tiktok","account":"me","title":"T","brief":"B","day":"2026-11-02"}]';
 // 1. Refused: nothing is frozen, whatever the reason.
 {
  const a=await account(1000),src=await published(a);
  const refused=async(extra,pattern)=>{
   assert.match(await refusal(openPlan(a,src,request(),extra)),pattern);
   assert.equal(await balance(a),1000,'a refused plan freezes nothing');
   assert.equal(await one('select active_turn_id v from runtime_sessions where id=$1',[src.session]),null);
  };
  await refused({plan:{moduleId:randomUUID()}},/TURN_PLAN_DENIED/);
  await refused({plan:{stepId:'missing'}},/TURN_PLAN_STEP_DENIED/);
  await refused({plan:{sourceChecked:false}},/TURN_SOURCE_CHECK_REQUIRED/);
  await refused({over:{limits:{model:2,paidTools:0,freeTools:1}}},/TURN_POLICY_INVALID/);
  await refused({over:{fixedCredits:30}},/TURN_POLICY_INVALID/);
  await refused({over:{minCredits:2000}},/TURN_INSUFFICIENT_CREDITS/);
  const {plan:_p,...plain}=planPolicy(src,request());
  assert.match(await refusal(open(a,{kind:'plan',session:src.session,pol:plain})),/TURN_POLICY_INVALID/);
  // A conversation that is no draft of this account.
  const free=await account(1000);
  assert.match(await refusal(open(free,{kind:'plan',session:free.session,pol:planPolicy(src,request())})),/TURN_PLAN_DENIED/);
  // A revoked source behind the draft.
  const revoked=await one('select bill2_create_draft($1) v',[a.actor]);
  await c.query('update bill2_drafts set revoked=true where id=$1',[revoked]);
  await refused({plan:{sourceDrafts:[revoked]}},/TURN_PLAN_DENIED/);
  // A round not published yet: a plan is made from the published positioning only.
  const unpublished=await account(1000),draft=await reportSource(unpublished);
  assert.match(await refusal(openPlan(unpublished,draft)),/TURN_PLAN_STEP_DENIED/);
  assert.equal(await balance(unpublished),1000);
  // An archived business is read-only (0324); unarchived, the plan opens.
  const business=await one("insert into opc_businesses(actor_id,name) values($1,'archived business') returning id v",[a.actor]);
  await c.query('insert into opc_draft_businesses(draft_id,business_id) values($1,$2)',[src.draft,business]);
  await c.query('update opc_businesses set archived_at=now() where id=$1',[business]);
  await refused({},/OPC_BUSINESS_ARCHIVED/);
  await c.query('update opc_businesses set archived_at=null where id=$1',[business]);
  assert.equal(await balance(a),1000);
  const opened=await openPlan(a,src);
  assert.equal(opened.state,'running');
  report.checks.push('plan: every refusal (shape, module, step, unpublished round, source, archived business, old-path request) freezes nothing');
 }
 // 2. Allowed: metered, whatever the membership; the text is hidden from history and read by its request.
 {
  const a=await account(1000),src=await published(a);
  await c.query("update profiles set membership_level='free' where id=$1",[a.actor]);
  const req=request(),o=await openPlan(a,src,req);
  assert.equal(o.kindContext.roundId,src.round);
  assert.deepEqual(o.kindContext.resources,['report.md']);
  assert.equal(o.kindContext.work.steps.s.body,'CONFIRMED_FACTS');
  assert.equal(o.kindContext.work.steps.s.fieldMeta,undefined,'the model does not read the mentor bookkeeping');
  assert.equal(await balance(a),970,'H = min(G, available)');
  assert.equal((await read(a,src,req)).state,'running');
  await call(a,o.turnId);
  const closed=await closePlan(a,o.turnId,'completed',{body:items,round:src.round});
  const charged=Math.ceil(q*0.01*m);
  assert.equal(closed.chargedCredits,charged,'by usage: N = ceil(q x n x m), no fixed price');
  assert.equal(await balance(a),1000-charged);
  const saved=await read(a,src,req);
  assert.equal(saved.body,items);
  assert.equal(saved.sourceRoundId,src.round);
  assert.equal(saved.closeKind,'completed');
  assert.equal(await one('select count(*)::int v from session_messages where session_id=$1 and visible',[src.session]),0,'hidden from history');
  const next=await openPlan(a,src);
  assert.deepEqual(next.history,[]);
  await closePlan(a,next.turnId,'failed',{refundAll:true});
  report.checks.push('plan: charged by usage without a membership gate; its text is hidden and read by request');
 }
 // 3. A body that is no usable plan pays by usage like any answer (the old path, controller 11-01), and is kept to read as invalid.
 {
  const a=await account(1000),src=await published(a),req=request(),o=await openPlan(a,src,req);
  await call(a,o.turnId);
  const closed=await closePlan(a,o.turnId,'completed',{body:'sorry, not json',round:src.round});
  assert.equal(closed.chargedCredits,Math.ceil(q*0.01*m));
  assert.equal((await read(a,src,req)).body,'sorry, not json');
  report.checks.push('plan: a body that is no usable plan is charged by usage');
 }
 // 4. Duplicates: the same request is the same turn and one freeze; other input under it is refused.
 {
  const a=await account(1000),src=await published(a),req=request(),o=await openPlan(a,src,req);
  const again=await openPlan(a,src,req);
  assert.equal(again.replay,true);
  assert.equal(again.turnId,o.turnId);
  assert.equal(await balance(a),970,'one freeze');
  assert.match(await refusal(openPlan(a,src,req,{plan:{inputHash:hash('other')}})),/TURN_PLAN_REQUEST_CONFLICT/);
  await call(a,o.turnId);
  await closePlan(a,o.turnId,'completed',{body:items,round:src.round});
  const settled=await balance(a);
  const replay=await openPlan(a,src,req);
  assert.equal(replay.replay,true);
  assert.equal(await balance(a),settled,'a request after its close charges nothing more');
  assert.equal((await closePlan(a,o.turnId,'completed',{body:items,round:src.round})).replay,true);
  assert.equal(await balance(a),settled,'a second close charges nothing more');
  report.checks.push('plan: a repeated request is one turn and one charge; other input under it is refused');
 }
 // 5. Concurrent: two tabs with one request make one turn; two requests in one conversation, one runs.
 {
  const a=await account(1000),src=await published(a),req=request(),p1=await peer(),p2=await peer();
  try{
   const same=await Promise.all([openPlan(a,src,req,{client:p1}),openPlan(a,src,req,{client:p2})]);
   assert.equal(same[0].turnId,same[1].turnId);
   assert.equal(await balance(a),970);
   await closePlan(a,same[0].turnId,'failed',{refundAll:true});
   const both=await Promise.allSettled([openPlan(a,src,request(),{client:p1}),openPlan(a,src,request(),{client:p2})]);
   assert.equal(both.filter(x=>x.status==='fulfilled').length,1);
   assert.match(both.find(x=>x.status==='rejected').reason.message,/TURN_SESSION_BUSY/);
   assert.equal(await balance(a),970);
   await closePlan(a,both.find(x=>x.status==='fulfilled').value.turnId,'failed',{refundAll:true});
  }finally{await p1.end();await p2.end();}
  report.checks.push('plan: concurrent opens make one turn and one freeze');
 }
 // 6. Failures: before sending or a failed model pays nothing and saves nothing; an unknown outcome keeps the freeze for recovery.
 {
  const a=await account(1000),src=await published(a),req=request(),o=await openPlan(a,src,req);
  await begin(a,o.turnId,1,{upper:0.05});
  await record(a,o.turnId,1,{status:'not_sent'});
  await closePlan(a,o.turnId,'failed',{refundAll:true});
  assert.equal(await balance(a),1000);
  assert.equal((await read(a,src,req)).body,null);
  const u=request(),x=await openPlan(a,src,u);
  await begin(a,x.turnId,1,{upper:0.05});
  await identity(a,x.turnId,1);
  const closed=await closePlan(a,x.turnId,'interrupted');
  assert.equal(closed.settlement,'pending');
  assert.equal(closed.chargedCredits,null);
  assert.equal(await balance(a),970,'an unknown cost keeps the freeze for recovery');
  report.checks.push('plan: failures refund in full; an unknown outcome waits for recovery');
 }
 // 7. Only a report can be stopped; another account reads nothing; a deleted conversation hides the text; a foreign round is refused.
 {
  const a=await account(1000),src=await published(a),req=request(),o=await openPlan(a,src,req);
  assert.match(await refusal(one('select turn_stop($1,$2,$3,$4) v',[a.actor,o.turnId,false,null])),/TURN_STOP_NOT_ALLOWED/);
  await call(a,o.turnId);
  const b=await account(1000),other=await published(b);
  assert.match(await refusal(closePlan(a,o.turnId,'completed',{body:items,round:other.round})),/TURN_KIND_RESULT_INVALID/);
  await closePlan(a,o.turnId,'completed',{body:items,round:src.round});
  assert.match(await refusal(read(b,src,req)),/TURN_SESSION_DENIED/);
  assert.equal(await read(a,src,randomUUID()),null);
  await c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[src.session]);
  assert.equal((await read(a,src,req)).body,null,'a deleted conversation shows no text');
  report.checks.push('plan: cannot be stopped; read only by its owner; deletion hides the text');
 }
 // 8. A revoked draft reads nothing, its text included (the old path's source boundary).
 {
  const a=await account(1000),src=await published(a),req=request(),o=await openPlan(a,src,req);
  await call(a,o.turnId);
  await closePlan(a,o.turnId,'completed',{body:items,round:src.round});
  assert.equal((await read(a,src,req)).body,items);
  await c.query('update bill2_drafts set revoked=true where id=$1',[src.draft]);
  assert.match(await refusal(read(a,src,req)),/TURN_PLAN_DENIED/);
  report.checks.push('plan: a revoked source reads nothing');
 }
}
