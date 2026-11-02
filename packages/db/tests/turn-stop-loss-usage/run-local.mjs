/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-12 B10: runtime_stop_loss_usage reads daily_spend and the account's closed turns. What is spent (known cost of closed
// turns) and what is only reserved (upper bounds held for open turns) are reported apart; the reservation is never shown as spent.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const policy={q:100,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:200,inputBytes:1000,
 limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5}};
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
const begin=(a,turn,seq=1)=>one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[a.actor,turn,seq,'model',randomUUID(),null,null,hash('r'+turn+seq),0.02,6]);
const record=(a,turn,seq=1)=>one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',[a.actor,turn,seq,'ok',0.01,0.01,'{}',null,hash('p'+turn+seq),'RAW']);
const close=(a,turn)=>one("select turn_close($1,$2,'completed',$3,true,false,null) v",[a.actor,turn,JSON.stringify([{role:'user',content:'Q'},{role:'assistant',content:'A'}])]);
const usage=async(a)=>{await c.query('SET ROLE service_role');try{return await one('select runtime_stop_loss_usage($1) v',[a]);}finally{await c.query('RESET ROLE');}};
try{
 const a=await account(),b=await account();
 const empty=await usage(a.actor);
 assert.deepEqual([empty.userUsd,empty.siteUsd,empty.reservedUsd],['0','0','0'],'a day with no turns is zero, not missing');
 const done=await open(a);await begin(a,done.turnId);await record(a,done.turnId);await close(a,done.turnId);
 const other=await open(b);await begin(b,other.turnId);await record(b,other.turnId);await close(b,other.turnId);
 const held=await open(a);await begin(a,held.turnId);          // open: its upper bound is reserved, nothing is spent yet
 const u=await usage(a.actor);
 assert.equal(Number(u.userUsd),0.01,'the account\'s own closed turn only');
 assert.equal(Number(u.siteUsd),0.02,'both accounts\' closed turns, site-wide');
 assert.equal(Number(u.reservedUsd)>0,true,'the open turn\'s reservation is reported');
 assert.equal(Number(u.siteUsd)<Number(u.siteUsd)+Number(u.reservedUsd),true);
 assert.match(u.utcDate,/^\d{4}-\d{2}-\d{2}$/);
 report.checks.push('usage: own closed-turn cost, site-wide spent from daily_spend, open turn reservation apart; empty day is zero');
 assert.deepEqual(Object.keys(u).sort(),['reservedUsd','siteUsd','userUsd','utcDate']);
 assert.equal((await usage(null)).userUsd,'0','no account gives a zero user figure');
 await record(a,held.turnId);await close(a,held.turnId);
 const after=await usage(a.actor);
 assert.equal(Number(after.siteUsd),0.03);assert.equal(Number(after.reservedUsd),0,'closing settles the reservation into spent');
 report.checks.push('closing the open turn moves its reservation into spent');
 assert.equal(await one("select provolatile v from pg_proc where proname='runtime_stop_loss_usage'"),'s','read-only (stable)');
 for(const role of ['anon','authenticated'])
  assert.equal(await one("select has_function_privilege($1,'public.runtime_stop_loss_usage(uuid)','EXECUTE') v",[role]),false,role);
 report.checks.push('stable (read-only); not executable by anon or authenticated');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
