/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 round 12 defect 1 (Owner 2026-11-03, 同意自动退还): turn_call_settle_absent. An unknown model call (cost_pending) whose
// provider id the provider answers with 404 "no such generation" is settled at zero once the turn is 24 hours old; the existing
// turn_recover('settle') pass then returns the freeze. Nothing else qualifies; a repeat or a race changes nothing twice.
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

const unknownTurn=async({known=false,credits=1000}={})=>{
 const a=await account(credits),o=await open(a);
 if(known){await begin(a,o.turnId,1);await record(a,o.turnId,1);}
 const seq=known?2:1;
 await begin(a,o.turnId,seq);await identity(a,o.turnId,seq,'gen-absent-'+o.turnId);
 const closed=await close(a,o.turnId,'interrupted');
 assert.equal(closed.settlement,'pending');
 return {a,id:o.turnId,seq,provider:'gen-absent-'+o.turnId};
};
const absent=(t,{status=404,provider=t.provider,seq=t.seq,payload=hash('404'+t.id),client=c}={})=>
 one('select turn_call_settle_absent($1,$2,$3,$4,$5,$6) v',[t.a.actor,t.id,seq,provider,status,payload],client);
const old=(t,interval='25 hours')=>c.query(`update turns set opened_at=now()-interval '${interval}' where actor_id=$1 and id=$2`,[t.a.actor,t.id]);
const call=t=>c.query('select status,nominal_usd::text n,actual_usd,cost_pending,usage,payload_hash from turn_calls where turn_id=$1 and seq=$2',[t.id,t.seq]).then(r=>r.rows[0]);
const reserved=()=>one('select coalesce(sum(reserved_usd),0)::float8 v from daily_spend');
try{
 // 1. Before 24 hours the provider's "not found" is not enough: the call stays unknown and the freeze stays.
 {
  const t=await unknownTurn();
  assert.equal(await balance(t.a),940);
  const early=await absent(t);
  assert.deepEqual([early.settled,early.reason],[false,'too_early']);
  await old(t,'23 hours 59 minutes');
  assert.equal((await absent(t)).reason,'too_early');
  const k=await call(t);assert.deepEqual([k.status,k.cost_pending,k.n],['unknown',true,null]);
  assert.equal(await balance(t.a),940);assert.equal((await turn(t.a,t.id)).settlement,'pending');
  report.checks.push('before the turn is 24 hours old the answer settles nothing (call stays unknown, freeze stays)');
 }
 // 2. After 24 hours: zero cost, the whole freeze returns through the usual settle pass, every field on record.
 {
  const before=await reserved();
  const t=await unknownTurn();
  const held=await reserved();
  await old(t);
  const out=await absent(t);
  assert.deepEqual([out.settled,out.replay],[true,false]);
  const k=await call(t);
  assert.deepEqual([k.status,k.n,k.actual_usd,k.cost_pending],['rejected','0.000000000000',null,false]);
  assert.deepEqual([k.usage.source,k.usage.providerId,k.usage.httpStatus],['lookup_absent',t.provider,404]);
  assert.equal(k.payload_hash,hash('404'+t.id));
  const settled=await recover(t.a,t.id,'settle');
  assert.deepEqual([settled.closeKind,settled.chargedCredits,settled.settlement],['interrupted',0,'done']);
  assert.equal(await balance(t.a),1000,'the whole freeze is back');assert.equal(await spends(t.a),0);
  assert.ok(held>=before);assert.ok(Math.abs((await reserved())-before)<1e-9,'the stop-loss reservation of the call is released');
  const list=await one('select turn_admin_absent_refunds(50) v');
  const row=list.calls.find(r=>r.turnId===t.id);
  assert.ok(row&&row.providerId===t.provider&&row.httpStatus===404&&row.chargedCredits===0&&row.settlement==='done',JSON.stringify(row));
  assert.ok(list.total>=1);
  report.checks.push('after 24 hours a 404 settles the call at zero (rejected, usage.source lookup_absent with provider id/status/hash), the settle pass returns the whole freeze (balance 1000, no spend row), the reservation is released, the admin list shows it');
 }
 // 3. Repeats change nothing twice.
 {
  const t=await unknownTurn();await old(t);
  const first=await absent(t),second=await absent(t);
  assert.deepEqual([first.replay,second.replay,second.settled],[false,true,true]);
  await recover(t.a,t.id,'settle');
  assert.equal((await recover(t.a,t.id,'settle')).skipped,true);
  const again=await absent(t);assert.equal(again.replay,true);
  assert.equal(await balance(t.a),1000);assert.equal(await spends(t.a),0);
  assert.equal(await one("select count(*)::int v from turn_calls where turn_id=$1 and usage->>'source'='lookup_absent'",[t.id]),1);
  report.checks.push('a repeated settlement (before or after the settle pass) returns the first outcome and changes nothing');
 }
 // 4. Nothing but an explicit 404 on a cost_pending unknown model call of a closed turn qualifies.
 {
  const t=await unknownTurn();await old(t);
  for(const status of [200,401,408,429,500,502,503,504,null])
   assert.match(await refusal(absent(t,{status})),/TURN_CALL_INVALID/,String(status));
  assert.match(await refusal(absent(t,{payload:'nothex'})),/TURN_CALL_INVALID/);
  assert.match(await refusal(absent(t,{provider:'gen-other'})),/TURN_CALL_CONFLICT/);
  assert.match(await refusal(absent(t,{seq:9})),/TURN_CALL_DENIED/);
  assert.match(await refusal(absent({...t,a:{actor:randomUUID()}})),/TURN_DENIED/);
  assert.equal((await call(t)).status,'unknown');
  // A turn still open, and a call that already has its receipt, are not settled.
  const a=await account(),o=await open(a);await begin(a,o.turnId,1);await identity(a,o.turnId,1,'gen-open');
  await old({a,id:o.turnId});
  assert.equal((await absent({a,id:o.turnId,seq:1,provider:'gen-open'})).reason,'turn_open');
  const k=await unknownTurn({known:true});await old(k);
  assert.equal((await absent({...k,seq:1,provider:'gen-1'})).reason,'not_pending');
  report.checks.push('only 404 qualifies (200/401/408/429/5xx/null refused); wrong provider id, call, account refused; an open turn or an already receipted call is not settled');
 }
 // 5. The call is settled at zero; what the turn's other calls cost the user is still charged.
 {
  const t=await unknownTurn({known:true});await old(t);
  assert.equal((await absent(t)).settled,true);
  const settled=await recover(t.a,t.id,'settle');
  assert.deepEqual([settled.chargedCredits,settled.settlement],[6,'done']);
  assert.equal(await balance(t.a),994);assert.equal(await spends(t.a),6);
  report.checks.push('a turn with a known receipt and an absent call: only the known call is charged (D=6), the rest of the freeze returns');
 }
 // 6. Two instances at once, settlement and the settle pass: one effect.
 {
  const turns=[];for(let i=0;i<10;i++){const t=await unknownTurn();await old(t);turns.push(t);}
  const [p1,p2]=[await peer(),await peer()];
  try{
   const results=await Promise.all(turns.flatMap(t=>[absent(t,{client:p1}),absent(t,{client:p2})]));
   assert.equal(results.filter(r=>r.settled&&!r.replay).length,10,'exactly one fresh settlement per call');
   assert.equal(results.filter(r=>r.replay).length,10);
   const passes=await Promise.all(turns.flatMap(t=>[recover(t.a,t.id,'settle',p1),recover(t.a,t.id,'settle',p2)]));
   assert.equal(passes.filter(r=>!r.skipped).length,10,'exactly one settle pass per turn');
  }finally{await p1.end();await p2.end();}
  for(const t of turns){assert.equal(await balance(t.a),1000);assert.equal(await spends(t.a),0);
   assert.deepEqual([(await turn(t.a,t.id)).charged_credits,(await turn(t.a,t.id)).settlement],[0,'done']);}
  report.checks.push('two instances racing on the same calls: one settlement and one settle pass each, every freeze returned once');
 }
 // 7. Service role only; the admin list is read-only and bounded.
 {
  for(const fn of ['turn_call_settle_absent(uuid,bigint,integer,text,integer,text)','turn_admin_absent_refunds(integer)'])
   for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]])
    assert.equal(await one("select has_function_privilege($1,$2,'EXECUTE') v",[role,'public.'+fn]),want,`${fn} ${role}`);
  assert.equal((await one('select turn_admin_absent_refunds(1) v')).calls.length,1);
  assert.ok((await one('select turn_admin_absent_refunds(0) v')).calls.length<=1);
  report.checks.push('service role only; the admin list is bounded');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
