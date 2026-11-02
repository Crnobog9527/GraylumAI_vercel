/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-12 B10: the two read-only admin functions (turn_admin_model_report, turn_admin_unsettled_turns) on the core-path tables.
// Allow and deny: only service_role may call them; a window that is empty, reversed or over 92 days is refused; unknown costs are counted,
// never summed as zero; the unsettled list holds open turns and closed turns still settling, and nothing else; nothing is written.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const refusal=async(promise)=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const policy={q:100,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:200,inputBytes:1000,model:'example/model',
 limits:{model:3,decisions:1,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5}};
async function account(){
 const actor=randomUUID(),session=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,1000)',[actor]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`,[actor,'opening_grant:'+actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [session,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return {actor,session};
}
const open=(a)=>one('select turn_open($1,$2,$3,$4,$5) v',[a.actor,a.session,randomUUID(),'chat',JSON.stringify(policy)]);
const begin=(a,turn,seq=1,kind='model')=>one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[a.actor,turn,seq,kind,randomUUID(),null,null,hash('r'+turn+seq),0.02,6]);
const record=(a,turn,seq=1,usage='{}')=>one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[a.actor,turn,seq,'ok',0.01,0.01,usage,null,hash('p'+turn+seq),'RAW']);
const close=(a,turn)=>one("select turn_close($1,$2,'completed',$3,true,false,null) v",[a.actor,turn,JSON.stringify([{role:'user',content:'Q'},{role:'assistant',content:'A'}])]);
const window=(days=1)=>[new Date(Date.now()-days*864e5).toISOString(),new Date(Date.now()+60e3).toISOString()];
try{
 const a=await account();
 // One finished turn (known cost) and one still running whose call has no cost yet.
 const done=await open(a);await begin(a,done.turnId);await record(a,done.turnId);await close(a,done.turnId);
 // A turn that only ran the positioning check (a decision call whose receipt names its own model) and then stopped.
 const check=await open(a);await begin(a,check.turnId,1,'decision');await record(a,check.turnId,1,JSON.stringify({model:'example/decisions'}));await close(a,check.turnId);
 const running=await open(a);await begin(a,running.turnId);
 const [from,to]=window();
 const before=await one('select (select count(*) from turns)::int+(select count(*) from turn_calls)::int v');
 const r=await one('select turn_admin_model_report($1,$2) v',[from,to]);
 assert.deepEqual(r.models.map(m=>m.model).sort(),['example/decisions','example/model'],'the decision call is its own model line');
 const main=r.models.find(m=>m.model==='example/model'),decision=r.models.find(m=>m.model==='example/decisions');
 assert.deepEqual([main.calls,main.unknownCostCalls],[2,1],'the call without a cost is counted unknown');
 assert.equal(Number(main.nominalUsd),0.01,'only the known cost is summed');
 assert.deepEqual([decision.calls,decision.unknownCostCalls,Number(decision.nominalUsd)],[1,0,0.01],'the positioning check is counted and costed');
 assert.deepEqual([r.totals.calls,r.totals.unknownCostCalls,r.totals.turns,r.totals.unsettledTurns],[3,1,3,1]);
 assert.equal(Number(r.totals.nominalUsd),0.02);
 assert.equal(r.byDate.length,1);
 report.checks.push('model report: calls grouped by model, the call without a cost counted unknown and not summed, the open turn counted unsettled');
 const u=await one('select turn_admin_unsettled_turns(100) v');
 assert.equal(u.total,1);assert.equal(u.turns[0].turnId,running.turnId);assert.equal(u.turns[0].inFlightCalls,1);
 assert.deepEqual(Object.keys(u.turns[0]).sort(),['actorId','chargedCredits','closeKind','costPendingCalls','failureCode','inFlightCalls','kind','openedAt','reservedCredits','settlement','state','turnId','updatedAt']);
 // A close with the call's cost still unknown stays on the list (settling); once the cost is recorded the turn settles and leaves.
 await close(a,running.turnId);
 assert.equal((await one('select turn_admin_unsettled_turns(100) v')).total,1,'closed but its call cost is unknown: still settling');
 await record(a,running.turnId);
 await c.query("update turns set settlement='done' where id=$1 and settlement='pending'",[running.turnId]);
 assert.equal((await one('select turn_admin_unsettled_turns(100) v')).total,0,'a closed, settled turn leaves the list');
 assert.equal((await one('select turn_admin_unsettled_turns(0) v')).turns.length,0);
 report.checks.push('unsettled list: the open turn with its in-flight call, content-free keys only, still listed while closed with an unknown cost, gone once settled');
 for(const [f,t] of [[to,from],[from,from],[new Date(Date.now()-93*864e5).toISOString(),to],[null,to]])
  assert.match(await refusal(c.query('select turn_admin_model_report($1,$2)',[f,t])),/TURN_REPORT_WINDOW_INVALID/);
 assert.equal(await one('select (select count(*) from turns)::int+(select count(*) from turn_calls)::int v'),before+0,'nothing was written');
 for(const fn of ['turn_admin_model_report(timestamptz,timestamptz)','turn_admin_unsettled_turns(integer)'])
  for(const [role,expected] of [['anon',false],['authenticated',false],['service_role',true]])
   assert.equal(await one("select has_function_privilege($1,'public.'||$2,'EXECUTE') v",[role,fn]),expected,role+' '+fn);
 report.checks.push('bad windows (reversed, empty, over 92 days, null) refused; nothing written; only service_role may execute');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
