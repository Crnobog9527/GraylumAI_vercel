/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// BILL-BYOK (Owner 2026-11-07): OpenRouter serves an Anthropic/OpenAI call with the official key the Owner added (BYOK). The
// application then records actual_usd = OpenRouter's fee + the vendor's upstream charge, the split in usage.byok, and the same
// nominal_usd (frozen list price x tokens) as for any other call (openRouterByok.ts; its unit tests prove those values). Here,
// on the real ledger functions: the user's charge and the stop-loss share of a BYOK call equal a non-BYOK call's; an unusable
// BYOK call counts its whole cost; a receipt recorded twice, or raced by the live path and recovery, settles once.
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
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<1e-9,`${label}: ${actual} != ${expected}`);
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
const open=a=>one('select turn_open($1,$2,$3,$4,$5,$6) v',[a.actor,a.session,randomUUID(),'chat',JSON.stringify(policy()),null]);
const begin=(a,turn,seq)=>one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,'model',randomUUID(),null,null,hash('r'+turn+seq),0.02,6]);
const identity=(a,turn,seq,id)=>one('select turn_call_identity($1,$2,$3,$4) v',[a.actor,turn,seq,id]);
// The receipt the application writes (call.ts / recovery.ts): the same tokens, so the same nominal; only actual and usage differ.
const tokens={inputTokens:'2000',outputTokens:'600'};
const plain={n:'0.01',a:'0.01',usage:tokens};
const byok={n:'0.01',a:'0.0105',usage:{...tokens,byok:{feeUsd:'0.0005',upstreamUsd:'0.01'}}};
const record=(a,turn,seq,r,{status='ok',payload=hash('p'+turn+seq),provider=null,client=c}={})=>
 one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
  [a.actor,turn,seq,status,r.n,r.a,JSON.stringify(r.usage),provider,payload,'{"choices":[]}'],client);
const close=(a,turn,kind='completed')=>one("select turn_close($1,$2,$3,'[]',false,false,null) v",[a.actor,turn,kind]);
const recover=(a,turn,client=c)=>one("select turn_recover($1,$2,'settle') v",[a.actor,turn],client);
const charged=(a,id)=>one('select charged_credits v from turns where actor_id=$1 and id=$2',[a.actor,id]);
const spends=a=>one("select coalesce(sum(-amount),0)::int v from credit_transactions where user_id=$1 and reason_code='turn_spend'",[a.actor]);
const callRow=(id,seq=1)=>c.query('select status,nominal_usd::text n,actual_usd::text a,usage from turn_calls where turn_id=$1 and seq=$2',[id,seq])
 .then(r=>r.rows[0]);
