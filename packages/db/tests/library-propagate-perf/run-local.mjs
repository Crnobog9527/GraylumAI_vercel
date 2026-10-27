/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-PERF 0403: runtime_library_propagate must not run the recursive own-post history check for executions that have
// nothing to clear (staging library_cleanup timed out scanning ~800 finished own-post executions every 5 minutes).
// Counted by function calls, not time, so a slow or fast machine gives the same answer.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const IDLE=300,DONE=200,CHAIN=5;
try{
 await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
 const actor=await one('SELECT ws_test.actor() v'),session=await one('SELECT ws_test.free_session($1) v',[actor]);
 await one("SELECT set_config('request.jwt.claim.sub',$1,false) v",[actor]);
 let revision=0;
 const execution=async(state='completed')=>{
  const id=randomUUID();
  await c.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
   VALUES($1,$2,$3,$4,'{"ownPosts":true}',0,$5)`,[id,actor,session,randomUUID(),state]);
  return id;
 };
 // Staging-like backlog: finished own-post executions that never read any post but keep their answer in history,
 // so the cheap "something to clear" tests are true for them while the history check is false.
 for(let i=0;i<IDLE;i++){
  const id=await execution();
  await c.query("INSERT INTO runtime_session_history(session_id,revision,execution_id,item) VALUES($1,$2,$3,'{\"role\":\"assistant\",\"content\":\"synthetic\"}')",[session,++revision,id]);
 }
 // Already processed: own-post executions whose read_source results were erased, in dependency chains.
 for(let i=0;i<DONE;i+=CHAIN){
  let previous=null;
  for(let j=0;j<CHAIN;j++){
   const id=await execution();
   await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
    VALUES($1,'done-read','read_source','{"query":"my_posts:14"}','{"kind":"unavailable"}')`,[id]);
   await c.query('UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=now() WHERE execution_id=$1',[id]);
   if(previous)await c.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',[id,previous]);
   previous=id;
  }
 }
 await c.query('BEGIN');
 await c.query("SET LOCAL track_functions='all'");
 const counted="SELECT coalesce(pg_stat_get_xact_function_calls('public.runtime_workspace_posts_history_erased(uuid)'::regprocedure),0)::int v";
 const before=await one(counted);
 await c.query('SELECT runtime_library_propagate(NULL,100)');
 const calls=await one(counted)-before;
 await c.query('ROLLBACK');
 report.checks.push(`a sweep over ${IDLE} idle and ${DONE} processed own-post executions ran the history check ${calls} times`);
 assert.ok(calls<=20,`LIBRARY_PROPAGATE_TOO_MANY_HISTORY_CHECKS: ${calls}`);
 // Work that is really pending still gets done: a live my_posts result naming a disconnected account.
 const target=await execution('running');
 // The insert trigger would already rewrite a result naming a missing connection: store it as an old row would be.
 await c.query('ALTER TABLE runtime_tool_calls DISABLE TRIGGER USER');
 await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
  VALUES($1,'live-read','read_source','{"query":"my_posts:14"}',$2::jsonb)`,[target,JSON.stringify({kind:'my_posts',status:'available',window_days:14,source_connections:[randomUUID()],dependencies:[]})]);
 await c.query('ALTER TABLE runtime_tool_calls ENABLE TRIGGER USER');
 const child=await execution();
 await c.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',[child,target]);
 await c.query('SELECT runtime_library_propagate(NULL,100)');
 assert.deepEqual((await c.query('SELECT result IS NULL AS gone,erased_at IS NOT NULL AS erased FROM runtime_tool_calls WHERE execution_id=$1',[target])).rows[0],{gone:true,erased:true});
 assert.equal(await one('SELECT unavailable_reason v FROM runtime_executions WHERE id=$1',[target]),'source_deleted');
 report.checks.push('a live my_posts result naming a disconnected account is still erased and its execution marked unavailable');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
