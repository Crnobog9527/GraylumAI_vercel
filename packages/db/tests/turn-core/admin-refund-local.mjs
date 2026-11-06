/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 RECONCILE (b): turn_admin_stuck_turns / turn_admin_refund_all. A turn opened 24 hours ago or more that is not closed,
// or that is closed with the user's charge still undecided (an unknown model cost holds it), is listed; the admin action settles its
// unknown model calls at zero and returns the whole freeze once. A younger turn, a settled turn, a non-admin and a repeat change nothing.
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


const old=(t,interval='25 hours')=>c.query(`update turns set opened_at=now()-interval '${interval}',updated_at=now()-interval '${interval}' where actor_id=$1 and id=$2`,[t.a.actor,t.id]);
const reserved=()=>one('select coalesce(sum(reserved_usd),0)::float8 v from daily_spend');
const adminAccount=async(over={})=>{const id=randomUUID();
 await c.query("insert into profiles(id,credits,role) values($1,0,'admin')",[id]);
 if(over.status)await c.query('update profiles set status=$2 where id=$1',[id,over.status]);
 return id;};
const refund=async(t,admin,{request=randomUUID(),reason='stuck lookup',client=c}={})=>{
 const out=await one('select turn_admin_refund_all($1,$2,$3,$4,$5) v',[t.a.actor,t.id,admin,request,reason],client);
 // The router writes the audit row right after a refund (turn_admin_refund_audit); a refusal writes none.
 if(out.refunded)await one('select turn_admin_refund_audit($1,$2,$3,$4,$5) v',
  [t.a.actor,t.id,admin,request,JSON.stringify({reason,stateBefore:out.stateBefore,closeKind:out.closeKind,reservedCredits:out.reservedCredits,chargedCredits:out.chargedCredits})],client);
 return out;};
