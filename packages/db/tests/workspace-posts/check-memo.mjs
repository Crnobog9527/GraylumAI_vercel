/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
// DB-PERF PR-7b-B: inside one call, identical permission sub-checks are evaluated once. The originals are kept as
// *_before_memo, so on the same data every memoized call is compared with the original chain, invisible entries included.
export async function checkMemoCases({c,report}){
 const rows=async(sql,args=[])=>(await c.query(sql,args)).rows;
 const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
 assert.equal(await one("SELECT coalesce(current_setting('graylum.check_call',true),'') v"),'');
 // Every execution: one-turn visibility.
 const turns=await rows(`SELECT e.id,runtime_history_available(e.id) memo,runtime_history_available_before_memo(e.id) original
  FROM runtime_executions e ORDER BY e.id`);
 assert.ok(turns.length>0);
 assert.deepEqual(turns.filter(t=>t.memo!==t.original),[]);
 // Every session: the conversation page's batch visibility, including entries it reports as unavailable.
 const sessions=await rows(`SELECT s.id,
   (SELECT jsonb_agg(jsonb_build_array(execution_id,available) ORDER BY execution_id) FROM runtime_history_availability(
    ARRAY(SELECT id FROM runtime_executions WHERE session_id=s.id))) memo,
   (SELECT jsonb_agg(jsonb_build_array(execution_id,available) ORDER BY execution_id) FROM runtime_history_availability_before_memo(
    ARRAY(SELECT id FROM runtime_executions WHERE session_id=s.id))) original
  FROM runtime_sessions s ORDER BY s.id`);
 assert.deepEqual(sessions.filter(s=>JSON.stringify(s.memo)!==JSON.stringify(s.original)),[]);
 const hidden=turns.filter(t=>t.original===false).length;
 // Every actor: the free conversation list.
 const lists=await rows(`SELECT p.id,opc_free_conversations(p.id) memo,opc_free_conversations_before_memo(p.id) original
  FROM profiles p WHERE EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.actor_id=p.id)
   AND p.status='active' AND p.is_deleted='false' ORDER BY p.id`);
 assert.deepEqual(lists.filter(l=>JSON.stringify(l.memo)!==JSON.stringify(l.original)),[]);
 // The scope is closed after every call: nothing leaks into the next statement.
 assert.equal(await one("SELECT coalesce(current_setting('graylum.check_call',true),'') v"),'');
 assert.equal(await one("SELECT coalesce(current_setting('graylum.check_memo',true),'') v"),'');
 report.checks.push(`memoized and original chains agree: ${turns.length} turns (${hidden} not visible), ${sessions.length} sessions, ${lists.length} lists`);
 // A repeated sub-check inside one call is evaluated once; outside a call nothing is stored.
 await c.query('BEGIN');
 try{
  await c.query("SET LOCAL track_functions='all'");
  const counted=`SELECT coalesce(pg_stat_get_xact_function_calls('public.bill2_scope_allowed_before_memo(uuid,jsonb)'::regprocedure),0)::int v`;
  const s=(await rows('SELECT actor_id,scope FROM runtime_sessions ORDER BY id LIMIT 1'))[0];
  const before=await one(counted);
  await c.query('SELECT bill2_scope_allowed($1,$2),bill2_scope_allowed($1,$2)',[s.actor_id,s.scope]);
  assert.equal(await one(counted)-before,2,'outside a call every check runs');
  const opened=await one('SELECT runtime_check_memo_open() v');assert.equal(opened,true);
  const inside=await one(counted);
  await c.query('SELECT bill2_scope_allowed($1,$2)',[s.actor_id,s.scope]);
  await c.query('SELECT bill2_scope_allowed($1,$2)',[s.actor_id,s.scope]);
  assert.equal(await one(counted)-inside,1,'inside one call the identical check runs once');
  await c.query('SELECT runtime_check_memo_close(true)');
  const after=await one(counted);
  await c.query('SELECT bill2_scope_allowed($1,$2)',[s.actor_id,s.scope]);
  assert.equal(await one(counted)-after,1,'a closed call keeps nothing');
 }finally{await c.query('ROLLBACK');}
 report.checks.push('a repeated identical sub-check runs once inside a call, every time outside one, and nothing survives the call');
 // A change made between two calls is seen by the next call (no cross-call reuse).
 await c.query('BEGIN');
 try{
  const visible=turns.find(t=>t.original===true);
  if(visible){
   assert.equal(await one('SELECT runtime_history_available($1) v',[visible.id]),true);
   await c.query("UPDATE runtime_executions SET unavailable_reason='source_deleted' WHERE id=$1",[visible.id]);
   assert.equal(await one('SELECT runtime_history_available($1) v',[visible.id]),false);
   report.checks.push('a turn made unavailable between two calls is hidden by the next call');
  }
 }finally{await c.query('ROLLBACK');}
}
