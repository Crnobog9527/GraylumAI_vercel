/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Owner 11-01 "同意两项" (0453): a chat or mentor turn reserves one call's bound on the stop-loss at the open and tops up in
// turn_call_begin; the limit check is turn_open's. One call of these fixtures: bound 0.02 USD, 12 credits.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function stopLossCases(t){
 const {c,one,open,begin,identity,record,close,balance,account,policy,refusal,peer,report}=t;
 const limit=(limitUsd=1000,over={})=>({limitUsd,p:1,poolSize:1,uFastUsd:0.02,uBigUsd:0,...over});
 const hold=(stopLoss=limit(),over={})=>policy({gCredits:60,holdCredits:12,holdUsd:0.02,minCredits:10,uModelCredits:12,stopLoss,...over});
 const near=(x,y,what)=>assert.ok(Math.abs(Number(x)-Number(y))<1e-9,`${what}: ${x} vs ${y}`);
 const fresh=()=>c.query('delete from daily_spend');
 const day=async()=>(await c.query("select coalesce(sum(reserved_usd),0)::float8 r,coalesce(sum(spent_usd),0)::float8 s from daily_spend")).rows[0];
 const reserved=(a,id)=>one('select reserved_usd::float8 v from turns where actor_id=$1 and id=$2',[a.actor,id]);
 const calls=id=>one('select count(*)::int v from turn_calls where turn_id=$1',[id]);
 // Topped up only when a call is not covered; the close releases all of it.
 {
  await fresh();
  const a=await account(1000),o=await open(a,{pol:hold()});
  near(o.reservedUsd,0.02,'the open reserved one call, not U_turn');near((await day()).r,0.02,'the bucket');
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.001,actual:0.001});
  await begin(a,o.turnId,2,{upper:0.019});
  near(await reserved(a,o.turnId),0.02,'0.019 left covers it: no top-up');
  await record(a,o.turnId,2,{n:0.01,actual:0.01});
  await begin(a,o.turnId,3);
  near(await reserved(a,o.turnId),0.04,'0.009 left of 0.02: one more hold');near((await day()).r,0.04,'the bucket moved with the turn');
  await record(a,o.turnId,3,{n:0.01,actual:0.01});
  await close(a,o.turnId);
  const d=await day();near(d.r,0,'every reservation released');near(d.s,0.021,'spent');
 }
 // A repeated begin reserves nothing more; a free tool needs nothing; the positioning check counts.
 {
  await fresh();
  const a=await account(1000),o=await open(a,{pol:hold(limit(),{limits:{model:3,paidTools:1,freeTools:1,decisions:1}})});
  const request='a'.repeat(64);
  await begin(a,o.turnId,1,{kind:'decision',upper:0.015,request});
  assert.equal((await begin(a,o.turnId,1,{kind:'decision',upper:0.015,request})).replay,true);
  near(await reserved(a,o.turnId),0.02,'covered');
  await begin(a,o.turnId,2,{kind:'tool',paid:false,upper:0});
  near(await reserved(a,o.turnId),0.02,'a free tool reserves nothing');
  await begin(a,o.turnId,3);
  near(await reserved(a,o.turnId),0.04,'the check in flight is not free');
  await close(a,o.turnId,'interrupted',{messages:[],delivered:false});
  const d=await day();near(d.r,0.035,'two unknown costs stay reserved');
  await record(a,o.turnId,1,{n:0.001,actual:0.001});await record(a,o.turnId,3,{n:0.01,actual:0.01});
  await close(a,o.turnId,'interrupted',{messages:[],delivered:false});
  const after=await day();near(after.r,0,'recovery released the rest');near(after.s,0.011,'and counted what they cost');
 }
 // Refused mid-turn: nothing written, no credit moved; a failed close refunds the user and releases the reservation.
 {
  await fresh();
  const a=await account(1000),o=await open(a,{pol:hold(limit(0.03))});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.015,actual:0.015});
  const before=await balance(a);
  assert.match(await refusal(begin(a,o.turnId,2)),/STOP_LOSS_REACHED/);
  assert.equal(await calls(o.turnId),1,'no call row');
  near(await reserved(a,o.turnId),0.02,'the turn did not move');near((await day()).r,0.02,'the bucket rolled back');
  assert.equal(await balance(a),before,'the credit top-up rolled back too');
  assert.equal(await one('select reserved_credits v from turns where id=$1',[o.turnId]),12);
  const closed=await one("select turn_close($1,$2,'failed','[]',false,true,'stop_loss_reached') v",[a.actor,o.turnId]);
  assert.equal(closed.chargedCredits,0);assert.equal(await balance(a),1000);
  const d=await day();near(d.r,0,'released');near(d.s,0.015,'the cost stays counted');
 }
 // The band counts in the top-up as at the open: refused earlier, never later.
 {
  await fresh();
  const a=await account(1000),o=await open(a,{pol:hold(limit(0.05,{p:2,poolSize:2}))});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.015,actual:0.015});
  // 0.02 + 0.02 reserved + B 0.02 = 0.06 > 0.05, though 0.04 alone is under it.
  assert.match(await refusal(begin(a,o.turnId,2)),/STOP_LOSS_REACHED/);
  await close(a,o.turnId,'failed',{messages:[],delivered:false,refundAll:true});
 }
 // Failed, expired and erased closes release what was topped up.
 for(const kind of ['failed','expired','erased']){
  await fresh();
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.015,actual:0.015});
  await begin(a,o.turnId,2);await record(a,o.turnId,2,{n:0.015,actual:0.015});
  near(await reserved(a,o.turnId),0.04,'topped up');
  await close(a,o.turnId,kind,{messages:[],delivered:false,refundAll:true});
  near((await day()).r,0,kind);near(await balance(a),1000,kind);
 }
 // A resume chain: the paused turn's reservation goes back when the next one opens, and that one's at its close.
 {
  await fresh();
  const a=await account(30),o=await open(a,{pol:hold(limit(),{limits:{model:6,paidTools:2,freeTools:3}})});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.015,actual:0.015});
  await begin(a,o.turnId,2);await record(a,o.turnId,2,{n:0.015,actual:0.015});
  await c.query('update profiles set credits=0 where id=$1',[a.actor]);
  assert.equal((await begin(a,o.turnId,3)).paused,true);
  near(await reserved(a,o.turnId),0.04,'a pause reserves nothing for the call it stopped');
  await c.query('update profiles set credits=500 where id=$1',[a.actor]);
  await c.query('set role service_role');
  const next=await one('select turn_open($1,$2,$3,$4,$5,$6) v',[a.actor,a.session,randomUUID(),'chat',
   JSON.stringify(hold(limit(),{limits:{model:2,paidTools:0,freeTools:1}})),o.turnId]);
  await c.query('reset role');
  const mid=await day();near(mid.r,0.02,'only the new turn holds a reservation');near(mid.s,0.03,'the paused turn spent this');
  await begin(a,next.turnId,1);await record(a,next.turnId,1,{n:0.01,actual:0.01});
  await close(a,next.turnId);
  const d=await day();near(d.r,0,'the chain ends at zero');near(d.s,0.04,'every receipt once');
 }
 // Concurrent top-ups near the limit: what is reserved and spent never passes it, some are refused, and the closes end at zero.
 {
  await fresh();
  const L=0.17,stop=limit(L,{p:4,poolSize:4}),clients=await Promise.all(Array.from({length:4},peer));
  try{
   const accounts=[];for(let i=0;i<4;i++)accounts.push(await account());
   const opened=[];for(const a of accounts)opened.push(await open(a,{pol:hold(stop)}));
   for(const [i,o] of opened.entries()){await begin(accounts[i],o.turnId,1);await record(accounts[i],o.turnId,1,{n:0.019,actual:0.019});}
   const go=seq=>(cl,i)=>cl.query('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
    [accounts[i].actor,opened[i].turnId,seq,'model',randomUUID(),null,null,'b'.repeat(64),0.02,6]).then(()=>'ok',e=>e.message);
   const within=async()=>{const d=await day();assert.ok(d.r+d.s<=L+1e-9,`reserved ${d.r} + spent ${d.s} within L`);};
   // All four at once may pass, in different buckets: 0.16 reserved, and the band of 0.06 is what keeps that within L.
   const first=await Promise.all(clients.map(go(2)));await within();
   assert.ok(first.some(r=>r==='ok'),'below the limit passes');
   for(const [i,o] of opened.entries())if(first[i]==='ok')await record(accounts[i],o.turnId,2,{n:0.01,actual:0.01});
   const second=await Promise.all(clients.map(go(3)));await within();
   assert.ok(second.every(r=>/STOP_LOSS_REACHED|TURN_CALL_SEQUENCE/.test(r)),'near it every one is refused');
   for(const [i,o] of opened.entries())await close(accounts[i],o.turnId,'failed',{messages:[],delivered:false,refundAll:true});
   near((await day()).r,0,'every close released its reservation');
  }finally{await Promise.all(clients.map(cl=>cl.end()));}
 }
 // A call that is covered never takes the bucket row: another transaction holds it and the begin goes through.
 {
  await fresh();
  const a=await account(1000),o=await open(a,{pol:hold()}),p=await peer();
  try{
   await p.query('begin');await p.query('select 1 from daily_spend for update');
   await c.query("set lock_timeout='2s'");
   assert.equal((await begin(a,o.turnId,1)).status,'dispatched');
  }finally{await c.query('reset lock_timeout');await p.query('rollback');await p.end();}
  await record(a,o.turnId,1);await close(a,o.turnId);
 }
 // Across midnight: the top-up goes to the opening day's row, the one the close releases.
 {
  await fresh();
  const a=await account(1000),o=await open(a,{pol:hold()});
  await c.query("update turns set policy=jsonb_set(policy,'{day}',to_jsonb((current_date-1)::text)) where id=$1",[o.turnId]);
  await c.query("update daily_spend set day=current_date-1");
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.015,actual:0.015});
  await begin(a,o.turnId,2);await record(a,o.turnId,2,{n:0.015,actual:0.015});
  near(await one('select reserved_usd::float8 v from daily_spend where day=current_date-1'),0.04,'the opening day');
  await close(a,o.turnId);
  near(await one('select reserved_usd::float8 v from daily_spend where day=current_date-1'),0,'released there');
 }
 // What may carry holdUsd, and U_fast as the proof's bound.
 {
  await fresh();
  const bad=async(pol,code,kind='chat')=>assert.match(await refusal(open(await account(),{pol,kind})),code);
  await bad(hold(limit(1000,{uFastUsd:0.01})),/TURN_STOP_LOSS_CONFIG/);
  await bad(policy({holdUsd:0.02}),/TURN_POLICY_INVALID/);
  await bad(hold(limit(),{holdUsd:0.2}),/TURN_POLICY_INVALID/);
  await bad(hold(limit(),{holdUsd:'0.02'}),/TURN_POLICY_INVALID/);
  await bad(hold(),/TURN_POLICY_INVALID/,'plan');
  // Without it, as before: U_turn at the open, begin never reserves.
  const a=await account(1000),o=await open(a,{pol:policy({stopLoss:limit()})});
  near(o.reservedUsd,0.1,'U_turn');
  await begin(a,o.turnId,1);near(await reserved(a,o.turnId),0.1,'no top-up');
  await record(a,o.turnId,1);await close(a,o.turnId);near((await day()).r,0,'released');
  await fresh();
 }
 report.checks.push('stop-loss top-up: covered calls untouched, refusal writes nothing, band as at the open, every close and the resume chain end at zero',
  'stop-loss top-up: concurrent begins stay within L, a covered call never takes the bucket, the opening day keeps the row, only chat and mentor carry it');
}
