/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 (Owner 2026-11-11, deep review finding 9; migration turn_interrupted_no_charge): a turn that was cut off saved no
// answer, so the user pays nothing for it whatever its receipts say; the costs stay on the receipts, in the stop-loss and in
// absorbed_credits (Graylum bears them). Before, such a turn was charged min(N, H). The same answer whichever path settles the turn:
// the close itself, the recovery job, or the later settlement of a cost that became known; a repeat or a race changes nothing twice.
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
const policy={q:100,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:100,inputBytes:1000,
 limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5}};
async function account(credits=1000){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,$2)',[actor,credits]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session};
}
const open=a=>one('select turn_open($1,$2,$3,$4,$5,$6) v',[a.actor,a.session,randomUUID(),'chat',JSON.stringify(policy),null]);
const begin=(a,turn,seq)=>one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,'model',randomUUID(),null,null,hash('r'+turn+seq),0.02,6]);
const identity=(a,turn,seq,id='gen-'+turn+'-'+seq)=>one('select turn_call_identity($1,$2,$3,$4) v',[a.actor,turn,seq,id]);
// n = 0.01 USD: N = ceil(100 x 0.01 x 6) = 6 credits is what the receipt says.
const record=(a,turn,seq,n=0.01)=>one("select turn_call_record($1,$2,$3,'ok',$4,$4,'{}',null,$5,$6) v",
 [a.actor,turn,seq,n,hash('p'+turn+seq),'[{"choices":[]}]']);
const close=(a,turn,kind,{delivered=false,refundAll=false,client=c}={})=>
 one("select turn_close($1,$2,$3,'[]',$4,$5,null) v",[a.actor,turn,kind,delivered,refundAll],client);
const recover=(a,turn,action,client=c)=>one('select turn_recover($1,$2,$3) v',[a.actor,turn,action],client);
const age=(a,id,interval)=>c.query(`update turns set updated_at=now()-interval '${interval}' where actor_id=$1 and id=$2`,[a.actor,id]);
const turn=(a,id)=>c.query('select state,close_kind,charged_credits,absorbed_credits,settlement,delivered from turns where actor_id=$1 and id=$2',
 [a.actor,id]).then(r=>r.rows[0]);
const balance=a=>one('select credits v from profiles where id=$1',[a.actor]);
const ledger=a=>one('select count(*)::int v from credit_transactions where user_id=$1',[a.actor]);
const spends=a=>one("select coalesce(sum(-amount),0)::int v from credit_transactions where user_id=$1 and reason_code='turn_spend'",[a.actor]);
const spent=()=>one('select coalesce(sum(spent_usd),0)::float8 v from daily_spend');
const near=(x,y)=>Math.abs(x-y)<1e-9;
const charge=(a,id,kind,{delivered=false,refundAll=false}={})=>
 one('select turn_user_charge($1,$2,$3,$4,$5,6,60,null,now()) v',[a.actor,id,kind,delivered,refundAll]);
