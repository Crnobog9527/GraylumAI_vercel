/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Shared fixture for the volume suites (erasure-volume, restore-drill): accounts, conversations and whole rounds written
// through the real core-path functions, plus the readers that count what is left. Bound to one database client.
import {randomUUID,createHash} from 'node:crypto';
export const hash=text=>createHash('sha256').update(text).digest('hex');
export function rounds(c){
const one=async(sql,args=[],client=c)=>(await client.query(sql,args)).rows[0]?.v;
const policy=()=>({q:100,uTurnUsd:0.1,gCredits:60,minCredits:10,uModelCredits:30,historyItems:200,inputBytes:1000,
 limits:{model:3,paidTools:1,freeTools:1},stopLoss:{limitUsd:1000,p:8,poolSize:8,uFastUsd:1,uBigUsd:5}});
async function account(credits=100000){
 const actor=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,$2)',[actor,credits]);
 await c.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)`,[actor,credits,'opening_grant:'+actor]);
 return {actor,session:await newSession({actor})};
}
async function newSession(a){
 const id=randomUUID();
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [id,a.actor,JSON.stringify({kind:'positioning_draft',probe:randomUUID()}),randomUUID()]);
 return id;
}
const call=(a,turn,seq,kind,tool,paid)=>one('select turn_call_begin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,kind,kind==='tool'?null:randomUUID(),tool,paid,hash('r'+turn+seq),kind==='tool'&&!paid?0:0.02,6]);
const receipt=(a,turn,seq,raw,cost=0.01)=>one('select turn_call_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) v',
 [a.actor,turn,seq,'ok',cost,cost,'{}',null,hash('p'+turn+seq),raw]);
// One whole round through the real functions: freeze, model call, paid tool, free tool (each with a response body), two messages.
async function round(a,session,n){
 const o=await one('select turn_open($1,$2,$3,$4,$5) v',[a.actor,session,randomUUID(),'chat',JSON.stringify(policy())]);
 await call(a,o.turnId,1,'model',null,null);await receipt(a,o.turnId,1,`RAW_PRIVATE_MODEL_${n} `.repeat(2000));
 await call(a,o.turnId,2,'tool','research_search',true);await receipt(a,o.turnId,2,`RAW_PRIVATE_PAID_TOOL_${n} `.repeat(1000));
 await call(a,o.turnId,3,'tool','web_fetch',false);await receipt(a,o.turnId,3,`RAW_PRIVATE_FREE_TOOL_${n} `.repeat(1000),0);
 const messages=[{role:'user',content:`PRIVATE_Q_${n} `+'q'.repeat(3000)},{role:'assistant',content:`PRIVATE_A_${n} `+'a'.repeat(6000)}];
 await one("select turn_close($1,$2,'completed',$3,true,false,null) v",[a.actor,o.turnId,JSON.stringify(messages)]);
 return o.turnId;
}
const content=async sessions=>(await c.query(`select count(*) filter (where visible)::int visible,count(*) filter (where content<>'')::int text,
  count(*)::int total from session_messages where session_id=any($1)`,[sessions])).rows[0];
const raws=sessions=>one('select count(*)::int v from turn_call_raw r join turns t on t.id=r.turn_id where t.session_id=any($1)',[sessions]);
// Billing records only: money columns of turns and receipts, the credit ledger and the balance.
const money=async a=>(await c.query(`select (select credits from profiles where id=$1) credits,
  (select sum(amount)::int from credit_transactions where user_id=$1) ledger,(select count(*)::int from credit_transactions where user_id=$1) rows,
  (select json_agg(json_build_object('id',id,'charged',charged_credits,'absorbed',absorbed_credits,'kind',close_kind,'settlement',settlement) order by id) from turns where actor_id=$1) turns,
  (select json_agg(json_build_object('t',turn_id,'s',seq,'kind',call_kind,'n',nominal_usd,'a',actual_usd,'status',status) order by turn_id,seq) from turn_calls where actor_id=$1) calls`,
 [a.actor])).rows[0];

return {one,account,newSession,round,content,raws,money};
}
