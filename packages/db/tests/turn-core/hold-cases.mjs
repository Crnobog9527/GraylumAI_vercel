/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Owner 11-01 "选 A 补冻" (0451): a chat or mentor turn opens with one call's bound and tops up in turn_call_begin.
// One call of these fixtures: bound 12 credits (upper 0.02 x q 100 x m 6), cost 6 (0.01).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function holdCases(t){
 const {c,one,open,begin,record,close,balance,account,policy,refusal,peer,report}=t;
 const hold=(over={})=>policy({gCredits:60,holdCredits:12,minCredits:10,uModelCredits:12,...over});
 const turnOf=(a,id)=>c.query('select state,pause_reason,reserved_credits,policy,charged_credits from turns where actor_id=$1 and id=$2',[a.actor,id]).then(r=>r.rows[0]);
 const spendRows=async(a,id)=>(await c.query("select amount,idempotency_key from credit_transactions where user_id=$1 and source_id=$2 and reason_code='turn_spend' order by idempotency_key",[a.actor,String(id)])).rows;
 const holds=a=>one("select count(*)::int v from billing_history where user_id=$1 and operation_type='pre_deduct'",[a.actor]);
 const settles=a=>one("select count(*)::int v from billing_history where user_id=$1 and operation_type='settle'",[a.actor]);
 const secondSession=async a=>{const id=randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [id,a.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);return id;};
 // Several calls: frozen one at a time, the charge is the usage, the rest returns, no pause.
 {
  const a=await account(1000),o=await open(a,{pol:hold()});
  assert.equal(o.reservedCredits,12,'the open froze one call, not G');
  assert.equal(await balance(a),988);
  assert.equal((await begin(a,o.turnId,1)).status,'dispatched');await record(a,o.turnId,1);
  assert.equal(await holds(a),1,'the first call is covered');
  assert.equal((await begin(a,o.turnId,2)).status,'dispatched','6 left of 12: topped up, not paused');
  const running=await turnOf(a,o.turnId);
  assert.equal(running.reserved_credits,24);assert.equal(running.policy.topUps.length,1);
  assert.equal(await balance(a),976);
  await record(a,o.turnId,2);
  const closed=await close(a,o.turnId);
  assert.equal(closed.chargedCredits,12);
  assert.equal(await balance(a),988,'the unused freeze came back');
  assert.equal(await settles(a),2,'every freeze settled');
  assert.equal((await spendRows(a,o.turnId)).reduce((n,r)=>n-r.amount,0),12);
  assert.equal(await one('select sum(amount)::int v from credit_transactions where user_id=$1',[a.actor]),988,'the records equal the balance');
  // Settled again: each part repeats, nothing moves.
  assert.equal((await close(a,o.turnId)).replay,true);assert.equal(await balance(a),988);assert.equal(await settles(a),2);
 }
 // Spilling into a top-up: each part has its own keys.
 {
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.02,actual:0.02});
  await begin(a,o.turnId,2);await record(a,o.turnId,2,{n:0.02,actual:0.02});
  assert.equal((await close(a,o.turnId)).chargedCredits,24);
  assert.deepEqual((await spendRows(a,o.turnId)).map(r=>[r.amount,r.idempotency_key]),
   [[-12,`turn:${o.turnId}:part1:spend`],[-12,`turn:${o.turnId}:spend`]]);
  assert.equal(await balance(a),976);
 }
 // A repeated begin freezes nothing more.
 {
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  const request='a'.repeat(64);
  await begin(a,o.turnId,2,{request});
  assert.equal((await begin(a,o.turnId,2,{request})).replay,true);
  assert.equal(await holds(a),2);
  assert.equal((await turnOf(a,o.turnId)).reserved_credits,24);
  await record(a,o.turnId,2);await close(a,o.turnId);
 }
 // A call the freeze covers never touches the account row: another transaction holds it and the begin goes through.
 {
  const a=await account(1000),o=await open(a,{pol:hold()}),p=await peer();
  try{
   await p.query('begin');await p.query('select 1 from profiles where id=$1 for update',[a.actor]);
   await c.query("set statement_timeout='3s'");
   assert.equal((await begin(a,o.turnId,1)).status,'dispatched');
   await c.query('reset statement_timeout');
   await p.query('rollback');
  }finally{await p.end();}
  await record(a,o.turnId,1);await close(a,o.turnId);
 }
 // Never beyond G; the balance short: paused, not overcharged; a top-up takes what there is, and L decides.
 {
  const a=await account(14),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  assert.equal(await balance(a),2);
  assert.equal((await begin(a,o.turnId,2)).paused,true,'6 + the last 2 < L 10: the balance cannot cover it');
  assert.equal(await balance(a),0,'the top-up took what there was');
  assert.equal((await close(a,o.turnId,'expired',{messages:[],delivered:false,refundAll:true})).chargedCredits,0);
  assert.equal(await balance(a),14,'and it returns with the rest');
 }
 {
  const a=await account(12),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  assert.equal((await begin(a,o.turnId,2)).paused,true,'nothing left to freeze: the only pause');
  assert.equal(await holds(a),1);
  const expired=await close(a,o.turnId,'expired',{messages:[],delivered:false,refundAll:true});
  assert.equal(expired.chargedCredits,0);assert.equal(await balance(a),12,'expiry returns everything');
 }
 {
  const a=await account(1000),o=await open(a,{pol:hold({gCredits:18})});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.02,actual:0.02});
  await begin(a,o.turnId,2,{upper:0.01});
  assert.equal((await turnOf(a,o.turnId)).reserved_credits,18,'G caps the top-ups');
  await record(a,o.turnId,2,{n:0.005,actual:0.005});await close(a,o.turnId);
 }
 // Failed, interrupted by refund, unknown cost: every freeze comes back or waits, once.
 {
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);await begin(a,o.turnId,2);await record(a,o.turnId,2);
  assert.equal((await close(a,o.turnId,'failed',{messages:[],delivered:false,refundAll:true})).chargedCredits,0);
  assert.equal(await balance(a),1000);assert.equal(await settles(a),2);
  const u=await account(1000),k=await open(u,{pol:hold()});
  await begin(u,k.turnId,1);await record(u,k.turnId,1);await begin(u,k.turnId,2); // no receipt: the cost is unknown
  const pending=await close(u,k.turnId,'interrupted',{messages:[],delivered:false});
  assert.equal(pending.settlement,'pending');assert.equal(await settles(u),0,'nothing settles before the cost is known');
  await record(u,k.turnId,2);
  const late=await close(u,k.turnId,'interrupted',{messages:[],delivered:false});
  // Owner 2026-11-11: the turn was cut off, so its two receipts (12 credits) are not charged; both freezes still settle once and return.
  assert.equal(late.chargedCredits,0);assert.equal(await settles(u),2);assert.equal(await balance(u),1000);
 }
 // A paused turn with a top-up, resumed: its freezes return, what it owes is carried and settled once.
 {
  const a=await account(30),o=await open(a,{pol:hold({limits:{model:6,paidTools:2,freeTools:3}})});
  const raw='{"choices":[{"message":{"content":"x"}}]}';
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{raw});
  await begin(a,o.turnId,2);await record(a,o.turnId,2,{raw});
  await c.query("update profiles set credits=0 where id=$1",[a.actor]);
  await begin(a,o.turnId,3);await record(a,o.turnId,3,{raw});
  assert.equal((await begin(a,o.turnId,4)).paused,true);
  await c.query("update profiles set credits=500 where id=$1",[a.actor]);
  await c.query('set role service_role');
  const next=await one('select turn_open($1,$2,$3,$4,$5,$6) v',[a.actor,a.session,randomUUID(),'chat',JSON.stringify(hold({limits:{model:2,paidTools:0,freeTools:1}})),o.turnId]);
  await c.query('reset role');
  const held=await turnOf(a,o.turnId);
  assert.equal(held.state,'closed');assert.equal(held.charged_credits,0);
  await begin(a,next.turnId,1);await record(a,next.turnId,1);
  const end=await close(a,next.turnId);
  assert.equal(end.chargedCredits,24,'18 carried plus 6');
  assert.equal(await balance(a),500,'both freezes of the paused turn came back (24), the chain paid 24 once');
 }
 // Two conversations on one balance: the second opens while the first runs, which G frozen would refuse; both settle.
 {
  const a=await account(40),first=await open(a,{pol:hold()}),session=await secondSession(a);
  const second=await open(a,{session,pol:hold()});
  assert.equal(await balance(a),16);
  await begin(a,first.turnId,1);await record(a,first.turnId,1);await begin(a,second.turnId,1);await record(a,second.turnId,1);
  await close(a,first.turnId);await close(a,second.turnId);
  assert.equal(await balance(a),28);
  // The same with G frozen, as a fixed-price kind stays.
  const b=await account(60),big=await open(b,{pol:policy({gCredits:60,minCredits:10})});
  assert.match(await refusal(open(b,{session:await secondSession(b),pol:policy({gCredits:60,minCredits:10})})),/TURN_INSUFFICIENT_CREDITS/);
  await close(b,big.turnId,'failed',{messages:[],delivered:false,refundAll:true});
 }
 // Two top-ups racing for the last credits of the balance: serial on the account, never negative.
 {
  const a=await account(30),x=await open(a,{pol:hold()}),y=await open(a,{session:await secondSession(a),pol:hold()});
  await begin(a,x.turnId,1);await record(a,x.turnId,1);await begin(a,y.turnId,1);await record(a,y.turnId,1);
  const p1=await peer(),p2=await peer();
  try{
   const [r1,r2]=await Promise.all([begin2(p1,a,x.turnId),begin2(p2,a,y.turnId)]);
   assert.ok([r1,r2].every(r=>r.status==='dispatched'||r.paused===true));
  }finally{await p1.end();await p2.end();}
  assert.ok(await balance(a)>=0);
 }
 // A close and a top-up of one turn at the same time: one lock order, no deadlock.
 {
  for(let i=0;i<4;i++){
   const a=await account(1000),o=await open(a,{pol:hold()});
   await begin(a,o.turnId,1);await record(a,o.turnId,1);
   const p1=await peer(),p2=await peer();
   try{
    const out=await Promise.allSettled([begin2(p1,a,o.turnId),one('select turn_close($1,$2,$3,$4,$5,$6,null) v',[a.actor,o.turnId,'failed','[]',false,true],p2)]);
    for(const r of out)if(r.status==='rejected')assert.doesNotMatch(r.reason.message,/deadlock/);
   }finally{await p1.end();await p2.end();}
  }
 }
 // Fixed-price kinds and plan: holdCredits refused, their freeze is G.
 for(const kind of ['report','compare','jury','jury_adopt','plan'])
  assert.match(await refusal(open(await account(1000),{kind,pol:hold()})),/TURN_POLICY_INVALID/,kind);
 assert.match(await refusal(open(await account(1000),{pol:hold({holdCredits:61})})),/TURN_POLICY_INVALID/);
 assert.match(await refusal(open(await account(1000),{pol:hold({topUps:[]})})),/TURN_POLICY_INVALID/);
 {
  const a=await account(1000),m=await open(a,{kind:'chat',pol:hold({holdCredits:60})});
  assert.equal(m.reservedCredits,60);await close(a,m.turnId,'failed',{messages:[],delivered:false,refundAll:true});
 }
 // creditsLow reads the balance a turn can still freeze.
 {
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);
  assert.equal((await record(a,o.turnId,1)).creditsLow,false,'6 left of the freeze, plenty of balance');
  await close(a,o.turnId);
  const b=await account(12),k=await open(b,{pol:hold()});
  await begin(b,k.turnId,1);
  assert.equal((await record(b,k.turnId,1)).creditsLow,true,'6 left, no balance');
  await close(b,k.turnId);
 }
 // The billing summary: a turn settled in parts counts its tool once, and still does once an erasure took turnId off the ledger rows.
 {
  const summary=()=>one("select research_billing_summary(now()-interval '1 day',now()+interval '1 minute') v");
  const a=await account(1000),before=await summary(),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1,{n:0.02,actual:0.02});
  await begin(a,o.turnId,2,{kind:'tool',paid:true,upper:0.01});await record(a,o.turnId,2,{n:0.01,actual:0.01});
  await c.query("update turn_calls set usage=$3 where turn_id=$1 and seq=$2",[o.turnId,2,JSON.stringify({results:[{outcome:'ok',items:3}]})]);
  await begin(a,o.turnId,3);await record(a,o.turnId,3);
  assert.equal((await close(a,o.turnId)).chargedCredits,24);
  assert.equal(await settles(a),3,'the charge crossed into the top-ups');
  const delta=now=>[now.count-before.count,now.credits-before.credits,now.turnOtherCredits-before.turnOtherCredits];
  assert.deepEqual(delta(await summary()),[1,6,18]);
  await c.query("update profiles set status='deleted',is_deleted='true',deleted_at=now() where id=$1",[a.actor]);
  await c.query("insert into account_erasure_requests(profile_id,request_id,confirmed_at) values($1,$2,now()-interval '1 minute')",[a.actor,randomUUID()]);
  await one("select account_erasure_scrub_ledger($1,'billing_history',100) v",[a.actor]);
  assert.equal(await one("select count(*)::int v from billing_history where user_id=$1 and operation_type='settle' and metadata ? 'turnId'",[a.actor]),0,'the erasure took turnId off');
  assert.deepEqual(delta(await summary()),[1,6,18],'the same after an erasure');
 }
 // The ledger: sources and records reconcile for this run's accounts.
 {
  const r=await one("select billing_reconcile_day(now()-interval '1 day',now()+interval '1 minute') v");
  assert.deepEqual([r.sources.mismatched,r.entries.notApplied],[0,0],JSON.stringify(r.sources));
 }
 // The turn ledger (V2-12 R7): every settled turn's spend rows equal what it charged; a changed row is named.
 {
  const day=()=>one("select billing_reconcile_day(now()-interval '1 day',now()+interval '1 minute') v").then(r=>r.turns);
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  assert.equal((await close(a,o.turnId)).chargedCredits>0,true);
  const ok=await day();
  assert.ok(ok.settledTurns>=1);assert.equal(ok.mismatched,0,'balanced: '+JSON.stringify(ok.sample));
  const row=await c.query("select id,amount from credit_transactions where user_id=$1 and source_type='ai_task' and source_id=$2 and reason_code='turn_spend'",[a.actor,String(o.turnId)]);
  assert.equal(row.rowCount,1);
  await c.query("update credit_transactions set amount=amount+1 where id=$1",[row.rows[0].id]);
  try{
   const bad=await day();
   assert.equal(bad.mismatched,1,'unbalanced');
   assert.deepEqual([bad.sample[0].actorId,String(bad.sample[0].turnId)],[a.actor,String(o.turnId)]);
  }finally{await c.query("update credit_transactions set amount=$2 where id=$1",[row.rows[0].id,row.rows[0].amount]);}
  assert.equal((await day()).mismatched,0,'balanced again');
 // A turn whose paid tool cost is still unknown is settled for the user (charged) while its settlement stays pending: it is checked too.
 {
  const win=()=>one("select billing_reconcile_day(now()-interval '1 day',now()+interval '1 minute') v").then(r=>r.turns);
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);
  await begin(a,o.turnId,2,{kind:'tool',paid:true,upper:0.01});
  await close(a,o.turnId);
  const row=(await c.query("select settlement,charged_credits from turns where actor_id=$1 and id=$2",[a.actor,o.turnId])).rows[0];
  assert.equal(row.settlement,'pending');assert.notEqual(row.charged_credits,null);
  const spend=await c.query("select id,amount from credit_transactions where user_id=$1 and source_type='ai_task' and source_id=$2 and reason_code='turn_spend'",[a.actor,String(o.turnId)]);
  assert.equal(spend.rowCount,1);
  await c.query("update credit_transactions set amount=amount+1 where id=$1",[spend.rows[0].id]);
  try{assert.ok((await win()).sample.some(s=>String(s.turnId)===String(o.turnId)),'a charged turn with a pending provider cost is checked');}
  finally{await c.query("update credit_transactions set amount=$2 where id=$1",[spend.rows[0].id,spend.rows[0].amount]);}
 }
 // V2-12: the platform-absorbed cost report reads turns (same row shape as the BILL2 one), and the session scope read is narrow.
 {
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);await close(a,o.turnId);
  await c.query("update turns set absorbed_credits=7 where actor_id=$1 and id=$2",[a.actor,o.turnId]);
  const rows=(await c.query("select * from turn_platform_absorb_report(now()-interval '1 day',now()+interval '1 minute')")).rows;
  const mine=rows.filter(r=>r.platform_cap_credits==='7');
  assert.equal(mine.length>=1,true,'the absorbed turn is reported: '+JSON.stringify(rows));
  assert.equal(mine[0].platform_bound_credits,'0');assert.equal(mine[0].call_multiplier,'1');assert.match(mine[0].utc_date,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(Number(mine[0].credits_per_usd)>0,true);
  assert.match(await refusal(one('select runtime_session_scope($1,$2) v',[(await account(10)).actor,a.session])),/RUNTIME_SCOPE_DENIED/);
 }
 // A turn closed on an earlier day and settled now (recovery) is checked where it was settled, not where it closed.
 {
  const win=(from,to)=>one("select billing_reconcile_day(now()-$1::interval,now()-$2::interval) v",[from,to]).then(r=>r.turns);
  const a=await account(1000),o=await open(a,{pol:hold()});
  await begin(a,o.turnId,1);await record(a,o.turnId,1);await close(a,o.turnId);
  await c.query("update turns set closed_at=now()-interval '3 days' where actor_id=$1 and id=$2",[a.actor,o.turnId]);
  const row=await c.query("select id,amount from credit_transactions where user_id=$1 and source_type='ai_task' and source_id=$2 and reason_code='turn_spend'",[a.actor,String(o.turnId)]);
  await c.query("update credit_transactions set amount=amount+1 where id=$1",[row.rows[0].id]);
  try{
   const now=await win('1 day','-1 minute'),past=await win('10 days','5 days');
   assert.ok(now.sample.some(s=>String(s.turnId)===String(o.turnId)),'found in the window of its settlement though it closed 3 days ago');
   assert.ok(!past.sample.some(s=>String(s.turnId)===String(o.turnId)),'not in a window before its settlement');
  }finally{await c.query("update credit_transactions set amount=$2 where id=$1",[row.rows[0].id,row.rows[0].amount]);}
 }
 }
 report.checks.push('hold top-up: one call frozen at the open, topped up in begin, charge = usage, each freeze settled once with its own keys',
  'hold top-up: no account lock when covered, paused only when the balance cannot, G caps it, repeat begin freezes nothing',
  'hold top-up: failed, expired, unknown cost and resume return or carry every freeze; two conversations share a balance; fixed kinds unchanged; ledger reconciles');
 function begin2(client,a,turn){return one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
  [a.actor,turn,2,'model',randomUUID(),null,null,'b'.repeat(63)+String(Number(turn)%10),0.02,6],client);}
}
