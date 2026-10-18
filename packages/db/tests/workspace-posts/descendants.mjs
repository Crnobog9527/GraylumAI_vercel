/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createFixture,claim} from '../payg/fixture.mjs';
import {rpc} from '../erasure-b2a/cases.mjs';
import {read} from '../runtime-view-perf/local-db.mjs';
export async function descendantCases({c,report}){
 const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
 const f=await createFixture(c,{credits:1000,threshold:1});
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 await one("SELECT set_config('request.jwt.claim.sub',$1,false) v",[f.actor]);
 const started=await rpc(c,'runtime_start',f.actor,randomUUID(),{scope:{kind:'positioning_draft'}});
 const session=await rpc(c,'runtime_session_context',f.actor,started.sessionId);
 const context=requestId=>({version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Synthetic own-post history',
  instructions:'Read stored source',model:f.claimPayload.model,modelId:f.payload.modelId,maxOutputTokens:1000,
  maxTurns:3,historyItems:10,tools:['read_source'],maxToolCalls:2,workspaceContext:true,ownPosts:true,sources:[],network:'deny',
  request:{sessionId:started.sessionId,requestId,input:'Synthetic own-post history',selection:{kind:'ordinary',modelId:f.payload.modelId},network:'deny'}});
 const admit=async own=>{
  const requestId=randomUUID(),ctx=context(requestId);
  if(!own){delete ctx.ownPosts;ctx.tools=[];ctx.maxToolCalls=0;}
  const a=await rpc(c,'runtime_admit',f.actor,started.sessionId,requestId,ctx,{...f.payload,scope:session.scope,input:ctx});
  const live=await rpc(c,'runtime_execution',f.actor,a.executionId,'begin',null);
  const owner=(action,value)=>rpc(c,'runtime_execution',f.actor,a.executionId,action,{epoch:live.epoch,value});
  const history=await rpc(c,'runtime_session_items',f.actor,started.sessionId,a.executionId,'read',null,10,null);
  await owner('owner_session',{action:'freeze',items:history.map(h=>h.revision)});
  return {...a,owner,history};
 };
 const record=async(a,body)=>{
  const linked={...f,run:a.runId},call=await claim(c,linked);
  await rpc(c,'bill2_record',f.actor,a.runId,call.id,{provider:f.claimPayload.provider,account:'sandbox',
   model:f.claimPayload.model,protocol:f.claimPayload.protocol,providerId:'derived-'+call.id,source:'response',
   sourceHash:'c'.repeat(64),observedAt:new Date().toISOString(),coverage:'request_total',final:true,cost:'0.001',
   currency:'USD',usage:{inputTokens:1000,outputTokens:0},rawBody:body});
  await a.owner('owner_session',{action:'append',items:[{role:'assistant',content:body}],batch:0});
  await a.owner('complete',{kind:'usable_result',body:'DISPLAYED_ANSWER',evidenceRef:a.executionId,
   evidenceHash:createHash('sha256').update(JSON.stringify({body:'DISPLAYED_ANSWER'})).digest('hex')});
 };
 const origin=await admit(true);
 const account=await one("SELECT pm_test.member($1,'youtube') v",[f.actor]);
 const business=await one('SELECT business_id v FROM opc_accounts WHERE project_id=$1',[account]);
 const connection=await one(`INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,status,consent_read)
  VALUES($1,$2,$3,'own','manual','youtube','connected',true) RETURNING id v`,[f.actor,business,account]);
 await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
  VALUES($1,'original-post','read_source','{}',$2)`,[origin.executionId,{kind:'my_posts',status:'available',window_days:14,
   source_connections:[connection],posts:[{views:12345}],dependencies:[]}]);
 await record(origin,'ORIGINAL_PRIVATE');
 const child=await admit(false);assert.equal(child.history.length,1);
 assert.equal(await one('SELECT count(*)::int v FROM runtime_history_dependencies WHERE execution_id=$1 AND dependency_id=$2',
  [child.executionId,origin.executionId]),1);
 await record(child,'DESCENDANT_PRIVATE');
 const visibleDefinition=await one("SELECT pg_get_functiondef('public.runtime_workspace_posts_history_visible(uuid)'::regprocedure) v");
 await c.query('BEGIN');await c.query("UPDATE profiles SET is_deleted='true' WHERE id=$1",[f.actor]);
 await c.query(read('packages/db/tests/workspace-posts/before-closed-actor.sql'));
 await assert.rejects(one('SELECT runtime_workspace_posts_history_visible($1) v',[child.executionId]),/BILL2_ACTOR_DENIED/);
 await c.query('ROLLBACK');
 await c.query('BEGIN');await c.query("UPDATE profiles SET is_deleted='true' WHERE id=$1",[f.actor]);
 assert.equal(await one('SELECT runtime_workspace_posts_history_visible($1) v',[child.executionId]),false);
 await c.query('SET ROLE service_role');
 await rpc(c,'runtime_library_propagate',null,1);
 await c.query('RESET ROLE');await c.query('ROLLBACK');
 assert.equal(await one("SELECT pg_get_functiondef('public.runtime_workspace_posts_history_visible(uuid)'::regprocedure) v"),visibleDefinition);
 report.checks.push('closed actors are denied without throwing through the global worker; old visibility check raises BILL2_ACTOR_DENIED');

 const balance=await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]);assert.equal(balance,998);
 await c.query('SET ROLE service_role');
 try{await rpc(c,'publish_monitor_disconnect',f.actor,connection);}finally{await c.query('RESET ROLE');}
 const receipts=()=>one('SELECT jsonb_agg(to_jsonb(r)) v FROM bill2_receipts r JOIN bill2_calls bc ON bc.id=r.call_id WHERE bc.run_id=$1',[child.runId]);
 const old=read('packages/db/migrations/0302_chat_library_search.sql'),at=old.indexOf('CREATE OR REPLACE FUNCTION public.runtime_library_propagate(');
 const d=old.slice(at,old.indexOf('END $$;',at)+7).replace(" RETURN jsonb_build_object('processed',done,'waiting',waiting);",
  read('packages/db/tests/workspace-posts/before-descendant-worker.txt')+" RETURN jsonb_build_object('processed',done,'waiting',waiting);");
 await c.query('BEGIN');await c.query(d);await rpc(c,'runtime_library_propagate',f.actor,20);
 assert.match(JSON.stringify(await receipts()),/DESCENDANT_PRIVATE/);
 report.checks.push('RED: source-only cleanup leaves a real, history-frozen descendant receipt and model-history copies');
 await c.query('ROLLBACK');
 for(let i=0;i<4;i++)await rpc(c,'runtime_library_propagate',f.actor,1);
 assert.doesNotMatch(JSON.stringify(await receipts()),/DESCENDANT_PRIVATE|rawBody/);
 assert.equal(await one('SELECT count(*)::int v FROM runtime_session_history WHERE execution_id=$1 AND erased_at IS NULL',[child.executionId]),0);
 assert.equal(await one('SELECT count(*)::int v FROM runtime_session_batches WHERE execution_id=$1 AND erased_at IS NULL',[child.executionId]),0);
 assert.equal(await one('SELECT content_deleted_at IS NOT NULL v FROM bill2_runs WHERE id=$1',[child.runId]),true);
 assert.equal(await one("SELECT result->>'body' v FROM runtime_executions WHERE id=$1",[child.executionId]),'DISPLAYED_ANSWER');
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]),balance);
 assert.equal(await one('SELECT runtime_workspace_posts_history_visible($1) v',[child.executionId]),false);
 report.checks.push('GREEN: limit=1 batches erase descendant histories/batches/receipts, retain shown answers and preserve native money');
}
