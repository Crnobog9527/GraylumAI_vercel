/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-PERF 0408: the own-post visibility test of the history window runs once per execution, not once per history row.
// runtime_admit and runtime_session_items 'read' must keep exactly the rows they kept before. Counted by function calls,
// not time, so a slow or fast machine gives the same answer.
import assert from 'node:assert/strict';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const N=60;
try{
 await c.query(read('packages/db/tests/runtime-view-perf/fixture.sql'));
 const f=await one('select runtime_perf_test.seed($1,false) v',[N]);
 await c.query("select set_config('request.jwt.claim.sub',$1,false)",[f.actor]);
 // Two late executions drop out of the window for different reasons (every later execution depends on all earlier ones, so
 // they take their dependents with them): one is no longer available, one names an own-post read that was erased.
 const ids=(await c.query('SELECT id FROM runtime_executions WHERE session_id=$1 ORDER BY created_at',[f.session])).rows.map(r=>r.id);
 await c.query("UPDATE runtime_executions SET unavailable_reason='source_deleted' WHERE id=$1",[ids[N-3]]);
 await c.query(`UPDATE runtime_executions SET payload=payload||'{"ownPosts":true}' WHERE id=$1`,[ids[N-7]]);
 await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result) VALUES($1,'erased','read_source','{}','{"kind":"x"}')`,[ids[N-7]]);
 await c.query("UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=now() WHERE execution_id=$1",[ids[N-7]]);
 const oldWindow=`WITH bounded AS (SELECT h.revision,h.execution_id FROM runtime_session_history h
   WHERE h.session_id=$1 AND h.revision<=(SELECT revision FROM runtime_sessions WHERE id=$1) AND NOT h.internal_control
   ORDER BY h.revision DESC LIMIT 1128), availability AS (SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM bounded)))
  SELECT coalesce(array_agg(revision ORDER BY revision),ARRAY[]::bigint[]) v FROM bounded JOIN availability USING(execution_id)
  WHERE available AND runtime_workspace_posts_history_visible(execution_id)`;
 const total=await one('SELECT count(*)::int v FROM runtime_session_history WHERE session_id=$1',[f.session]);
 const reference=await one(oldWindow,[f.session]);
 assert.ok(reference.length<total-10&&reference.length>=150,`some executions drop out of the window (${reference.length} of ${total})`);
 const visibleCalls=`SELECT coalesce(pg_stat_get_xact_function_calls('public.runtime_workspace_posts_history_visible(uuid)'::regprocedure),0)::int v`;
 // runtime_admit
 await c.query('BEGIN');
 await c.query("SET LOCAL track_functions='all'");
 const before=await one(visibleCalls);
 const admitted=await one('select runtime_admit($1,$2,gen_random_uuid(),$3,$4) v',[f.actor,f.session,f.payload,f.billing]);
 const calls=await one(visibleCalls)-before;
 const candidate=await one('SELECT candidate_history v FROM runtime_executions WHERE id=$1',[admitted.executionId]);
 await c.query('ROLLBACK');
 assert.deepEqual(candidate.map(Number),reference.map(Number),'the admitted execution keeps exactly the rows the previous query kept');
 report.checks.push(`runtime_admit: ${candidate.length} rows kept of ${total}, own-post visibility test ran ${calls} times for ${N} executions`);
 assert.ok(calls>0,'RUNTIME_HISTORY_VISIBLE_GUARD_NOT_MEASURING');
 assert.ok(calls<=N,`RUNTIME_HISTORY_VISIBLE_PER_ROW: ${calls} calls for ${N} executions`);
 // runtime_session_items read (an execution that still has all its ancestors, so its window is long)
 const readReference=await one(`WITH candidates AS (SELECT h.revision,h.execution_id,h.item FROM runtime_session_history h
   JOIN runtime_executions e ON e.id=$2 WHERE h.session_id=$1 AND h.revision=ANY(coalesce(e.selected_history,e.candidate_history)) AND NOT h.internal_control),
  availability AS (SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM candidates)))
  SELECT coalesce(jsonb_agg(jsonb_build_object('revision',revision,'item',item) ORDER BY revision),'[]') v FROM candidates JOIN availability USING(execution_id)
  WHERE available AND runtime_workspace_posts_history_visible(execution_id)`,[f.session,ids[N-9]]);
 await c.query('BEGIN');
 await c.query("SET LOCAL track_functions='all'");
 const b2=await one(visibleCalls);
 const items=await one("select runtime_session_items($1,$2,$3,'read',null,1000,null) v",[f.actor,f.session,ids[N-9]]);
 const calls2=await one(visibleCalls)-b2;
 await c.query('ROLLBACK');
 assert.deepEqual(items,readReference,'read returns exactly the rows the previous query returned, in the same order');
 assert.ok(items.length>=150&&items.length<total);
 assert.ok(calls2>0&&calls2<=N,`RUNTIME_HISTORY_VISIBLE_PER_ROW (read): ${calls2}`);
 report.checks.push(`runtime_session_items read: ${items.length} rows, visibility test ran ${calls2} times`);
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
