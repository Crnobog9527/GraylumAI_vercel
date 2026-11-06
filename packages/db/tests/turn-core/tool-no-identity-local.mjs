/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 RECONCILE (b), tool calls (staging turns 6626 and 6639): a chat turn closed as completed whose web_fetch tool call stayed
// unknown (no provider id) kept its settlement 'pending' for ever: 0494's 24-hour settlement and the recovery claim only knew model calls.
// Now the tool call is claimed after 24 hours and settled with the call kept 'unknown' (cost never presumed zero for the platform), the user's
// charge is untouched (already decided at the close), the stop-loss reservation is released and the existing settle pass completes the turn.
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


const old=(t,interval='25 hours')=>c.query(`update turns set opened_at=now()-interval '${interval}' where actor_id=$1 and id=$2`,[t.a.actor,t.id]);
const reserved=()=>one('select coalesce(sum(reserved_usd),0)::float8 v from daily_spend');
const stuck=()=>one('select turn_admin_stuck_turns() v');
const unlease=t=>c.query('update turns set recovery_lease_until=null where actor_id=$1 and id=$2',[t.a.actor,t.id]);
const claimed=async t=>{await unlease(t);const items=await claim(50);return items.find(i=>i.turnId===t.id);};
const toolRow=t=>c.query('select status,cost_pending,actual_usd,nominal_usd,provider_id,usage from turn_calls where turn_id=$1 and seq=$2',[t.id,t.seq]).then(r=>r.rows[0]);
const settleTool=(t,client=c)=>one('select turn_call_settle_no_identity($1,$2,$3) v',[t.a.actor,t.id,t.seq],client);
// Shaped like staging turns 6626 and 6639: model call, a tool call that never got an answer or a provider id, model call; closed completed.
const webFetchTurn=async()=>{
 const a=await account(),o=await open(a);
 await begin(a,o.turnId,1);await record(a,o.turnId,1);
 await begin(a,o.turnId,2,{kind:'tool',tool:'web_fetch',paid:true,upper:0.005});
 await begin(a,o.turnId,3);await record(a,o.turnId,3);
 const closed=await close(a,o.turnId,'completed');
 assert.equal(closed.settlement,'pending','the unknown tool call keeps the settlement pending');
 assert.ok(closed.chargedCredits>0,'the user is charged for the two model calls at the close');
 return {a,id:o.turnId,seq:2,charged:closed.chargedCredits};
};
try{
 // 1. Before 24 hours nothing is claimed or settled.
 {
  const t=await webFetchTurn();
  assert.equal(await claimed(t),undefined);
  assert.equal((await settleTool(t)).reason,'too_early');
  await old(t,'23 hours 59 minutes');assert.equal(await claimed(t),undefined);assert.equal((await settleTool(t)).reason,'too_early');
  const k=await toolRow(t);assert.deepEqual([k.status,k.cost_pending,k.provider_id],['unknown',true,null]);
  assert.equal((await turn(t.a,t.id)).settlement,'pending');
  report.checks.push('before the turn is 24 hours old the tool call is neither claimed nor settled');
 }
 // 2. After 24 hours: claimed (providerId null), settled with the call kept unknown, the charge untouched, the reservation released, the turn done.
 {
  const before=await reserved();
  const t=await webFetchTurn();await old(t);
  const balanceAfterClose=await balance(t.a);
  const item=await claimed(t);
  assert.ok(item&&item.action==='settle',JSON.stringify(item));
  assert.deepEqual(item.calls.map(x=>[x.seq,x.providerId,x.model]),[[2,null,null]]);
  const out=await settleTool(t);assert.deepEqual([out.settled,out.replay],[true,false]);
  const k=await toolRow(t);
  assert.deepEqual([k.status,k.cost_pending,k.actual_usd,k.provider_id],['unknown',false,null,null],'the cost is not presumed zero for the platform');
  assert.equal(k.usage.source,'tool_no_identity_24h');assert.ok(k.usage.turnOpenedAt&&k.usage.settledAt);
  const settled=await recover(t.a,t.id,'settle');
  assert.deepEqual([settled.closeKind,settled.chargedCredits,settled.settlement],['completed',t.charged,'done'],JSON.stringify(settled));
  assert.equal(await balance(t.a),balanceAfterClose,'the user is neither charged nor refunded again');
  assert.equal(await spends(t.a),t.charged);
  assert.ok(Math.abs((await reserved())-before)<1e-9,'the stop-loss reservation of the call is released');
  assert.equal(await claimed(t),undefined,'a settled turn is not claimed again');
  const unknown=await one(`select count(*)::int v from turn_calls where turn_id=$1 and actual_usd is null and status='unknown'`,[t.id]);
  assert.equal(unknown,1,'the admin cost report still counts the call as an unknown actual cost');
  report.checks.push('after 24 hours the tool call is claimed (providerId null) and settled (stays unknown, never presumed free), the user charge is unchanged, the reservation is released and the turn completes');
 }
 // 3. Repeats and two instances change nothing twice.
 {
  const turns=[];for(let i=0;i<8;i++){const t=await webFetchTurn();await old(t);turns.push(t);}
  const [p1,p2]=[await peer(),await peer()];
  try{
   const results=await Promise.all(turns.flatMap(t=>[settleTool(t,p1),settleTool(t,p2)]));
   assert.equal(results.filter(r=>r.settled&&!r.replay).length,8,'exactly one fresh settlement per call');
   assert.equal(results.filter(r=>r.replay).length,8);
   const passes=await Promise.all(turns.flatMap(t=>[recover(t.a,t.id,'settle',p1),recover(t.a,t.id,'settle',p2)]));
   assert.equal(passes.filter(r=>!r.skipped).length,8,'exactly one settle pass per turn');
  }finally{await p1.end();await p2.end();}
  for(const t of turns){assert.equal(await spends(t.a),t.charged);assert.equal((await turn(t.a,t.id)).settlement,'done');}
  report.checks.push('two instances racing on eight turns: one settlement and one settle pass each, the user charged once');
 }
 // 4. A closed turn the user was charged for, still pending 48 hours after the close, is listed (never silent); a settled one is not.
 {
  const before=(await stuck()).total,t=await webFetchTurn();
  await c.query("update turns set opened_at=now()-interval '50 hours',closed_at=now()-interval '49 hours' where actor_id=$1 and id=$2",[t.a.actor,t.id]);
  assert.equal((await stuck()).total,before+1);
  await settleTool(t);await recover(t.a,t.id,'settle');
  assert.equal((await stuck()).total,before);
  const young=await webFetchTurn();await c.query("update turns set opened_at=now()-interval '30 hours',closed_at=now()-interval '47 hours' where actor_id=$1 and id=$2",[young.a.actor,young.id]);
  assert.equal((await stuck()).total,before,'within 48 hours of the close it is not yet listed');
  report.checks.push('a charged turn still pending 48 hours after the close is listed by turn_admin_stuck_turns, a settled or younger one is not');
 }
 // 4b. A positioning check (decision) with no provider id is settled like the tool: unknown kept, the turn completes.
 {
  const a=await account(),o=await open(a,{pol:policy({limits:{model:3,paidTools:1,freeTools:1,decisions:1}})});await begin(a,o.turnId,1,{kind:'decision'});await begin(a,o.turnId,2);await record(a,o.turnId,2);
  const closed=await close(a,o.turnId,'completed');assert.equal(closed.settlement,'pending');
  const t={a,id:o.turnId,seq:1};await old(t);
  const first=await settleTool(t);assert.equal(first.settled,true,JSON.stringify(first));
  await recover(a,o.turnId,'settle');
  const row=await toolRow(t);assert.deepEqual([row.status,row.cost_pending,row.actual_usd],['unknown',false,null]);
  assert.equal((await turn(a,o.turnId)).settlement,'done');
  report.checks.push('a decision call without a provider id is settled after 24 hours (stays unknown) and the turn completes');
 }
 // 5. A call with a provider id, a receipted call and a decision call are left alone by this path.
 {
  const a=await account(),o=await open(a);await begin(a,o.turnId,1);await record(a,o.turnId,1);
  await begin(a,o.turnId,2,{kind:'tool',tool:'web_fetch',paid:true,upper:0.005});await close(a,o.turnId,'completed');
  const t={a,id:o.turnId,seq:1};await old(t);
  assert.equal((await settleTool({...t,seq:1})).reason,'not_pending');
  report.checks.push('a receipted call is refused as not pending');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