const listed=async t=>(await one('select turn_admin_unsettled_turns(200) v')).turns.find(x=>x.turnId===t.id);
const stuck=()=>one('select turn_admin_stuck_turns() v');
const audit=t=>one("select count(*)::int v from user_activity_logs where user_id=$1 and action='turn_admin_refund_all'",[t.a.actor]);
const callRow=t=>c.query('select status,nominal_usd::text n,cost_pending,usage from turn_calls where turn_id=$1 and seq=$2',[t.id,t.seq]).then(r=>r.rows[0]);
// A closed turn whose only model call has a provider id and an unknown cost: the lookup never answers (timeouts, 5xx, 429, no key).
const stuckTurn=async({credits=1000}={})=>{
 const a=await account(credits),o=await open(a);
 await begin(a,o.turnId,1);await identity(a,o.turnId,1,'gen-stuck-'+o.turnId);
 const closed=await close(a,o.turnId,'interrupted');assert.equal(closed.settlement,'pending');
 return {a,id:o.turnId,seq:1};
};
try{
 const admin=await adminAccount();
 // 1. Younger than 24 hours: not listed, refused, the freeze stays.
 {
  const t=await stuckTurn(),before=(await stuck()).total;
  assert.equal(await balance(t.a),940);
  await old(t,'23 hours 59 minutes');
  assert.equal((await stuck()).total,before,'a turn younger than 24 hours is not listed');
  const early=await refund(t,admin);assert.deepEqual([early.refunded,early.reason],[false,'too_young']);
  assert.equal(await balance(t.a),940);assert.equal((await turn(t.a,t.id)).settlement,'pending');assert.equal(await audit(t),0);
  report.checks.push('a turn younger than 24 hours is not listed and the refund is refused (freeze stays, nothing written)');
 }
 // 2. After 24 hours: listed; the refund settles the unknown call at zero and returns the whole freeze, once, with an audit row.
 {
  const before=await stuck(),t=await stuckTurn();await old(t);
  const listed=await stuck();assert.equal(listed.total,before.total+1);assert.ok(listed.oldestOpenedAt);
  const reservedBefore=await reserved();
  const out=await refund(t,admin);
  assert.deepEqual([out.refunded,out.chargedCredits,out.stateBefore,out.settlement],[true,0,'closed','done'],JSON.stringify(out));
  const k=await callRow(t);assert.deepEqual([k.status,k.n,k.cost_pending,k.usage.source],['unknown',null,false,'admin_refund_all'],'a call with a provider id keeps an unknown cost (the supplier may have charged)');
  assert.equal(await balance(t.a),1000,'the whole freeze is back');assert.equal(await spends(t.a),0);
  assert.ok((await reserved())<=reservedBefore+1e-9,'the stop-loss reservation of the call is released');
  const turnRow=await turn(t.a,t.id);assert.deepEqual([turnRow.state,turnRow.charged_credits,turnRow.settlement],['closed',0,'done']);
  assert.equal(await audit(t),1);
  const log=await c.query("select admin_id,action_type,details from user_activity_logs where user_id=$1 and action='turn_admin_refund_all'",[t.a.actor]);
  assert.equal(log.rows[0].admin_id,admin);assert.equal(log.rows[0].action_type,'admin');
  assert.equal(log.rows[0].details.turnId,t.id);assert.equal(log.rows[0].details.reason,'stuck lookup');
  assert.equal((await stuck()).total,before.total,'the refunded turn is no longer listed');
  report.checks.push('after 24 hours the turn is listed; the refund releases the unknown call with a provider id without presuming it free (stays unknown, no nominal cost; usage.source admin_refund_all), returns the whole freeze, releases the reservation and writes one audit row');
 }
 // 2b. A model call that never got a provider id is settled at zero (nothing was observed from the supplier).
 {
  const a=await account(),o=await open(a);await begin(a,o.turnId,1);
  const closed=await close(a,o.turnId,'failed');assert.equal(closed.settlement,'pending');
  const t={a,id:o.turnId,seq:1};await old(t);
  const out=await refund(t,admin);assert.equal(out.refunded,true,JSON.stringify(out));
  const k=await callRow(t);assert.deepEqual([k.status,k.n,k.cost_pending],['rejected','0.000000000000',false]);
  assert.equal(await balance(a),1000);
  report.checks.push('a model call without a provider id is settled at zero by the refund (rejected), the freeze returns');
 }
 // 3. A repeat, a second request id and a race refund once.
 {
  const t=await stuckTurn();await old(t);
  const first=await refund(t,admin),again=await refund(t,admin),other=await refund(t,admin,{request:randomUUID()});
  assert.equal(first.refunded,true);assert.deepEqual([again.refunded,again.reason,other.refunded,other.reason],[false,'already_settled',false,'already_settled']);
  assert.equal(await balance(t.a),1000);assert.equal(await audit(t),1);
  const raced=[];for(let i=0;i<6;i++){const r=await stuckTurn();await old(r);raced.push(r);}
  const [p1,p2]=[await peer(),await peer()];
  try{
   const results=await Promise.all(raced.flatMap(r=>[refund(r,admin,{client:p1}),refund(r,admin,{client:p2})]));
   assert.equal(results.filter(r=>r.refunded).length,6,'exactly one refund per turn');
   assert.equal(results.filter(r=>!r.refunded&&r.reason==='already_settled').length,6);
  }finally{await p1.end();await p2.end();}
  for(const r of raced){assert.equal(await balance(r.a),1000);assert.equal(await audit(r),1);
   assert.equal(await one("select count(*)::int v from turn_calls where turn_id=$1 and usage->>'source'='admin_refund_all'",[r.id]),1);}
  report.checks.push('a repeat or another request id changes nothing; two instances racing on six turns: one refund and one audit row each');
 }
 // 4. An open turn stuck for more than 24 hours is closed as failed with the whole freeze returned.
 {
  const a=await account(),o=await open(a);await begin(a,o.turnId,1);await identity(a,o.turnId,1,'gen-open-'+o.turnId);
  const t={a,id:o.turnId,seq:1};
  assert.equal(await balance(a),940);await old(t);
  assert.ok((await stuck()).total>=1);
  const out=await refund(t,admin);
  assert.deepEqual([out.refunded,out.stateBefore,out.closeKind],[true,'running','failed'],JSON.stringify(out));
  const turnRow=await turn(a,o.turnId);assert.deepEqual([turnRow.state,turnRow.close_kind,turnRow.failure_code,turnRow.charged_credits],['closed','failed','admin_refund_all',0]);
  assert.equal(await balance(a),1000);assert.equal((await callRow(t)).status,'unknown');
  report.checks.push('an open turn older than 24 hours is closed as failed (failure_code admin_refund_all) and its freeze returns');
 }
 // 4b. An open turn opened long ago but written to recently (a jury review between two seat groups) is neither listed nor refundable.
 {
  const a=await account(),o=await open(a);await begin(a,o.turnId,1);await identity(a,o.turnId,1,'gen-busy-'+o.turnId);
  const t={a,id:o.turnId,seq:1};
  await c.query("update turns set opened_at=now()-interval '30 hours' where actor_id=$1 and id=$2",[a.actor,o.turnId]);
  const before=(await stuck()).total;
  const out=await refund(t,admin);assert.deepEqual([out.refunded,out.reason],[false,'too_young']);
  assert.equal((await turn(a,o.turnId)).state,'running');assert.equal(await balance(a),940);assert.equal(await audit(t),0);
  await c.query("update turns set updated_at=now()-interval '25 hours' where actor_id=$1 and id=$2",[a.actor,o.turnId]);
  assert.equal((await stuck()).total,before+1,'idle for 24 hours: listed');
  assert.equal((await refund(t,admin)).refunded,true);assert.equal(await balance(a),1000);
  report.checks.push('an open turn written to within 24 hours is not listed and not refundable; once idle for 24 hours it is');
 }
 // 5. Nothing changes for a turn already settled for the user, or one whose only pending cost is a tool.
 {
  const a=await account(),o=await open(a);await begin(a,o.turnId,1);await record(a,o.turnId,1);
  const done=await close(a,o.turnId,'completed');assert.equal(done.settlement,'done');
  const t={a,id:o.turnId,seq:1};await old(t);
  const balanceBefore=await balance(a),turnBefore=await turn(a,o.turnId);
  const out=await refund(t,admin);assert.deepEqual([out.refunded,out.reason],[false,'already_settled']);
  assert.equal(await balance(a),balanceBefore);assert.deepEqual(await turn(a,o.turnId),turnBefore);assert.equal(await audit(t),0);
  const tool=await account(),to=await open(tool);await begin(tool,to.turnId,1);await record(tool,to.turnId,1);
  await begin(tool,to.turnId,2,{kind:'tool',paid:1,upper:0.02});
  const closedTool=await close(tool,to.turnId,'completed');
  const tt={a:tool,id:to.turnId,seq:2};await old(tt);
  const toolRow=await turn(tool,to.turnId);
  if(toolRow.settlement==='pending'){
   assert.notEqual(toolRow.charged_credits,null,'only a tool cost is pending: the user is already charged');
   assert.equal((await refund(tt,admin)).reason,'already_settled');
  }
  assert.ok(closedTool);
  // 5b. The same tool turn, its tool call carrying a provider id that never resolves, still pending 49 hours after the close: it is
  // listed (the daily alert counts it) and the admin action closes it: the user's charge is untouched, the cost stays unknown.
  assert.equal(toolRow.settlement,'pending');
  await c.query("update turn_calls set provider_id='gen-tool-stuck' where turn_id=$1 and seq=2",[to.turnId]);
  await c.query("update turns set opened_at=now()-interval '51 hours',updated_at=now()-interval '49 hours',closed_at=now()-interval '49 hours' where actor_id=$1 and id=$2",[tool.actor,to.turnId]);
  assert.equal((await listed(tt)).refundEligible,true,'closed 49 hours ago: eligible');
  await c.query("update turns set updated_at=now() where actor_id=$1 and id=$2",[tool.actor,to.turnId]);
  assert.equal((await listed(tt)).refundEligible,true,'a refreshed updated_at (the recovery claim) does not hide it');
  await c.query("update turns set closed_at=now()-interval '47 hours' where actor_id=$1 and id=$2",[tool.actor,to.turnId]);
  assert.equal((await listed(tt)).refundEligible,false,'closed 47 hours ago: not yet');
  assert.equal((await refund(tt,admin)).reason,'already_settled');
  await c.query("update turns set closed_at=now()-interval '49 hours' where actor_id=$1 and id=$2",[tool.actor,to.turnId]);
  const listedBefore=await stuck();
  const balanceTool=await balance(tool),reservedTool=await reserved();
  const outTool=await refund(tt,admin);assert.equal(outTool.refunded,true,JSON.stringify(outTool));
  const after=await turn(tool,to.turnId);
  assert.deepEqual([after.charged_credits,after.settlement],[toolRow.charged_credits,'done']);
  assert.equal(await balance(tool),balanceTool,'the user pays nothing more and gets nothing back');
  const kt=await c.query('select status,cost_pending,actual_usd,usage from turn_calls where turn_id=$1 and seq=2',[to.turnId]);
  assert.deepEqual([kt.rows[0].status,kt.rows[0].cost_pending,kt.rows[0].actual_usd,kt.rows[0].usage.source],['unknown',false,null,'admin_refund_all_cost_unknown']);
  assert.ok((await reserved())<reservedTool+1e-9,'the reservation is released');
  assert.equal((await stuck()).total,listedBefore.total-1);
  assert.equal(await audit(tt),1);
  assert.equal((await refund(tt,admin)).reason,'already_settled');
  report.checks.push('a charged turn whose tool call (with a provider id) stays pending 48 hours after the close is listed; the refund releases it (cost kept unknown, charge untouched, settlement done, one audit row, repeat changes nothing)');
  report.checks.push('a turn already settled for the user is not touched (balance, turn row and audit unchanged), also when only a tool cost is pending');
 }
 // 5c. A jury turn (running, then paused) is closed through the review's own close (turn_fusion_close): the review row ends with it, so the
 // user is not blocked by an active review, and the freeze returns.
 for(const live of ['running','paused']){
  const a=await account(),src=await one('select turn_test.topic_source($1) v',[a.actor]);
  const o=await open(a,{kind:'jury',pol:policy({gCredits:60})});
  const reviewId=randomUUID();
  await c.query(`insert into fusion_reviews(id,actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
   materials,materials_hash,config,state,round,phase,attempt) values($1,$2,$3,$4,$5,$6,$7,'h','{}',repeat('a',64),'{"maxRounds":2,"path":"turn"}',$8,1,'review',1)`,
   [reviewId,a.actor,randomUUID(),src.draft,src.project,src.session,src.version,live]);
  await c.query("update turns set policy=policy||jsonb_build_object('reviewId',$3::text) where actor_id=$1 and id=$2",[a.actor,o.turnId,reviewId]);
  if(live==='paused')await c.query("update turns set state='paused',pause_reason='awaiting_user' where actor_id=$1 and id=$2",[a.actor,o.turnId]);
  const t={a,id:o.turnId,seq:1};await old(t);
  const out=await refund(t,admin);assert.equal(out.refunded,true,JSON.stringify(out));
  const review=(await c.query('select state,ended_at from fusion_reviews where id=$1',[reviewId])).rows[0];
  assert.equal(review.state,'interrupted',live+': the review row ends with the turn');assert.ok(review.ended_at);
  assert.equal((await turn(a,o.turnId)).state,'closed');assert.equal(await balance(a),1000);
  assert.equal((await refund(t,admin)).reason,'already_settled');
 }
 report.checks.push('a jury turn (running or paused, with its review row) is closed through turn_fusion_close: the review ends (state interrupted) and the freeze returns; a repeat changes nothing');
 // 6. Only an active admin may refund; the audit id is the request id.
 {
  const t=await stuckTurn();await old(t);
  const user=(await account()).actor,inactive=await adminAccount({status:'inactive'});
  for(const who of [user,inactive,randomUUID(),null])assert.match(await refusal(refund(t,who)),/TURN_ADMIN_DENIED/);
  assert.match(await refusal(refund({...t,a:{actor:randomUUID()}},admin)),/TURN_DENIED/);
  assert.equal(await balance(t.a),940);assert.equal((await turn(t.a,t.id)).settlement,'pending');assert.equal(await audit(t),0);
  const request=randomUUID();await refund(t,admin,{request});
  assert.equal(await one("select count(*)::int v from user_activity_logs where id=$1",[request]),1);
  report.checks.push('a plain user, an inactive admin, an unknown or missing admin and a wrong account are refused with nothing written');
 }
 // 7. Service role only.
 {
  for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]]){
   assert.equal(await one("select has_function_privilege($1,'public.turn_admin_refund_all(uuid,bigint,uuid,uuid,text)','EXECUTE') v",[role]),want,role);
   assert.equal(await one("select has_function_privilege($1,'public.turn_admin_stuck_turns()','EXECUTE') v",[role]),want,role);
   assert.equal(await one("select has_function_privilege($1,'public.turn_admin_refund_audit(uuid,bigint,uuid,uuid,jsonb)','EXECUTE') v",[role]),want,role);
   assert.equal(await one("select has_function_privilege($1,'public.turn_admin_unsettled_turns(integer)','EXECUTE') v",[role]),want,role);
  }
  report.checks.push('service role only');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
