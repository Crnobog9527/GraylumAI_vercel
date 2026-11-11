/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 (Owner 2026-11-03, 同意满24小时退还; migration 0494): turn_call_settle_no_identity. An unknown model call (cost_pending)
// that never got a provider id is claimed by the recovery job and settled at zero once its turn is 24 hours old; the existing
// turn_recover('settle') pass then returns the freeze. Calls with an id keep the 0489 path; a repeat or a race changes nothing twice.
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


const unknownTurn=async({known=false,withId=false,credits=1000}={})=>{
 const a=await account(credits),o=await open(a);
 if(known){await begin(a,o.turnId,1);await record(a,o.turnId,1);}
 const seq=known?2:1;
 await begin(a,o.turnId,seq);if(withId)await identity(a,o.turnId,seq,'gen-id-'+o.turnId);
 const closed=await close(a,o.turnId,'interrupted');
 assert.equal(closed.settlement,'pending');
 return {a,id:o.turnId,seq};
};
const noId=(t,{seq=t.seq,client=c}={})=>one('select turn_call_settle_no_identity($1,$2,$3) v',[t.a.actor,t.id,seq],client);
const old=(t,interval='25 hours')=>c.query(`update turns set opened_at=now()-interval '${interval}' where actor_id=$1 and id=$2`,[t.a.actor,t.id]);
const call=t=>c.query('select status,nominal_usd::text n,actual_usd,cost_pending,usage,provider_id from turn_calls where turn_id=$1 and seq=$2',[t.id,t.seq]).then(r=>r.rows[0]);
const reserved=()=>one('select coalesce(sum(reserved_usd),0)::float8 v from daily_spend');
const unlease=t=>c.query('update turns set recovery_lease_until=null where actor_id=$1 and id=$2',[t.a.actor,t.id]);
const claimed=async t=>{await unlease(t);const items=await claim(50);return items.find(i=>i.turnId===t.id);};
try{
 // 1. Before 24 hours: not claimed, not settled, the freeze stays.
 {
  const t=await unknownTurn();
  assert.equal(await balance(t.a),940);
  assert.equal(await claimed(t),undefined,'a turn younger than 24 hours is not claimed for a call without an id');
  const early=await noId(t);assert.deepEqual([early.settled,early.reason],[false,'too_early']);
  await old(t,'23 hours 59 minutes');
  assert.equal((await noId(t)).reason,'too_early');assert.equal(await claimed(t),undefined);
  const k=await call(t);assert.deepEqual([k.status,k.cost_pending,k.n,k.provider_id],['unknown',true,null,null]);
  assert.equal(await balance(t.a),940);assert.equal((await turn(t.a,t.id)).settlement,'pending');
  report.checks.push('before the turn is 24 hours old nothing is claimed or settled (call stays unknown, freeze stays)');
 }
 // 2. After 24 hours: claimed with providerId null, settled at zero, the freeze returns through the usual settle pass.
 {
  const before=await reserved();
  const t=await unknownTurn();await old(t);
  const item=await claimed(t);
  assert.ok(item&&item.action==='settle',JSON.stringify(item));
  assert.deepEqual(item.calls.map(x=>[x.seq,x.providerId]),[[t.seq,null]]);
  const out=await noId(t);assert.deepEqual([out.settled,out.replay],[true,false]);
  const k=await call(t);
  assert.deepEqual([k.status,k.n,k.actual_usd,k.cost_pending,k.provider_id],['rejected','0.000000000000',null,false,null]);
  assert.equal(k.usage.source,'no_identity_24h');assert.ok(k.usage.turnOpenedAt&&k.usage.settledAt);
  const settled=await recover(t.a,t.id,'settle');
  assert.deepEqual([settled.closeKind,settled.chargedCredits,settled.settlement],['interrupted',0,'done']);
  assert.equal(await balance(t.a),1000,'the whole freeze is back');assert.equal(await spends(t.a),0);
  assert.ok(Math.abs((await reserved())-before)<1e-9,'the stop-loss reservation of the call is released');
  const list=await one('select turn_admin_absent_refunds(50) v');
  const row=list.calls.find(r=>r.turnId===t.id);
  assert.ok(row&&row.source==='no_identity_24h'&&row.providerId===null&&row.httpStatus===null&&row.chargedCredits===0&&row.settlement==='done',JSON.stringify(row));
  report.checks.push('after 24 hours the call is claimed (providerId null) and settled at zero (rejected, usage.source no_identity_24h), the settle pass returns the whole freeze, the reservation is released, the admin list shows it');
 }
 // 3. Repeats change nothing twice; the settled turn is not claimed again.
 {
  const t=await unknownTurn();await old(t);
  const first=await noId(t),second=await noId(t);
  assert.deepEqual([first.replay,second.replay,second.settled],[false,true,true]);
  await recover(t.a,t.id,'settle');
  assert.equal((await recover(t.a,t.id,'settle')).skipped,true);
  assert.equal((await noId(t)).replay,true);
  assert.equal(await balance(t.a),1000);assert.equal(await spends(t.a),0);
  assert.equal(await one("select count(*)::int v from turn_calls where turn_id=$1 and usage->>'source'='no_identity_24h'",[t.id]),1);
  assert.equal(await claimed(t),undefined);
  report.checks.push('a repeated settlement returns the first outcome and changes nothing; the settled turn is not claimed again');
 }
 // 4. A call with a provider id keeps the lookup path; open turns, receipted calls, tools and strangers are refused.
 {
  const t=await unknownTurn({withId:true});await old(t);
  assert.equal((await noId(t)).reason,'has_identity');assert.equal((await call(t)).status,'unknown');
  const item=await claimed(t);assert.deepEqual(item.calls.map(x=>x.providerId),['gen-id-'+t.id]);
  assert.match(await refusal(noId(t,{seq:9})),/TURN_CALL_DENIED/);
  assert.match(await refusal(noId({...t,a:{actor:randomUUID()}})),/TURN_DENIED/);
  const a=await account(),o=await open(a);await begin(a,o.turnId,1);await old({a,id:o.turnId});
  assert.equal((await noId({a,id:o.turnId,seq:1})).reason,'turn_open');
  const k=await unknownTurn({known:true});await old(k);
  assert.equal((await noId({...k,seq:1})).reason,'not_pending');
  report.checks.push('a call with an id is left to the lookup path; an open turn, a receipted call, a wrong call or account is refused');
 }
 // 5. The call is settled at zero; the turn's other receipt keeps its cost.
 // Owner 2026-11-11 (migration turn_interrupted_no_charge): the turn was cut off and saved no answer, so the known receipt is not
 // charged either (before: D=6); its cost stays on the receipt and is Graylum's.
 {
  const t=await unknownTurn({known:true});await old(t);
  assert.equal((await noId(t)).settled,true);
  const settled=await recover(t.a,t.id,'settle');
  assert.deepEqual([settled.chargedCredits,settled.absorbedCredits,settled.settlement],[0,6,'done']);
  assert.equal(await balance(t.a),1000);assert.equal(await spends(t.a),0);
  report.checks.push('an interrupted turn with a known receipt and a call without id: nothing is charged (the known receipt is absorbed, 6 credits), the whole freeze returns');
 }
 // 6. Two instances at once: one settlement and one settle pass each.
 {
  const turns=[];for(let i=0;i<10;i++){const t=await unknownTurn();await old(t);turns.push(t);}
  const [p1,p2]=[await peer(),await peer()];
  try{
   const results=await Promise.all(turns.flatMap(t=>[noId(t,{client:p1}),noId(t,{client:p2})]));
   assert.equal(results.filter(r=>r.settled&&!r.replay).length,10,'exactly one fresh settlement per call');
   assert.equal(results.filter(r=>r.replay).length,10);
   const passes=await Promise.all(turns.flatMap(t=>[recover(t.a,t.id,'settle',p1),recover(t.a,t.id,'settle',p2)]));
   assert.equal(passes.filter(r=>!r.skipped).length,10,'exactly one settle pass per turn');
  }finally{await p1.end();await p2.end();}
  for(const t of turns){assert.equal(await balance(t.a),1000);assert.equal(await spends(t.a),0);
   assert.equal((await turn(t.a,t.id)).settlement,'done');}
  report.checks.push('two instances racing on the same calls: one settlement and one settle pass each, every freeze returned once');
 }
 // 7. Service role only.
 {
  for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]])
   assert.equal(await one("select has_function_privilege($1,'public.turn_call_settle_no_identity(uuid,bigint,integer)','EXECUTE') v",[role]),want,role);
  report.checks.push('service role only');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
