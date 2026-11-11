/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CODE-HEALTH: usage_stats_for_user and usage_credit_summary_for_user, the numbers of the profile "使用统计" card and of "本月消耗".
// The counts come from the per-turn core (turns, session_messages), never from the retired chat tables; the totals are summed in
// the database, so a ledger longer than PostgREST's row cap is summed whole. Checked here: what counts as a conversation, a
// message and a day; one account never sees another's rows; the month boundary; reservations are not spend; a 1500-row ledger;
// nothing is written; only service_role may execute.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const DAY=864e5,now=Date.now();
const daysAgo=n=>new Date(now-n*DAY).toISOString();
async function account(){
 const actor=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,0)',[actor]);
 return actor;
}
async function session(actor){
 const id=randomUUID();
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [id,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return id;
}
// Rows are written directly: the functions under test only read, and turn_open would need a whole admission policy per kind.
const turn=async(actor,sessionId,kind,openedAt)=>one('insert into turns(actor_id,session_id,request_id,kind,opened_at) values($1,$2,$3,$4,$5) returning id v',
 [actor,sessionId,randomUUID(),kind,openedAt]);
let seq=0;
const message=(sessionId,turnId,role,extra={})=>c.query(
 'insert into session_messages(session_id,seq,role,turn_id,content,content_hash,visible,deleted_at) values($1,$2,$3,$4,$5,$6,$7,$8)',
 [sessionId,++seq,role,turnId,'text',hash('m'+seq),extra.visible??true,extra.deletedAt??null]);
const ledger=(actor,amount,type,ledgerType,reason,createdAt=new Date(now).toISOString())=>c.query(
 `insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after,created_at)
  values($1,$2,$3,$4,$5,'system',$6,0,0,$7)`,[actor,amount,type,ledgerType,reason,'probe:'+randomUUID(),createdAt]);
const usage=actor=>one('select usage_stats_for_user($1) v',[actor]);
const summary=(actor,from=null)=>one('select usage_credit_summary_for_user($1,$2) v',[actor,from]);
const written=()=>one(`select (select count(*) from turns)::int+(select count(*) from session_messages)::int
 +(select count(*) from credit_transactions)::int v`);
try{
 const a=await account(),b=await account(),empty=await account();
 // A: a chat conversation on day 10 with a report on day 7 in it, a mentor conversation on day 9, a compare-only conversation on
 // day 10, a scheduled review on day 5 and a voice profile on day 3.
 const chat=await session(a),mentor=await session(a),compare=await session(a),review=await session(a),voice=await session(a);
 const chatTurn=await turn(a,chat,'chat',daysAgo(10));
 await message(chat,chatTurn,'user');await message(chat,chatTurn,'assistant');
 const reportTurn=await turn(a,chat,'report',daysAgo(7));
 await message(chat,reportTurn,'assistant');
 const mentorTurn=await turn(a,mentor,'mentor',daysAgo(9));
 await message(mentor,mentorTurn,'user');
 await message(mentor,mentorTurn,'assistant',{deletedAt:daysAgo(8)});
 await message(mentor,mentorTurn,'assistant',{visible:false});
 await turn(a,compare,'compare',daysAgo(10));
 const reviewTurn=await turn(a,review,'review',daysAgo(5));
 await message(review,reviewTurn,'assistant');
 await turn(a,voice,'voice',daysAgo(3));
 // B: one chat turn today. It must never show up in A's numbers.
 const other=await session(b),otherTurn=await turn(b,other,'chat',daysAgo(0));
 await message(other,otherTurn,'user');
 let before=await written();
 assert.deepEqual(await usage(a),{conversations:3,messages:4,usageDays:4},
  'chat, mentor and compare sessions are conversations; the report message counts, the deleted, hidden and review ones do not; days 10, 9, 7 and 3');
 assert.deepEqual(await usage(b),{conversations:1,messages:1,usageDays:1});
 assert.deepEqual(await usage(empty),{conversations:0,messages:0,usageDays:0},'an account that never opened a turn has real zeros');
 assert.deepEqual(await usage(randomUUID()),{conversations:0,messages:0,usageDays:0},'an unknown id reads nothing');
 report.checks.push('usage: conversations, messages and days from turns and session_messages; scheduled reviews, deleted and hidden messages left out; per account');
 // A conversation the user deleted keeps its turns: it still counts as a conversation, its removed messages do not.
 await c.query('update runtime_sessions set content_deleted_at=now() where id=$1',[chat]);
 await c.query('delete from session_messages where session_id=$1',[chat]);
 assert.deepEqual(await usage(a),{conversations:3,messages:1,usageDays:4},'a deleted conversation still counts; its messages are gone');
 // The retired chat tables are not a source: rows there change nothing.
 const legacy=await one("select to_regclass('public.conversations') is not null v");
 if(legacy){
  await c.query('insert into conversations(id,user_id,title) values($1,$2,$3)',[randomUUID(),empty,'old']);
  assert.deepEqual(await usage(empty),{conversations:0,messages:0,usageDays:0},'a row of the retired conversations table is not counted');
 }
 report.checks.push('usage: a deleted conversation still counts without its messages; the retired chat tables are not read');

 // Ledger: A has an opening grant, a reservation and its release, two charges this month, one last month, and a refund clawback.
 const monthStart=new Date(Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),1));
 const lastMonth=new Date(monthStart.getTime()-DAY).toISOString();
 await ledger(a,500,'bonus','grant','opening_grant',lastMonth);
 await ledger(a,-60,'adjustment','adjustment','bill2_reserve');
 await ledger(a,60,'adjustment','adjustment','bill2_release');
 await ledger(a,-7,'consumption','spend','turn_spend');
 await ledger(a,-5,'consumption','spend','turn_spend');
 await ledger(a,-11,'consumption','spend','turn_spend',lastMonth);
 await ledger(a,-25,'refund','refund_clawback','refund_clawback');
 await ledger(b,-99,'consumption','spend','turn_spend');
 before=await written();
 const all=await summary(a);
 assert.deepEqual([all.totalEarned,all.totalSpent,all.transactionCount],[500,23,7],'all time: one grant, three charges; reservation, release and clawback are not spend');
 assert.deepEqual(all.byLedgerType,{grant:{count:1,amount:500},adjustment:{count:2,amount:0},spend:{count:3,amount:-23},refund_clawback:{count:1,amount:-25}});
 assert.deepEqual(all.byType,{bonus:{count:1,amount:500},adjustment:{count:2,amount:0},consumption:{count:3,amount:-23},refund:{count:1,amount:-25}});
 const month=await summary(a,monthStart.toISOString());
 assert.deepEqual([month.totalEarned,month.totalSpent,month.transactionCount],[0,12,5],'this calendar month: the two charges of this month only');
 assert.deepEqual([(await summary(b)).totalSpent,(await summary(empty)).totalSpent,(await summary(empty)).transactionCount],[99,0,0]);
 assert.deepEqual((await summary(empty)).byType,{},'an empty ledger has empty groups, not null');
 report.checks.push('ledger: earned is positive grants, spent is charged rows only, the month boundary, groups by type and ledger type, per account');
 // Longer than PostgREST's 1000-row cap: summed whole in the database.
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  select $1,-1,'consumption','spend','turn_spend','system','bulk:'||g,0,0 from generate_series(1,1500) g`,[empty]);
 assert.deepEqual([(await summary(empty)).totalSpent,(await summary(empty)).transactionCount],[1500,1500],'1500 charges are all summed');
 before=await written();
 await usage(a);await summary(a);await summary(a,monthStart.toISOString());
 assert.equal(await written(),before,'nothing was written');
 for(const fn of ['usage_stats_for_user(uuid)','usage_credit_summary_for_user(uuid,timestamptz)'])
  for(const [role,expected] of [['anon',false],['authenticated',false],['service_role',true]])
   assert.equal(await one("select has_function_privilege($1,'public.'||$2,'EXECUTE') v",[role,fn]),expected,role+' '+fn);
 report.checks.push('a 1500-row ledger is summed whole; nothing is written; only service_role may execute');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
