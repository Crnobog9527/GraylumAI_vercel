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
const record=(a,turn,seq=1,usage='{}',actual=0.01)=>one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[a.actor,turn,seq,'ok',0.01,actual,usage,null,hash('p'+turn+seq),'RAW']);
const close=(a,turn)=>one("select turn_close($1,$2,'completed',$3,true,false,null) v",[a.actor,turn,JSON.stringify([{role:'user',content:'Q'},{role:'assistant',content:'A'}])]);
const window=(days=1)=>[new Date(Date.now()-days*864e5).toISOString(),new Date(Date.now()+60e3).toISOString()];
try{
 const a=await account();
 // One finished turn (known cost) and one still running whose call has no cost yet.
 const done=await open(a);await begin(a,done.turnId);await record(a,done.turnId);await close(a,done.turnId);
 // A turn that only ran the positioning check (a decision call whose receipt names its own model) and then stopped.
 const check=await open(a);await begin(a,check.turnId,1,'decision');await record(a,check.turnId,1,JSON.stringify({model:'example/decisions'}));await close(a,check.turnId);
 // A call whose supplier cost never arrived: the nominal cost is the upper-bound fallback, the actual cost stays empty.
 const noActual=await open(a);await begin(a,noActual.turnId);await record(a,noActual.turnId,1,'{}',null);await close(a,noActual.turnId);
 // A decision call whose receipt names no model is never attributed to the turn's main model.
 const unnamed=await open(a);await begin(a,unnamed.turnId,1,'decision');await record(a,unnamed.turnId,1,'{}');await close(a,unnamed.turnId);
 const running=await open(a);await begin(a,running.turnId);
 const [from,to]=window();
 let before=await one('select (select count(*) from turns)::int+(select count(*) from turn_calls)::int v');
 const r=await one('select turn_admin_model_report($1,$2) v',[from,to]);
 assert.deepEqual(r.models.map(m=>m.model).sort(),['decision (model not recorded)','example/decisions','example/model'],'decision calls are their own model lines, never the main model');
 const main=r.models.find(m=>m.model==='example/model'),decision=r.models.find(m=>m.model==='example/decisions');
 assert.deepEqual([main.calls,main.unknownCostCalls,main.unknownActualCalls],[3,1,2],'the in-flight call and the call without an actual cost are counted unknown apart');
 assert.equal(Number(main.nominalUsd),0.02,'only the known cost is summed');
 assert.deepEqual([decision.calls,decision.unknownCostCalls,decision.unknownActualCalls,Number(decision.nominalUsd)],[1,0,0,0.01],'the positioning check is counted and costed');
 assert.deepEqual([r.totals.calls,r.totals.unknownCostCalls,r.totals.unknownActualCalls,r.totals.turns,r.totals.unsettledTurns],[5,1,2,5,1]);
 assert.equal(Number(r.totals.nominalUsd),0.04);
 assert.equal(r.models.find(m=>m.model==='decision (model not recorded)').calls,1);
 assert.equal(r.byDate.length,1);
 report.checks.push('model report: calls grouped by model, the call without a cost counted unknown and not summed, the open turn counted unsettled');
 const u=await one('select turn_admin_unsettled_turns(100) v');
 assert.equal(u.total,1);assert.equal(u.turns[0].turnId,running.turnId);assert.equal(u.turns[0].inFlightCalls,1);
 assert.equal(u.turns[0].refundEligible,false,"a turn opened a moment ago is not eligible for the admin refund");
 assert.deepEqual(Object.keys(u.turns[0]).sort(),['actorId','chargedCredits','closeKind','costPendingCalls','failureCode','inFlightCalls','kind','openedAt','refundEligible','reservedCredits','settlement','state','turnId','updatedAt']);
 // A close with the call's cost still unknown stays on the list (settling); once the cost is recorded the turn settles and leaves.
 await close(a,running.turnId);
 assert.equal((await one('select turn_admin_unsettled_turns(100) v')).total,1,'closed but its call cost is unknown: still settling');
 await record(a,running.turnId);
 await c.query("update turns set settlement='done' where id=$1 and settlement='pending'",[running.turnId]);
 assert.equal((await one('select turn_admin_unsettled_turns(100) v')).total,0,'a closed, settled turn leaves the list');
 assert.equal((await one('select turn_admin_unsettled_turns(0) v')).turns.length,0);
 report.checks.push('unsettled list: the open turn with its in-flight call, content-free keys only, still listed while closed with an unknown cost, gone once settled');
 // The admin cost monitor reads the same calls as rows shaped like token_stats: one per known, spent model or decision call, the turn's
 // charged credits on its first row only, so sums by day, user or window are right.
 const two=await open(a);await begin(a,two.turnId);await record(a,two.turnId);await begin(a,two.turnId,2);await record(a,two.turnId,2);await close(a,two.turnId);
 before=await one('select (select count(*) from turns)::int+(select count(*) from turn_calls)::int v');
 const rowsOf=async()=>(await c.query('select * from turn_admin_cost_rows($1,$2) order by call_key',[from,to])).rows;
 const rows=await rowsOf();
 assert.equal(rows.length,7,'every ok model or decision call is a row, in-flight and failed ones are not');
 assert.ok(rows.every(row=>row.user_id===a.actor&&row.cached_tokens===null&&row.input_tokens===null&&row.created_at instanceof Date));
 assert.equal(rows.reduce((n,row)=>n+row.total_credits,0),await one('select coalesce(sum(charged_credits),0)::int v from turns where actor_id=$1',[a.actor]),
  "credits are the turns' charged credits, counted once per turn");
 const twoRows=rows.filter(row=>row.call_key.startsWith(two.turnId+':'));
 assert.deepEqual(twoRows.map(row=>row.total_credits>0),[true,false],'the charged credits sit on the first call only');
 assert.deepEqual(rows.map(row=>row.model_used).sort().filter((m,i,all)=>all.indexOf(m)===i),['decision (model not recorded)','example/decisions','example/model']);
 assert.equal(Number(rows.find(row=>row.model_used==='example/decisions').total_cost_usd),0.01);
 assert.equal(rows.reduce((n,row)=>n+Number(row.total_cost_usd),0).toFixed(2),
  Number(await one('select coalesce(sum(turn_call_spent_usd(call_kind,nominal_usd,actual_usd)),0) v from turn_calls where status=\'ok\'')).toFixed(2),'the cost is the cost the turn closed with');
 assert.equal((await c.query('select * from turn_admin_cost_rows($1,$2)',[new Date(Date.now()-5*864e5).toISOString(),new Date(Date.now()-4*864e5).toISOString()])).rows.length,0,'a window without calls is empty');
 // A turn whose calls straddle the window edge: the credits stay on its first call whatever window is asked for.
 await c.query("update turn_calls set dispatched_at=dispatched_at-interval '2 days' where turn_id=$1 and seq=1",[two.turnId]);
 const cut=new Date(Date.now()-864e5).toISOString();
 const late=(await c.query('select * from turn_admin_cost_rows($1,$2) where call_key=$3',[cut,to,two.turnId+':2'])).rows;
 assert.deepEqual(late.map(row=>row.total_credits),[0],'the later call of a straddling turn never picks up the credits when its first call is outside the window');
 const wide=(await c.query('select * from turn_admin_cost_rows($1,$2) where call_key=any($3)',[new Date(Date.now()-5*864e5).toISOString(),to,[two.turnId+':1',two.turnId+':2']])).rows;
 assert.equal(wide.reduce((n,row)=>n+row.total_credits,0),twoRows.reduce((n,row)=>n+row.total_credits,0),'a wider window counts the turn credits once');
 report.checks.push('cost rows: one per spent call in token_stats shape, credits once per turn, decision calls under their own model, empty window is empty');
 for(const [f,t] of [[to,from],[from,from],[new Date(Date.now()-93*864e5).toISOString(),to],[null,to]])
  for(const fn of ['turn_admin_model_report','turn_admin_cost_rows'])assert.match(await refusal(c.query('select * from '+fn+'($1,$2)',[f,t])),/TURN_REPORT_WINDOW_INVALID/);
 assert.equal(await one('select (select count(*) from turns)::int+(select count(*) from turn_calls)::int v'),before+0,'nothing was written');
 for(const fn of ['turn_admin_model_report(timestamptz,timestamptz)','turn_admin_cost_rows(timestamptz,timestamptz)','turn_admin_unsettled_turns(integer)'])
  for(const [role,expected] of [['anon',false],['authenticated',false],['service_role',true]])
   assert.equal(await one("select has_function_privilege($1,'public.'||$2,'EXECUTE') v",[role,fn]),expected,role+' '+fn);
 report.checks.push('bad windows (reversed, empty, over 92 days, null) refused; nothing written; only service_role may execute');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
