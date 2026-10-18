/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {read} from '../runtime-view-perf/local-db.mjs';
import {fixtureSql} from '../publish-monitor/fixtures.mjs';
export async function deletionCases({c,report}){
 const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
 await c.query(fixtureSql);
 const a=await one('SELECT ws_test.actor() v');
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[a]);
 await one("SELECT set_config('request.jwt.claim.sub',$1,false) v",[a]);
 const account=await one("SELECT pm_test.member($1,'youtube') v",[a]);
 const business=await one('SELECT business_id v FROM opc_accounts WHERE project_id=$1',[account]);
 const connection=await one(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,status,consent_read)
  VALUES($1,$2,$3,'own','manual','youtube','connected',true) RETURNING id v`,[a,business,account]);
 const sid=await one('SELECT ws_test.free_session($1) v',[a]);
 const e=randomUUID();
 await c.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
 VALUES($1,$2,$3,$4,'{"ownPosts":true}',0,'completed')`,[e,a,sid,randomUUID()]);
 const source={kind:'my_posts',status:'available',window_days:14,source_connections:[connection],posts:[{views:12345}],dependencies:[]};
 const store=(id,value)=>one(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
  VALUES($1,$2,'read_source','{"query":"my_posts:14"}',$3) RETURNING result v`,[e,id,value]);
 await store('saved-before-delete',source);
 await c.query('BEGIN');await c.query(read('packages/db/tests/workspace-posts/before-deletion-guard.sql'));
 await c.query('DELETE FROM social_connections WHERE id=$1',[connection]);
 assert.equal((await store('stale-old-guard',source)).kind,'my_posts');
 report.checks.push('RED: old guard accepts an already-read metric after its connection was deleted');
 await c.query('ROLLBACK');
 // Delete wins: the old saved copy is erased, replay is denied, a later completion cannot save the held result.
 await c.query('DELETE FROM social_connections WHERE id=$1',[connection]);
 assert.equal(await one("SELECT result IS NULL v FROM runtime_tool_calls WHERE execution_id=$1 AND call_id='saved-before-delete'",[e]),true);
 assert.equal(await one('SELECT runtime_workspace_posts_visible($1,$2) v',[a,source]),false);
 assert.deepEqual(await store('stale-after-delete',source),{kind:'unavailable',reason:'source_deleted',dependencies:[]});
 report.checks.push('GREEN: disconnect/delete erases old journal copy, denies replay and refuses a stale completion');
 // Real disconnect route (not only physical row deletion), and in-progress work receives the existing source-deleted stop.
 const conn2=await one(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,status,consent_read)
  VALUES($1,$2,$3,'own','manual','youtube','connected',true) RETURNING id v`,[a,business,account]);
 // A concurrent disconnect owns the connection lock: refuse immediately instead of deadlocking the tool journal.
 const peer=new c.constructor({host:'127.0.0.1',port:c.connectionParameters.port,database:c.connectionParameters.database,user:'postgres'});
 await peer.connect();
 try{
  await peer.query('BEGIN');
  await peer.query('SELECT id FROM social_connections WHERE id=$1 FOR UPDATE',[conn2]);
  assert.equal((await store('during-disconnect',{...source,source_connections:[conn2]})).kind,'unavailable');
  report.checks.push('concurrent disconnect lock refuses a held copy without waiting or deadlocking');
 }finally{await peer.query('ROLLBACK');await peer.end();}
 const running=randomUUID();
 await c.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
 VALUES($1,$2,$3,$4,'{"ownPosts":true}',0,'interrupted')`,[running,a,sid,randomUUID()]);
 await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
  VALUES($1,'running-read','read_source','{}',$2)`,[running,{...source,source_connections:[conn2]}]);
 await c.query('SET ROLE service_role');
 try{await c.query('SELECT publish_monitor_disconnect($1,$2)',[a,conn2]);}finally{await c.query('RESET ROLE');}
 assert.equal(await one('SELECT unavailable_reason v FROM runtime_executions WHERE id=$1',[running]),'source_deleted');
 assert.equal(await one("SELECT result IS NULL v FROM runtime_tool_calls WHERE execution_id=$1 AND call_id='running-read'",[running]),true);
 report.checks.push('real disconnect RPC stops unfinished work and clears its copied result; existing displayed answers are retained');
}
