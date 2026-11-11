/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CODE-HEALTH: the three read-only functions behind the admin home, finance and performance pages on the per-turn core
// (turn_admin_usage_days, turn_admin_activity, admin_dashboard_stats). Checked: spent calls grouped by model and UTC day with the
// turn's credits counted once, days before the daily start folded into one row, an unknown token count staying unknown;
// conversations by their first turn, messages by side, finished calls with failures and duration; users, tickets and the ledger
// counted in the database (more rows than PostgREST's cap); bad windows refused; nothing written; only service_role may execute.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const hash=text=>createHash('sha256').update(text).digest('hex');
const refusal=async(promise)=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const DAY=864e5,now=Date.now();
const ago=(days,plusMs=0)=>new Date(now-days*DAY+plusMs).toISOString();
const utcDay=iso=>iso.slice(0,10);
const ALPHA=randomUUID(),BETA=randomUUID();
async function account(createdAt=ago(0)){
 const actor=randomUUID();
 await c.query('insert into profiles(id,credits,created_at) values($1,$2,$3)',[actor,100,createdAt]);
 return actor;
}
async function session(actor){
 const id=randomUUID();
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [id,actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return id;
}
// Rows are written directly: the functions under test only read, and the write path has its own suites (turn-core).
const turn=async(actor,sessionId,kind,openedAt,model,charged=null)=>one(
 'insert into turns(actor_id,session_id,request_id,kind,opened_at,policy,charged_credits) values($1,$2,$3,$4,$5,$6,$7) returning id v',
 [actor,sessionId,randomUUID(),kind,openedAt,JSON.stringify({model,models:{[ALPHA]:'example/alpha',[BETA]:'example/beta'}}),charged]);
let seqOf=new Map();
async function call(actor,turnId,{kind='model',model=ALPHA,status='ok',at,ms=1000,nominal=0.01,actual=0.01,usage={}}){
 const seq=(seqOf.get(turnId)??0)+1;seqOf.set(turnId,seq);
 const settled=['dispatched','identified'].includes(status)?null:new Date(Date.parse(at)+ms).toISOString();
 const inFlight=settled===null,free=['rejected','no_charge_402','not_sent'].includes(status);
 await c.query(`insert into turn_calls(actor_id,turn_id,seq,call_kind,model_id,status,request_hash,upper_usd,multiplier,nominal_usd,actual_usd,usage,dispatched_at,settled_at)
  values($1,$2,$3,$4,$5,$6,$7,1,6,$8,$9,$10,$11,$12)`,
  [actor,turnId,seq,kind,model,status,hash('r'+turnId+seq),inFlight?null:free?0:status==='unusable'?0:nominal,inFlight||free?null:actual,JSON.stringify(usage),at,settled]);
}
let messageSeq=0;
const message=(sessionId,turnId,role,createdAt,extra={})=>c.query(
 'insert into session_messages(session_id,seq,role,turn_id,content,content_hash,visible,deleted_at,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
 [sessionId,++messageSeq,role,turnId,'text',hash('m'+messageSeq),extra.visible??true,extra.deletedAt??null,createdAt]);
const ledger=(actor,amount,type,ledgerType,reason,createdAt=ago(0))=>c.query(
 `insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after,created_at)
  values($1,$2,$3,$4,$5,'system',$6,0,0,$7)`,[actor,amount,type,ledgerType,reason,'probe:'+randomUUID(),createdAt]);
const usageDays=async(from,to,dailyFrom)=>(await c.query('select * from turn_admin_usage_days($1,$2,$3) order by model_used,day nulls first',[from,to,dailyFrom])).rows;
const activity=(from,to,callsFrom)=>one('select turn_admin_activity($1,$2,$3) v',[from,to,callsFrom]);
const dashboard=(today,week,month)=>one('select admin_dashboard_stats($1,$2,$3) v',[today,week,month]);
const written=()=>one(`select (select count(*) from turns)::int+(select count(*) from turn_calls)::int+(select count(*) from session_messages)::int
 +(select count(*) from credit_transactions)::int+(select count(*) from profiles)::int+(select count(*) from tickets)::int v`);
try{
 const todayStart=new Date(Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate())).toISOString();
 const weekStart=ago(7),monthStart=ago(30),end=new Date(now+60e3).toISOString();
 // The database built from files may already hold rows (seed accounts): the dashboard is checked by what this suite adds.
 const base=await dashboard(todayStart,weekStart,monthStart);
 const a=await account(ago(40)),b=await account(ago(3));
 const s1=await session(a),s2=await session(a),s3=await session(a),s4=await session(b);
 // S1: an alpha chat three days ago (two spent calls with full token counts and a decision call), then a beta chat two days ago
 // whose call did not record cached tokens. The conversation is alpha's: its first turn decides.
 const t1=await turn(a,s1,'chat',ago(3),'example/alpha',9);
 await call(a,t1,{at:ago(3),ms:1000,usage:{inputTokens:100,outputTokens:20,cachedTokens:40,cacheCreationTokens:5}});
 await call(a,t1,{at:ago(3,1000),ms:3000,nominal:0.02,usage:{inputTokens:50,outputTokens:10,cachedTokens:0,cacheCreationTokens:0}});
 await call(a,t1,{kind:'decision',at:ago(3,2000),ms:500,nominal:0.001,actual:0.001,usage:{model:'example/decider'}});
 const t2=await turn(a,s1,'chat',ago(2),'example/beta',4);
 await call(a,t2,{model:BETA,at:ago(2),ms:2000,nominal:0.05,usage:{inputTokens:70,outputTokens:30}});
 // S2: a mentor conversation forty days ago (outside a thirty-day window, folded when the read is all-time).
 const t3=await turn(a,s2,'mentor',ago(40),'example/alpha',6);
 await call(a,t3,{at:ago(40),ms:1000,nominal:0.03,usage:{inputTokens:10,outputTokens:10,cachedTokens:0,cacheCreationTokens:0}});
 // S3: a scheduled review yesterday is not a conversation; its spent call is still usage.
 const t4=await turn(a,s3,'review',ago(1),'example/alpha',0);
 await call(a,t4,{at:ago(1),ms:1000,nominal:0.04,usage:{inputTokens:5,outputTokens:5,cachedTokens:0,cacheCreationTokens:0}});
 // Calls that were not spent, yesterday: a refusal, a provider 402, one in flight, one whose outcome is unknown, one unusable
 // answer the platform paid for.
 const t5=await turn(a,s1,'chat',ago(1),'example/alpha',0);
 await call(a,t5,{status:'rejected',at:ago(1)});
 await call(a,t5,{status:'no_charge_402',at:ago(1)});
 await call(a,t5,{status:'dispatched',at:ago(1)});
 await call(a,t5,{status:'unusable',at:ago(1),actual:0.007});
 // B: one beta conversation today.
 const t6=await turn(b,s4,'chat',ago(0,-60e3),'example/beta',2);
 await call(b,t6,{model:BETA,at:ago(0,-60e3),ms:1000,nominal:0.01,usage:{inputTokens:1,outputTokens:1,cachedTokens:0,cacheCreationTokens:0}});
 await message(s1,t1,'user',ago(3));await message(s1,t1,'assistant',ago(3));
 await message(s1,t2,'user',ago(2));await message(s1,t2,'assistant',ago(2),{deletedAt:ago(1)});
 await message(s1,t2,'assistant',ago(2),{visible:false});
 await message(s2,t3,'user',ago(40));await message(s2,t3,'assistant',ago(40));
 await message(s4,t6,'user',ago(0,-60e3));
 let before=await written();

 // Usage rows of the last thirty days, by day.
 const month=await usageDays(monthStart,end,monthStart);
 const row=(rows,model,day)=>rows.find(r=>r.model_used===model&&(day===null?r.day===null:r.day&&utcDay(new Date(r.day.getTime()-r.day.getTimezoneOffset()*6e4).toISOString())===day));
 const alpha3=row(month,'example/alpha',utcDay(ago(3)));
 assert.deepEqual([Number(alpha3.requests),Number(alpha3.total_credits),Number(alpha3.total_cost_usd).toFixed(2)],[2,9,'0.03'],"the turn's credits once, on its first spent call");
 assert.deepEqual([alpha3.input_tokens,alpha3.output_tokens,alpha3.cached_tokens,alpha3.cache_creation_tokens].map(Number),[150,30,40,5]);
 const beta2=row(month,'example/beta',utcDay(ago(2)));
 assert.deepEqual([Number(beta2.requests),Number(beta2.total_credits),Number(beta2.input_tokens),beta2.cached_tokens,beta2.cache_creation_tokens],[1,4,70,null,null],'a count no call recorded is unknown, not zero');
 const decider=row(month,'example/decider',utcDay(ago(3)));
 assert.deepEqual([Number(decider.requests),Number(decider.total_credits),decider.input_tokens],[1,0,null],'a decision call is its own model line and carries no credits');
 const alpha1=row(month,'example/alpha',utcDay(ago(1)));
 assert.deepEqual([Number(alpha1.requests),Number(alpha1.total_cost_usd).toFixed(3)],[2,'0.047'],'the review call and the unusable answer are spent calls; refused, 402 and in-flight calls are not');
 assert.equal(month.filter(r=>r.model_used==='example/alpha').length,2,'the call of forty days ago is outside the window');
 assert.equal(month.reduce((n,r)=>n+Number(r.total_credits),0),15,'credits of the window: 9 + 4 + 2');
 // All time, with days only for the last thirty: the old call is one folded row per model.
 const all=await usageDays(null,end,monthStart);
 const folded=row(all,'example/alpha',null);
 assert.deepEqual([Number(folded.requests),Number(folded.total_credits),Number(folded.total_cost_usd).toFixed(2)],[1,6,'0.03']);
 assert.equal(all.reduce((n,r)=>n+Number(r.total_credits),0),21,'all-time credits are the sum of every turn charge');
 assert.equal(all.reduce((n,r)=>n+Number(r.total_credits),0),await one('select coalesce(sum(charged_credits),0)::int v from turns'));
 assert.equal(all.length,month.length+1);
 report.checks.push('usage days: spent calls by model and UTC day, credits once per turn, decision calls on their own line, unknown token counts kept unknown, older days folded');

 const act=await activity(ago(10),end,ago(10));
 assert.equal(act.conversations.total,3,'S1, S2 and S4; the scheduled review is not a conversation');
 assert.deepEqual(act.conversations.byModel,[{model:'example/alpha',count:2},{model:'example/beta',count:1}],'a conversation belongs to the model of its first turn');
 assert.deepEqual(act.conversations.days,[{date:utcDay(ago(3)),model:'example/alpha',count:1},{date:utcDay(ago(0,-60e3)),model:'example/beta',count:1}]);
 assert.deepEqual([act.messages.user,act.messages.assistant],[4,2],'deleted and hidden messages are not counted');
 assert.deepEqual(act.messages.days,[{date:utcDay(ago(3)),user:1,assistant:1},{date:utcDay(ago(2)),user:1,assistant:0},{date:utcDay(ago(0,-60e3)),user:1,assistant:0}]
  .reduce((days,d)=>{const last=days.at(-1);if(last&&last.date===d.date){last.user+=d.user;last.assistant+=d.assistant;}else days.push({...d});return days;},[]));
 // Finished calls of the last ten days: 6 ok (1000, 3000, 500, 2000, 1000, 1000 ms), 1 unusable, 1 rejected, 1 refused 402.
 assert.deepEqual([act.calls.finished,act.calls.failed,act.calls.avgMs,act.calls.p95Ms],[9,3,1417,3000],'in-flight calls are neither; duration over successful calls only');
 const narrow=await activity(ago(10),end,ago(0.5));
 assert.deepEqual([narrow.calls.finished,narrow.calls.failed,narrow.conversations.total],[1,0,3],'the calls window is its own; totals do not depend on it');
 const quiet=await activity(ago(400),ago(399),ago(400));
 assert.deepEqual([quiet.conversations.days,quiet.messages.days,quiet.calls],[[],[],{finished:0,failed:0,avgMs:null,p95Ms:null}],'an empty window has empty lists and unknown durations');
 report.checks.push('activity: conversations by first turn and model, messages by side, finished calls with failures and duration, each over its own window');

 // Dashboard: more rows than PostgREST's 1000-row cap are counted whole.
 await c.query("insert into profiles(id,credits,created_at) select gen_random_uuid(),3,$1 from generate_series(1,1200)",[ago(0,-60e3)]);
 await c.query("insert into tickets(user_id,title,status) values($1,'t','open'),($1,'t','in_progress'),($1,'t','closed'),($1,'t','closed')",[a]);
 // A soft-deleted account and a soft-deleted ticket are counted nowhere.
 await c.query("insert into profiles(id,credits,is_deleted) values(gen_random_uuid(),777,'true')");
 await c.query("insert into tickets(user_id,title,status,is_deleted) values($1,'gone','open','true')",[a]);
 await ledger(a,500,'bonus','grant','opening_grant',ago(40));
 await ledger(a,-60,'adjustment','adjustment','bill2_reserve',ago(1));
 await ledger(a,60,'adjustment','adjustment','bill2_release',ago(1));
 await ledger(a,-9,'consumption','spend','turn_spend',ago(3));
 await ledger(b,200,'purchase','grant','topup_purchase',ago(0,-60e3));
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after,created_at)
  select $1,-1,'consumption','spend','turn_spend','system','bulk:'||g,0,0,$2 from generate_series(1,1500) g`,[b,ago(0,-60e3)]);
 before=await written();
 const dash=await dashboard(todayStart,weekStart,monthStart);
 const delta=(path)=>path.reduce((v,k)=>v?.[k],dash)-(path.reduce((v,k)=>v?.[k],base)??0);
 assert.deepEqual([delta(['users','total']),delta(['users','month']),delta(['users','week']),delta(['users','credits'])],[1202,1201,1201,1202*3+194],'the account of forty days ago is not new this month');
 assert.ok(delta(['users','today'])>=1200,'accounts created a minute ago are of today (unless the day just turned)');
 assert.deepEqual([delta(['tickets','total']),delta(['tickets','open']),delta(['tickets','inProgress']),delta(['tickets','closed'])],[4,1,1,2]);
 assert.equal(delta(['ledger','spent']),1509,'spend is charged rows only: 9 + 1500, never the reservation');
 const type=(name,key)=>(dash.ledger.byType[name]?.[key]??0)-(base.ledger.byType[name]?.[key]??0);
 assert.deepEqual([type('consumption','count'),type('consumption','amount'),type('adjustment','amount'),type('bonus','amount'),type('purchase','amount')],[1501,-1509,0,500,200]);
 const dayOf=(stats,date)=>stats.ledger.days.find(d=>d.date===date)??{granted:0,spent:0};
 const today=utcDay(ago(0,-60e3)),three=utcDay(ago(3));
 assert.deepEqual([dayOf(dash,today).granted-dayOf(base,today).granted,dayOf(dash,today).spent-dayOf(base,today).spent],[200,1500]);
 assert.equal(dayOf(dash,three).spent-dayOf(base,three).spent,9);
 assert.ok(!dash.ledger.days.some(d=>d.date===utcDay(ago(40))),'days before the week start are not listed');
 report.checks.push('dashboard: users, tickets and the ledger counted in the database past the row cap; spend is charged rows; granted and spent per day since the week start');

 await usageDays(null,end,monthStart);await activity(ago(10),end,ago(10));
 assert.equal(await written(),before,'nothing was written');
 for(const args of [[end,ago(1),ago(1)],[ago(1),null,ago(1)],[ago(1),end,null]])
  assert.match(await refusal(c.query('select * from turn_admin_usage_days($1,$2,$3)',args)),/TURN_REPORT_WINDOW_INVALID/);
 for(const args of [[end,ago(1),ago(1)],[null,end,ago(1)],[ago(1),end,null],[ago(1),end,end]])
  assert.match(await refusal(c.query('select turn_admin_activity($1,$2,$3)',args)),/TURN_REPORT_WINDOW_INVALID/);
 assert.match(await refusal(c.query('select admin_dashboard_stats($1,$2,$3)',[todayStart,null,monthStart])),/ADMIN_STATS_WINDOW_INVALID/);
 for(const fn of ['turn_admin_usage_days(timestamptz,timestamptz,timestamptz)','turn_admin_activity(timestamptz,timestamptz,timestamptz)','admin_dashboard_stats(timestamptz,timestamptz,timestamptz)'])
  for(const [role,expected] of [['anon',false],['authenticated',false],['service_role',true]])
   assert.equal(await one("select has_function_privilege($1,'public.'||$2,'EXECUTE') v",[role,fn]),expected,role+' '+fn);
 report.checks.push('bad windows refused; nothing written; only service_role may execute');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