try{
 // 1. Normal: a turn cut off with a final receipt. The user pays nothing and gets the whole freeze back; the cost stays on record.
 {
  const a=await account(),before=await spent(),o=await open(a);
  assert.equal(await balance(a),940,'the freeze');
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  const closed=await close(a,o.turnId,'interrupted');
  assert.deepEqual([closed.closeKind,closed.chargedCredits,closed.absorbedCredits,closed.settlement],['interrupted',0,6,'done']);
  assert.equal(await balance(a),1000);assert.equal(await spends(a),0);
  assert.deepEqual(await turn(a,o.turnId),{state:'closed',close_kind:'interrupted',charged_credits:0,absorbed_credits:6,settlement:'done',delivered:false});
  // The receipt keeps what the provider charged, and the stop-loss counts it: Graylum bears it, on record.
  assert.deepEqual((await c.query('select status,nominal_usd::float8 n,actual_usd::float8 a from turn_calls where turn_id=$1',[o.turnId])).rows,
   [{status:'ok',n:0.01,a:0.01}]);
  assert.ok(near(await spent()-before,0.01),'the stop-loss counts the cost');
  // The same receipts on a turn whose answer was saved are charged as before: 6 credits.
  const b=await account(),ob=await open(b);
  await begin(b,ob.turnId,1);await record(b,ob.turnId,1);
  const done=await close(b,ob.turnId,'completed',{delivered:true});
  assert.deepEqual([done.chargedCredits,done.absorbedCredits],[6,0]);assert.equal(await balance(b),994);
  report.checks.push('an interrupted turn with a final receipt charges nothing and returns the freeze; the cost stays on the receipt and in the stop-loss; a completed turn is charged as before');
 }
 // 2. The platform stopped the function: the turn is left running and the recovery job ends it. Nothing charged either.
 {
  const a=await account(),o=await open(a);
  await begin(a,o.turnId,1);await record(a,o.turnId,1);await begin(a,o.turnId,2);await record(a,o.turnId,2,0.005);
  assert.equal((await recover(a,o.turnId,'interrupt')).skipped,true,'not before 15 idle minutes');
  assert.equal(await balance(a),940);
  await age(a,o.turnId,'16 minutes');
  const ended=await recover(a,o.turnId,'interrupt');
  // Two final receipts: N = ceil(100 x 0.015 x 6) = 9 credits, all absorbed.
  assert.deepEqual([ended.closeKind,ended.chargedCredits,ended.absorbedCredits,ended.settlement],['interrupted',0,9,'done']);
  assert.equal(await balance(a),1000);assert.equal(await spends(a),0);
  report.checks.push('a turn the recovery job had to end charges nothing, however many final receipts it has');
 }
 // 3. Failure with the cost unknown: the freeze waits for the cost (as every unknown model cost), then returns in full, once.
 {
  const a=await account(),o=await open(a);
  await begin(a,o.turnId,1);await identity(a,o.turnId,1);
  const first=await close(a,o.turnId,'interrupted');
  assert.deepEqual([first.chargedCredits,first.settlement],[null,'pending']);
  assert.equal(await balance(a),940,'the freeze stays while the model cost is unknown');
  await record(a,o.turnId,1);
  const settled=await recover(a,o.turnId,'settle');
  assert.deepEqual([settled.closeKind,settled.chargedCredits,settled.absorbedCredits,settled.settlement],['interrupted',0,6,'done']);
  assert.equal(await balance(a),1000);assert.equal(await spends(a),0);
  // Repeated: the settlement pass, the close and the recovery again change nothing.
  const rows=await ledger(a);
  assert.equal((await recover(a,o.turnId,'settle')).skipped,true);
  const again=await close(a,o.turnId,'interrupted');
  assert.deepEqual([again.replay,again.chargedCredits,again.settlement],[true,0,'done']);
  // A later close that asks for something else (a refund, a completed close) finds the turn settled and changes nothing.
  assert.deepEqual([(await close(a,o.turnId,'failed',{refundAll:true})).closeKind,(await close(a,o.turnId,'completed',{delivered:true})).closeKind],
   ['interrupted','interrupted']);
  assert.equal(await balance(a),1000);assert.equal(await ledger(a),rows);
  report.checks.push('with the model cost unknown the freeze waits, then returns in full once the cost is known; a repeat (settle, close, another close kind) changes nothing');
 }
 // 4. Concurrent: two closes of a running turn at once, and two settlement passes at once. Settled once each time.
 {
  const p1=await peer(),p2=await peer();
  try{
   const a=await account(),o=await open(a);
   await begin(a,o.turnId,1);await record(a,o.turnId,1);
   const both=await Promise.all([close(a,o.turnId,'interrupted',{client:p1}),close(a,o.turnId,'interrupted',{client:p2})]);
   assert.deepEqual(both.map(r=>r.replay).sort(),[false,true]);
   assert.deepEqual(both.map(r=>r.chargedCredits),[0,0]);
   assert.equal(await balance(a),1000);assert.equal(await spends(a),0);
   const b=await account(),ob=await open(b);
   await begin(b,ob.turnId,1);await identity(b,ob.turnId,1);await close(b,ob.turnId,'interrupted');await record(b,ob.turnId,1);
   const passes=await Promise.all([recover(b,ob.turnId,'settle',p1),recover(b,ob.turnId,'settle',p2)]);
   assert.deepEqual(passes.map(r=>Boolean(r.skipped)).sort(),[false,true]);
   assert.equal(await balance(b),1000);assert.equal(await spends(b),0);
   assert.deepEqual([(await turn(b,ob.turnId)).charged_credits,(await turn(b,ob.turnId)).settlement],[0,'done']);
  }finally{await p1.end();await p2.end();}
  report.checks.push('two closes at once and two settlement passes at once settle the turn once, with nothing charged');
 }
 // 5. The rule itself, and what it leaves alone: only an interrupted close that delivered nothing answers 0 here.
 {
  const a=await account(),o=await open(a);
  assert.equal(await charge(a,o.turnId,'interrupted'),0);
  assert.equal(await charge(a,o.turnId,'completed',{delivered:true}),6);
  assert.equal(await charge(a,o.turnId,'completed'),6,'a metered completed close is charged by its receipts as before');
  assert.equal(await charge(a,o.turnId,'failed'),6,'a failed close without a refund is charged as before');
  assert.equal(await charge(a,o.turnId,'failed',{refundAll:true}),0);
  assert.equal(await charge(a,o.turnId,'expired'),0);
  // A compare turn keeps its own rule (each column with a usable saved answer is paid; here it has none) and is not short-cut to 0 by
  // this one: the function still reads its columns.
  await c.query("update turns set kind='compare' where actor_id=$1 and id=$2",[a.actor,o.turnId]);
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  assert.equal(await charge(a,o.turnId,'interrupted'),0,'no usable column yet');
  await c.query("update turn_calls set answer_verdict='usable' where turn_id=$1 and seq=1",[o.turnId]);
  assert.equal(await charge(a,o.turnId,'interrupted'),6,'an interrupted compare still pays for a column whose answer was saved as usable');
  report.checks.push('only an interrupted, undelivered close answers 0; completed, failed, refunded and expired closes and a compare column saved as usable are as before');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
