/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CONTENT-CONVERSATION-2 (0542): kind=minutes. One metered call on a free conversation or a topic window; the minutes are one message
// that is never visible, so no later history or page read holds them; turn_session_minutes lists them; deleting the conversation
// clears them; a refused or empty close saves nothing and charges nothing.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function minutesCases(t){
 const {c,one,open,begin,record,close,balance,account,policy,refusal,report}=t;
 const pol=()=>policy({gCredits:30,minCredits:10,limits:{model:1,paidTools:0,freeTools:0}});
 const closeMinutes=(a,turn,{kind='completed',minutes='## 纪要\n- 定了做帐篷测评',delivered=true,refundAll=false,result}={})=>
  one('select turn_close($1,$2,$3,$4,$5,$6,null,$7) v',[a.actor,turn,kind,'[]',delivered,refundAll,
   // No result is SQL NULL, as Node sends it (never the JSON value null).
   result===undefined?(kind==='completed'?JSON.stringify({minutes}):null):JSON.stringify(result)]);
 const list=a=>{const run=async()=>{await c.query('set role service_role');try{return await one('select turn_session_minutes($1,$2) v',[a.actor,a.session]);}
  finally{await c.query('reset role');}};return run();};
 {
  const a=await account(1000);
  // A conversation with one exchange.
  const chat=await open(a);await begin(a,chat.turnId,1);await record(a,chat.turnId,1);
  await close(a,chat.turnId,'completed',{messages:[{role:'user',content:'我想做露营装备测评'},{role:'assistant',content:'先从帐篷开始'}]});
  const before=await balance(a);
  const m=await open(a,{kind:'minutes',pol:pol()});
  assert.equal(m.history.length,2,'the minutes read the visible conversation');
  await begin(a,m.turnId,1);await record(a,m.turnId,1);
  const closed=await closeMinutes(a,m.turnId);
  assert.equal(closed.closeKind,'completed');
  assert.ok(closed.chargedCredits>0,'metered like any turn');
  assert.equal(await balance(a),before-closed.chargedCredits);
  const rows=(await c.query('select role,content,visible,turn_id from session_messages where session_id=$1 order by seq',[a.session])).rows;
  assert.equal(rows.length,3);
  assert.deepEqual([rows[2].visible,rows[2].role,Number(rows[2].turn_id)],[false,'assistant',Number(m.turnId)]);
  // Never in a later turn's history nor in the next minutes.
  const next=await open(a);
  assert.deepEqual(next.history.map(h=>h.content),['我想做露营装备测评','先从帐篷开始']);
  await close(a,next.turnId,'failed',{messages:[],delivered:false,refundAll:true});
  // Never in the page's conversation: the page reads visible rows only (turn_session_view), and the minutes row is not one.
  assert.equal(await one("select count(*)::int v from session_messages where session_id=$1 and visible and content like '%帐篷测评%'",[a.session]),0);
  // Listed, newest first.
  const listed=await list(a);
  assert.equal(listed.length,1);
  assert.deepEqual([listed[0].turnId,listed[0].available,listed[0].body],[Number(m.turnId),true,'## 纪要\n- 定了做帐篷测评']);
  // A failed minutes turn saves nothing, charges nothing, and is listed as failed.
  const settled=await balance(a),f=await open(a,{kind:'minutes',pol:pol()});
  const failed=await closeMinutes(a,f.turnId,{kind:'failed',delivered:false,refundAll:true});
  assert.equal(failed.chargedCredits,0,'a failed minutes turn charges nothing');
  assert.equal(await balance(a),settled,'its freeze comes back whole');
  const two=await list(a);
  assert.deepEqual(two.map(x=>[x.closeKind,x.available]),[['failed',false],['completed',true]]);
  // Another key in the result, or an empty text, is refused (nothing written).
  const bad=await open(a,{kind:'minutes',pol:pol()});
  assert.match(await refusal(closeMinutes(a,bad.turnId,{result:{minutes:'x',steps:[]}})),/TURN_KIND_RESULT_UNSUPPORTED/);
  assert.match(await refusal(closeMinutes(a,bad.turnId,{result:{minutes:''}})),/TURN_KIND_RESULT_UNSUPPORTED/);
  await closeMinutes(a,bad.turnId,{kind:'failed',delivered:false,refundAll:true});
  // One turn at a time: a minutes turn holds the conversation as any other.
  const busy=await open(a,{kind:'minutes',pol:pol()});
  assert.match(await refusal(open(a)),/TURN_SESSION_BUSY/);
  await closeMinutes(a,busy.turnId,{kind:'failed',delivered:false,refundAll:true});
  // Another account reads nothing.
  const other=await account(100);
  assert.match(await refusal(one('select turn_session_minutes($1,$2) v',[other.actor,a.session])),/TURN_SESSION_DENIED|permission denied/);
  // Deleting the conversation marks the minutes deleted at once with every other message (nothing lists or reads them), and the
  // cleanup that clears the conversation's text clears theirs too.
  await one('select content_erasure_mark_session($1,$2) v',[a.actor,a.session]);
  assert.equal(await one("select count(*)::int v from session_messages where session_id=$1 and deleted_at is null",[a.session]),0,'every row marked deleted');
  assert.match(await refusal(list(a)),/TURN_SESSION_ERASED/,'the minutes list reads nothing');
  await one("select content_erasure_confirm($1,'session',$2,null) v",[a.actor,a.session]);
  const cleared=await one("select count(*)::int v from session_messages where session_id=$1 and content like '%帐篷测评%'",[a.session]);
  assert.equal(cleared,0,'no copy of the minutes stays after the cleanup');
 }
 {
  // Only a free conversation or a topic window.
  const a=await account(1000);
  const sid=randomUUID();
  await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
   [sid,a.actor,JSON.stringify({kind:'positioning_topic',draftId:randomUUID()}),randomUUID()]);
  assert.match(await refusal(open(a,{kind:'minutes',pol:pol(),session:sid})),/TURN_SESSION_DENIED/);
 }
 report.checks.push('CONTENT-CONVERSATION-2 0542: minutes are one metered call; kept as one invisible message never in later history or the page; listed newest first; refused results write nothing; conversation delete clears them; other scopes refused');
}