const spent=()=>one('select coalesce(sum(spent_usd),0)::float8 v from daily_spend');
// One completed turn with one model receipt; the daily spend it adds.
async function settled(r,status='ok'){
 const a=await account(),o=await open(a),before=await spent();
 await begin(a,o.turnId,1);await record(a,o.turnId,1,r,{status});
 await close(a,o.turnId);
 return {a,id:o.turnId,added:await spent()-before};
}
// A turn closed while its only model call was unknown (cost_pending), as an interrupted stream leaves it for recovery.
async function unknown(){
 const a=await account(),o=await open(a);
 await begin(a,o.turnId,1);await identity(a,o.turnId,1,'gen-byok-'+o.turnId);
 assert.equal((await close(a,o.turnId,'interrupted')).settlement,'pending');
 return {a,id:o.turnId,provider:'gen-byok-'+o.turnId};
}
try{
 // 1. The user's charge and the stop-loss share of a BYOK call are those of the same call without BYOK; actual_usd and the split are kept.
 {
  const day=new Date(),from=new Date(day.getTime()-3600_000).toISOString(),to=new Date(day.getTime()+3600_000).toISOString();
  const actual=async()=>Number((await one('select turn_admin_model_report($1,$2) v',[from,to])).totals.actualUsd);
  const reported=await actual(),x=await settled(plain),y=await settled(byok);
  assert.ok((await charged(x.a,x.id))>0);
  assert.equal(await charged(y.a,y.id),await charged(x.a,x.id),'same charge');
  assert.equal(await spends(y.a),await spends(x.a),'same ledger spend');
  near(y.added,x.added,'same stop-loss share (the frozen list price)');
  near(y.added,0.01,'the stop-loss share is the list price of the tokens');
  const row=await callRow(y.id);
  assert.deepEqual([row.status,row.n,row.a],['ok','0.010000000000','0.010500000000']);
  assert.deepEqual(row.usage.byok,{feeUsd:'0.0005',upstreamUsd:'0.01'});
  near(await actual()-reported,0.0205,'the admin report counts the BYOK call at fee + upstream');
  report.checks.push('BYOK and non-BYOK calls with the same tokens: same charge, same ledger spend, same stop-loss share; actual = fee + upstream');
 }
 // 1b. One turn, two calls: the first served by the BYOK key, the second fell back to OpenRouter's credits (gifted credits ran out).
 // Each receipt keeps its own platform cost; the user's charge equals a turn with the same two calls and no BYOK.
 {
  const two=async(first,second)=>{
   const a=await account(),o=await open(a),before=await spent();
   await begin(a,o.turnId,1);await record(a,o.turnId,1,first);
   await begin(a,o.turnId,2);await record(a,o.turnId,2,second);
   await close(a,o.turnId);
   return {a,id:o.turnId,added:await spent()-before};
  };
  const mixed=await two(byok,plain),reference=await two(plain,plain);
  assert.equal(await charged(mixed.a,mixed.id),await charged(reference.a,reference.id),'same charge');
  near(mixed.added,reference.added,'same stop-loss share');
  const [first,second]=[await callRow(mixed.id,1),await callRow(mixed.id,2)];
  assert.deepEqual([first.a,second.a],['0.010500000000','0.010000000000']);
  assert.deepEqual([Boolean(first.usage.byok),Boolean(second.usage.byok)],[true,false]);
  report.checks.push('one turn with a BYOK call and a fallen-back call: each call keeps its own platform cost, the charge is unchanged');
 }
 // 2. An unusable BYOK call (charged by the provider, delivers nothing): the user pays 0, the stop-loss counts its whole cost.
 {
  const u=await settled(byok,'unusable');
  assert.equal(await spends(u.a),0);
  near(u.added,0.0105,'the whole BYOK cost, not the fee alone');
  report.checks.push('an unusable BYOK call counts fee + upstream toward the daily spend and charges the user nothing');
 }
 // 3. The same receipt twice is a no-op; a different receipt for the same call is refused.
 {
  const a=await account(),o=await open(a);
  await begin(a,o.turnId,1);
  await record(a,o.turnId,1,byok);await record(a,o.turnId,1,byok);
  assert.match(await refusal(record(a,o.turnId,1,byok,{payload:hash('other')})),/TURN_CALL_CONFLICT/);
  await close(a,o.turnId);
  const reference=await settled(plain);
  assert.equal(await spends(a),await spends(reference.a),'charged once');
  report.checks.push('a BYOK receipt recorded twice settles once; a conflicting one is refused');
 }
 // 4. Recovery and a late live receipt racing on the same unknown BYOK call, then two settle passes: one settlement.
 {
  const reference=await settled(plain),turns=[];
  for(let i=0;i<8;i++)turns.push(await unknown());
  const [p1,p2]=[await peer(),await peer()];
  try{
   const raced=await Promise.allSettled(turns.flatMap(t=>[
    record(t.a,t.id,1,byok,{payload:hash('live'+t.id),provider:t.provider,client:p1}),
    record(t.a,t.id,1,{...byok,usage:{...byok.usage,source:'lookup',nominalSource:'nominal'}},
     {payload:hash('lookup'+t.id),provider:t.provider,client:p2})]));
   assert.equal(raced.filter(r=>r.status==='fulfilled').length,8,'one receipt per call wins');
   assert.ok(raced.filter(r=>r.status==='rejected').every(r=>/TURN_CALL_CONFLICT/.test(r.reason.message)));
   const passes=await Promise.all(turns.flatMap(t=>[recover(t.a,t.id,p1),recover(t.a,t.id,p2)]));
   assert.equal(passes.filter(r=>!r.skipped).length,8,'one settle pass per turn');
  }finally{await p1.end();await p2.end();}
  for(const t of turns){
   assert.equal((await callRow(t.id)).a,'0.010500000000');
   assert.equal(await one('select settlement v from turns where actor_id=$1 and id=$2',[t.a.actor,t.id]),'done');
   assert.ok((await spends(t.a))<=(await spends(reference.a)),'never more than the same call without BYOK');
  }
  report.checks.push('live receipt and recovery racing on unknown BYOK calls: one receipt and one settlement each, never above the non-BYOK charge');
 }
 // 5. BYOK without the upstream amount writes no receipt (openRouterByok: missing cost): the call stays unknown for recovery.
 {
  const t=await unknown();
  assert.equal((await callRow(t.id)).status,'unknown');
  assert.equal(await charged(t.a,t.id),null,'nothing charged while the cost is unknown');
  report.checks.push('a BYOK call whose upstream cost is missing stays unknown and uncharged until recovery finds it');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
