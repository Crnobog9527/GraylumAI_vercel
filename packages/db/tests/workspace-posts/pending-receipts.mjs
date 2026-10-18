/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createFixture,claim} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
import {read} from '../runtime-view-perf/local-db.mjs';
export async function pendingReceiptCases({c,report}){
 const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
 const f=await createFixture(c,{credits:1000,threshold:1});
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 await one("SELECT set_config('request.jwt.claim.sub',$1,false) v",[f.actor]);
 const started=await rpc(c,'runtime_start',f.actor,randomUUID(),{scope:{kind:'positioning_draft'}});
 const session=await rpc(c,'runtime_session_context',f.actor,started.sessionId),requestId=randomUUID();
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Synthetic source deletion',instructions:'Read source',
  model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,maxTurns:3,historyItems:0,tools:['read_source'],
  maxToolCalls:2,workspaceContext:true,ownPosts:true,sources:[],network:'deny',
  request:{sessionId:started.sessionId,requestId,input:'Synthetic source deletion',selection:{kind:'ordinary',modelId:f.payload.modelId},network:'deny'}};
 const admitted=await rpc(c,'runtime_admit',f.actor,started.sessionId,requestId,context,
  {...f.payload,scope:session.scope,input:context});
 f.run=admitted.runId;const execution=admitted.executionId;
 const call=await claim(c,f);
 await rpc(c,'bill2_record',f.actor,f.run,call.id,{provider:f.claimPayload.provider,account:'sandbox',model:f.claimPayload.model,
  protocol:f.claimPayload.protocol,providerId:'generation-'+call.id,source:'response',sourceHash:'c'.repeat(64),
  observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.001',currency:'USD',
  usage:{inputTokens:1000,outputTokens:0},rawBody:'OWN_POST_PENDING_PRIVATE'});
 const account=await one("SELECT pm_test.member($1,'youtube') v",[f.actor]);
 const business=await one('SELECT business_id v FROM opc_accounts WHERE project_id=$1',[account]);
 const connection=await one(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,status,consent_read)
  VALUES($1,$2,$3,'own','manual','youtube','connected',true) RETURNING id v`,[f.actor,business,account]);
 await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
  VALUES($1,'pending-source','read_source','{}',$2)`,[execution,{kind:'my_posts',status:'available',window_days:14,
   source_connections:[connection],posts:[{views:12345}],dependencies:[]}]);
 await c.query(`INSERT INTO runtime_session_history(session_id,execution_id,revision,item)
  VALUES($1,$2,1,'{"role":"tool","content":"OWN_POST_HISTORY_PRIVATE"}')`,[started.sessionId,execution]);
 await c.query('UPDATE runtime_executions SET candidate_history=ARRAY[1]::bigint[] WHERE id=$1',[execution]);
 assert.equal((await rpc(c,'runtime_session_items',f.actor,started.sessionId,execution,'read',null,10,null)).length,1);
 const child=randomUUID();
 await c.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
  VALUES($1,$2,$3,$4,'{}',0,'completed')`,[child,f.actor,started.sessionId,randomUUID()]);
 await c.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',[child,execution]);
 const next=await claim(c,f,2,false);
 const peer=new c.constructor({host:'127.0.0.1',port:c.connectionParameters.port,database:c.connectionParameters.database,user:'postgres'});
 await peer.connect();
 try{
  for(const [table,id] of [['profiles',f.actor],['social_connections',connection]]){
   await peer.query('BEGIN');await peer.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[id]);
   await assert.rejects(rpc(c,'bill2_dispatch',f.actor,f.run,next.id,next.dispatchToken),/RUNTIME_CONTEXT_REVOKED/);
   await peer.query('ROLLBACK');
  }
  report.checks.push('final dispatch never waits behind disconnect profile/connection locks and issues no HTTP grant');
 }finally{await peer.query('ROLLBACK');await peer.end();}

 await c.query('SET ROLE service_role');
 try{await rpc(c,'publish_monitor_disconnect',f.actor,connection);}finally{await c.query('RESET ROLE');}
 assert.equal(await one('SELECT runtime_workspace_posts_history_visible($1) v',[child]),false);
 assert.deepEqual(await rpc(c,'runtime_session_items',f.actor,started.sessionId,execution,'read',null,10,null),[]);
 report.checks.push('before erasure, revoked own-post data is excluded from new model history and transitive dependencies');
 assert.equal(await one('SELECT closed v FROM bill2_runs WHERE id=$1',[f.run]),false);
 const receipts=()=>one('SELECT jsonb_agg(to_jsonb(r)) v FROM bill2_receipts r JOIN bill2_calls bc ON bc.id=r.call_id WHERE bc.run_id=$1',[f.run]);
 assert.match(JSON.stringify(await receipts()),/OWN_POST_PENDING_PRIVATE/);
 const migration=read('packages/db/migrations/0307_runtime_workspace_my_posts.sql');
 const fence=migration.split('$dispatchFence$')[1];
 const dispatch=await one("SELECT pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure) v");
 assert.ok(dispatch.includes(fence));
 await c.query('BEGIN');await c.query(dispatch.replace(fence,''));
 assert.equal((await rpc(c,'bill2_dispatch',f.actor,f.run,next.id,next.dispatchToken)).dispatch,true);
 report.checks.push('RED: after a committed read and disconnect, old dispatch still grants a second provider request');
 await c.query('ROLLBACK');
 await assert.rejects(rpc(c,'bill2_dispatch',f.actor,f.run,next.id,next.dispatchToken),/RUNTIME_CONTEXT_REVOKED/);
 assert.equal(await one('SELECT dispatched_at IS NULL v FROM bill2_calls WHERE id=$1',[next.id]),true);
 report.checks.push('GREEN: final native provider fence denies a revoked committed read before dispatch or new charge');
 const current=await rpc(c,'runtime_execution',f.actor,execution,'read',{});
 assert.equal(current.unavailableReason,'source_deleted');
 report.checks.push('runtime entry detects the revoked source before asynchronous cleanup and stops in-flight work');
 await rpc(c,'runtime_library_propagate',f.actor,20);
 assert.equal(await one('SELECT runtime_workspace_posts_history_visible($1) v',[child]),false);
 report.checks.push('erased source journal is a permanent tombstone for already-admitted descendant history');
 assert.equal(await one('SELECT content_deleted_at IS NOT NULL v FROM bill2_runs WHERE id=$1',[f.run]),true);
 await rpc(c,'runtime_cancel',f.actor,execution);
 const money=await one('SELECT jsonb_build_object(\'credits\',p.credits,\'weighted\',r.weighted_nominal_usd) v FROM profiles p,bill2_runs r WHERE p.id=$1 AND r.id=$2',[f.actor,f.run]);
 assert.equal(money.credits,999); // Exactly the first known 0.001 USD call; cancelled second call's hold is released.
 const old=read('packages/db/migrations/0302_chat_library_search.sql');
 const at=old.indexOf('CREATE OR REPLACE FUNCTION public.runtime_library_propagate(');
 await c.query('BEGIN');await c.query(old.slice(at,old.indexOf('END $$;',at)+7));
 await rpc(c,'runtime_library_propagate',f.actor,20);
 assert.match(JSON.stringify(await receipts()),/OWN_POST_PENDING_PRIVATE/);
 report.checks.push('RED: old deletion worker leaves pre-disconnect receipt content after the original open run settles');
 await c.query('ROLLBACK');
 // Lowest UUID is deliberately an open/unready run, ahead of the eligible original receipt.
 const blocked=await createFixture(c,{credits:1000,threshold:1}),blockedCall=await claim(c,blocked);
 await rpc(c,'bill2_record',blocked.actor,blocked.run,blockedCall.id,{provider:blocked.claimPayload.provider,account:'sandbox',
  model:blocked.claimPayload.model,protocol:blocked.claimPayload.protocol,providerId:'blocked-'+blockedCall.id,
  source:'response',sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:true,
  cost:'0.001',currency:'USD',usage:{inputTokens:1000,outputTokens:0},rawBody:'BLOCKED_PRIVATE'});
 const blockedSession=await one('SELECT ws_test.free_session($1) v',[blocked.actor]);
 await c.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,billing_run_id)
  VALUES('00000000-0000-4000-8000-000000000001',$1,$2,$3,'{"ownPosts":true}',0,'completed',$4)`,
  [blocked.actor,blockedSession,randomUUID(),blocked.run]);
 await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,erased_at)
  VALUES('00000000-0000-4000-8000-000000000001','erased-open-source','read_source',now())`);
 await c.query('UPDATE bill2_runs SET content_deleted_at=now() WHERE id=$1',[blocked.run]);
 const oldBody=read('packages/db/tests/workspace-posts/before-receipt-worker.txt');
 const oldDefinition=old.slice(at,old.indexOf('END $$;',at)+7).replace(
  " RETURN jsonb_build_object('processed',done,'waiting',waiting);",oldBody+" RETURN jsonb_build_object('processed',done,'waiting',waiting);");
 await c.query('BEGIN');await c.query(oldDefinition);
 await c.query('SET ROLE service_role');
 try{await rpc(c,'runtime_library_propagate',null,1);await rpc(c,'runtime_library_propagate',null,1);}
 finally{await c.query('RESET ROLE');}
 assert.match(JSON.stringify(await receipts()),/OWN_POST_PENDING_PRIVATE/);
 report.checks.push('RED: a lower-sorted open run consumes the global limit forever and starves an eligible receipt');
 await c.query('ROLLBACK');
 await c.query('SET ROLE service_role');
 try{await rpc(c,'runtime_library_propagate',null,1);await rpc(c,'runtime_library_propagate',null,1);}
 finally{await c.query('RESET ROLE');}

 assert.doesNotMatch(JSON.stringify(await receipts()),/OWN_POST_PENDING_PRIVATE|rawBody/);
 assert.ok((await receipts()).every(r=>r.financial_projection_version===1));
 assert.deepEqual(await one('SELECT jsonb_build_object(\'credits\',p.credits,\'weighted\',r.weighted_nominal_usd) v FROM profiles p,bill2_runs r WHERE p.id=$1 AND r.id=$2',[f.actor,f.run]),money);
 report.checks.push('GREEN: readiness before the global limit skips the open run; existing worker retries the persisted pending copy after native settlement, projects receipts once and preserves money');
}
