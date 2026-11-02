/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 money and entitlement regression on the new path (turns): a chargeback and a renewal landing while a turn holds a
// freeze from the disputed period, in both commit orders (the turn closing in the middle), and the Gold-only gate of the jury,
// compare and report entries while a chargeback holds the membership. Local PostgreSQL only: no Stripe, no provider call.
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import {addUtcMonths} from '../utc-months.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
export async function turnMoneyCases({c,v,receive,withdraw,ops,report,member,facts,start,nextEnd}) {
 const priorStart=addUtcMonths(start,-1);
 const q=100,m=6;
 const credits=user=>v('SELECT credits v FROM profiles WHERE id=$1',[user]);
 const ledger=user=>v('SELECT coalesce(sum(amount),0)::int v FROM credit_transactions WHERE user_id=$1',[user]);
 const policy=(over={})=>({q,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:100,inputBytes:1000,
  limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5},...over});
 const session=async user=>{const id=randomUUID();
  await c.query("INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload) VALUES($1,$2,$3,$4,'{}')",
   [id,user,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);return id;};
 const asService=async(client,sql,args)=>{await client.query('SET ROLE service_role');try{return await v(sql,args,client);}finally{await client.query('RESET ROLE');}};
 const open=async(user,sid,pol=policy(),kind='chat',client=c)=>asService(client,'SELECT turn_open($1,$2,$3,$4,$5) v',[user,sid,randomUUID(),kind,JSON.stringify(pol)]);
 const call=async(user,turn)=>{
  await v('SELECT turn_call_begin($1,$2,1,$3,$4,null,null,$5,0.1,$6) v',[user,turn,'model',randomUUID(),hash('r'+turn),m]);
  await v('SELECT turn_call_record($1,$2,1,$3,$4,$5,$6,null,$7,$8) v',[user,turn,'ok',0.01,0.01,JSON.stringify({cache_read:0}),hash('p'+turn),'body']);
 };
 const close=(user,turn,client=c)=>v("SELECT turn_close($1,$2,'completed',$3,true,false,null) v",
  [user,turn,JSON.stringify([{role:'user',content:'hi'},{role:'assistant',content:'hello'}])],client);
 const renew=(mm,tag,client=c)=>v('SELECT pay_dispute_renew($1) v',[{subscription:mm.sub,subscriptionId:mm.providerSub,merchant:'fixture',mode:'test',
  invoiceId:`in_${tag}_`+mm.sub.replaceAll('-',''),paymentIntentId:`pi_${tag}_`+mm.sub.replaceAll('-',''),amount:1000,currency:'usd',
  paidAt:start,start,end:nextEnd}],client);
 const refusal=async promise=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
 const waitBlocked=async(waiterPids,blocker)=>{
  for(let i=0;i<200;i++){
   if(await v('SELECT bool_and(pg_backend_pid()=ANY(pg_blocking_pids(p))) v FROM unnest($1::int[]) p',[waiterPids],blocker))return;
   await new Promise(r=>setTimeout(r,5));
  }
  assert.fail('the dispute and renewal transactions must wait on the lock the first one holds');
 };

 // 1. A turn holds 60 of the disputed period's 100 credits; the chargeback, the next period's renewal and the turn's close all
 // arrive together. Whatever commits first, the records add up to the balance, nothing goes negative, the renewal is delivered at
 // most once and the turn is charged its 6 once.
 for(const disputeFirst of [true,false]) {
  const mm=await member(priorStart,start),sid=await session(mm.user);
  const o=await open(mm.user,sid);
  assert.equal(o.reservedCredits,60);assert.equal(await credits(mm.user),40,'the open froze 60 of the period');
  await call(mm.user,o.turnId);
  const blocker=new pg.Client(c.connectionParameters),second=new pg.Client(c.connectionParameters),third=new pg.Client(c.connectionParameters);
  await Promise.all([blocker.connect(),second.connect(),third.connect()]);
  try {
   await blocker.query('BEGIN');
   const first=disputeFirst?await receive(mm,{subscriptionId:mm.providerSub},blocker):await renew(mm,'t',blocker);
   const waiting=Promise.allSettled([disputeFirst?renew(mm,'t',second):receive(mm,{subscriptionId:mm.providerSub},second),close(mm.user,o.turnId,third)]);
   await waitBlocked([second.processID],blocker);
   await blocker.query('COMMIT');
   const outcome=await waiting;
   for(const r of outcome)assert.equal(r.status,'fulfilled',r.reason?.message);
   assert.ok(first);
  } finally {await blocker.query('ROLLBACK').catch(()=>{});await Promise.all([blocker.end(),second.end(),third.end()]);}
  const turn=(await c.query('SELECT state,close_kind,charged_credits FROM turns WHERE id=$1',[o.turnId])).rows[0];
  assert.equal(turn.state,'closed');assert.equal(Number(turn.charged_credits),6,'the turn is charged its usage once');
  assert.ok(await credits(mm.user)>=0,'the balance never goes negative');
  assert.equal(await credits(mm.user),await ledger(mm.user),'the credit records add up to the balance');
  assert.equal(await v('SELECT count(*)::int v FROM payment_disputes WHERE order_id=$1',[mm.order]),1);
  assert.equal(await v("SELECT count(*)::int v FROM credit_transactions WHERE source_order_id=$1 AND reason_code='dispute_freeze'",[mm.order]),1,'frozen once');
  assert.equal(await v('SELECT count(*)::int v FROM payment_orders WHERE user_id=$1 AND id<>$2',[mm.user,mm.order]),1,'one renewal order');
  const before=await credits(mm.user);
  assert.equal((await close(mm.user,o.turnId)).replay,true);await renew(mm,'t');
  assert.equal(await credits(mm.user),before,'a replayed close or renewal moves nothing');
  const spend=await v("SELECT coalesce(sum(-amount),0)::int v FROM credit_transactions WHERE user_id=$1 AND reason_code='turn_spend'",[mm.user]);
  assert.equal(spend,6);
 }
 report.checks.push('turns: chargeback, renewal and an open turn close together in both commit orders: records equal the balance, never negative, one freeze, one renewal, turn charged once');

 // 2. Gold only while a chargeback holds the membership: the jury and compare entries (turn_fusion_open) and the report entry
 // (report_membership_check) refuse with nothing frozen and no turn; the withdrawal gives the entries back.
 {
  await c.query("UPDATE membership_plans SET allow_fusion_review=true,allow_fusion_compare=true WHERE level='gold'");
  const g=await member(start,addUtcMonths(start,1),'monthly','gold');
  await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[g.user]);
  const sid=await session(g.user);
  const review=async()=>{const id=randomUUID();
   await c.query(`INSERT INTO fusion_reviews(id,actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
    materials,materials_hash,config,state,round,phase,attempt) VALUES($1,$2,$3,$4,$5,$6,$7,'h','{}',$8,'{"maxRounds":2,"path":"turn"}','running',1,'review',1)`,
    [id,g.user,randomUUID(),randomUUID(),randomUUID(),sid,randomUUID(),hash('m')]);return id;};
  const stopLoss={limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5};
  const jury=()=>({q,uTurnUsd:0.7,gCredits:1680,minCredits:1680,fixedCredits:1500,uModelCredits:60,historyItems:0,inputBytes:1000,
   limits:{model:7,paidTools:0,freeTools:0,decisions:0},stopLoss});
  const compare=()=>({q,uTurnUsd:0.2,gCredits:120,minCredits:120,uModelCredits:60,historyItems:0,inputBytes:1000,
   limits:{model:2,paidTools:0,freeTools:0,decisions:0},stopLoss});
  const reviewId=await review();
  const openJury=()=>asService(c,'SELECT turn_fusion_open($1,$2,$3,$4,$5,$6) v',[g.user,sid,randomUUID(),'jury',JSON.stringify(jury()),
   JSON.stringify({reviewId})]);
  const openCompare=()=>asService(c,'SELECT turn_fusion_open($1,$2,$3,$4,$5,$6) v',[g.user,sid,randomUUID(),'compare',JSON.stringify(compare()),
   JSON.stringify({question:'q',questionHash:hash('q'),requestHash:hash('r'),snapshotHash:hash('s')})]);
  const reportCheck=()=>asService(c,'SELECT report_membership_check($1)::text v',[g.user]);
  await c.query('UPDATE profiles SET credits=5000 WHERE id=$1',[g.user]);
  await reportCheck();
  const wasGold=await v('SELECT membership_level v FROM profiles WHERE id=$1',[g.user]);
  assert.equal(wasGold,'gold');
  const d=await receive(g,{subscriptionId:g.providerSub});
  assert.equal((await facts(g.user)).internal_membership.membership_level,'free');
  const frozenBalance=await credits(g.user);
  assert.match(await refusal(reportCheck()),/REPORT_MEMBERSHIP_REQUIRED|REPORT_ENTITLEMENTS_UNAVAILABLE/,'the report entry is closed while the chargeback holds the membership');
  assert.match(await refusal(openJury()),/TURN_MEMBERSHIP_REQUIRED/,'the jury entry is closed');
  assert.match(await refusal(openCompare()),/TURN_MEMBERSHIP_REQUIRED/,'the compare entry is closed');
  assert.equal(await credits(g.user),frozenBalance,'a refused entry freezes nothing');
  assert.equal(await v('SELECT count(*)::int v FROM turns WHERE actor_id=$1',[g.user]),0,'and opens no turn');
  await withdraw(ops,d);
  assert.equal(await v('SELECT membership_level v FROM profiles WHERE id=$1',[g.user]),'gold','the withdrawal gives the Gold level back');
  await reportCheck();
  assert.equal((await openJury()).reviewId,reviewId,'the jury opens again once the chargeback is withdrawn');
  report.checks.push('turns: Gold-only jury, compare and report entries are refused while a chargeback holds the membership (nothing frozen, no turn) and open again after the withdrawal');
 }
}
