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
 await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments)
  VALUES($1,'original-post','read_source','{"query":"my_posts:90"}')`,[origin.executionId]);
 assert.equal((await rpc(c,'runtime_work_items',f.actor,started.sessionId))[origin.executionId][0].state,'running');
 const descriptor=()=>rpc(c,'runtime_workspace_source',f.actor,started.sessionId,'my_posts:90');
 assert.equal((await descriptor()).kind,'workspace_posts_request');
 await c.query('BEGIN');
 for(const n of [2,3]){
  await c.query(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments)
   VALUES($1,$2,'read_source','{"query":"my_posts:90"}')`,[origin.executionId,'read-limit-'+n]);
  assert.equal((await descriptor()).kind,n===2?'workspace_posts_request':'unavailable');
 }
 assert.equal((await descriptor()).reason,'read_limit');
 await c.query('ROLLBACK');
 report.checks.push('the third own-post attempt returns read_limit before producing a data-reader descriptor, including failed reads');

 await c.query('BEGIN');
 await c.query(`UPDATE runtime_tool_calls SET result='{"kind":"unavailable","reason":"capacity_exhausted"}' WHERE execution_id=$1`,[origin.executionId]);
 assert.equal((await rpc(c,'runtime_work_items',f.actor,started.sessionId))[origin.executionId][0].label,'资料太多放不下，先按已读到的回答');
 await c.query('ROLLBACK');

 await c.query('BEGIN');await c.query("UPDATE runtime_executions SET state='interrupted' WHERE id=$1",[origin.executionId]);
 assert.equal((await rpc(c,'runtime_work_items',f.actor,started.sessionId))[origin.executionId][0].state,'pending');
 await c.query('ROLLBACK');
 await c.query(`UPDATE runtime_tool_calls SET result=$2 WHERE execution_id=$1 AND call_id='original-post'`,
  [origin.executionId,{kind:'my_posts',status:'available',window_days:90,
   source_connections:[connection],posts:[{views:12345}],dependencies:[]}]);
 await record(origin,'ORIGINAL_PRIVATE');
 assert.equal((await rpc(c,'runtime_work_items',f.actor,started.sessionId))[origin.executionId][0].label,'读了你最近 90 天的 1 条作品');
 const child=await admit(false);assert.equal(child.history.length,1);
 assert.equal(await one('SELECT count(*)::int v FROM runtime_history_dependencies WHERE execution_id=$1 AND dependency_id=$2',
  [child.executionId,origin.executionId]),1);
 await record(child,'DESCENDANT_PRIVATE');
 const baseWorker=read('packages/db/migrations/0302_chat_library_search.sql');
 const workerAt=baseWorker.indexOf('CREATE OR REPLACE FUNCTION public.runtime_library_propagate(');
 const workerDefinition=body=>baseWorker.slice(workerAt,baseWorker.indexOf('END $$;',workerAt)+7).replace(
  " RETURN jsonb_build_object('processed',done,'waiting',waiting);",body+" RETURN jsonb_build_object('processed',done,'waiting',waiting);");
 await c.query('BEGIN');await c.query("UPDATE profiles SET membership_level='pro' WHERE id=$1",[f.actor]);
 await c.query(workerDefinition(read('packages/db/tests/workspace-posts/before-entitlement-worker.txt')));
 await rpc(c,'runtime_library_propagate',f.actor,20);
 assert.equal(await one('SELECT result IS NULL v FROM runtime_tool_calls WHERE execution_id=$1',[origin.executionId]),true);
 report.checks.push('RED: access-based erasure destroys 90-day source history on a non-destructive downgrade');
 await c.query('ROLLBACK');
 await c.query('BEGIN');await c.query("UPDATE profiles SET membership_level='pro' WHERE id=$1",[f.actor]);
 assert.equal(await one('SELECT runtime_workspace_posts_history_visible($1) v',[child.executionId]),false);
 assert.equal(await one('SELECT runtime_workspace_posts_history_erased($1) v',[child.executionId]),false);
 assert.equal((await rpc(c,'runtime_work_items',f.actor,started.sessionId))[origin.executionId],undefined);
 await rpc(c,'runtime_library_propagate',f.actor,20);
 assert.equal(await one('SELECT result IS NOT NULL v FROM runtime_tool_calls WHERE execution_id=$1',[origin.executionId]),true);
 assert.equal(await one('SELECT count(*)::int v FROM runtime_session_history WHERE execution_id=$1 AND erased_at IS NULL',[child.executionId]),1);
 assert.equal(await one('SELECT content_deleted_at IS NULL v FROM bill2_runs WHERE id=$1',[child.runId]),true);
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[f.actor]);
 assert.equal(await one('SELECT runtime_workspace_posts_history_visible($1) v',[child.executionId]),true);
 assert.equal((await rpc(c,'runtime_work_items',f.actor,started.sessionId))[origin.executionId][0].kind,'my_posts');
 await c.query('ROLLBACK');
 report.checks.push('GREEN: downgrade denies replay without erasing context; renewal restores the same history');

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
 await c.query('BEGIN');await rpc(c,'content_erasure_mark_session',f.actor,started.sessionId);
 await rpc(c,'content_erasure_confirm',f.actor,'session',started.sessionId,null);
 assert.equal(await one('SELECT count(*)::int v FROM runtime_executions WHERE id=ANY($1::uuid[]) AND payload IS NOT NULL',
  [[origin.executionId,child.executionId]]),0);
 assert.equal(await one('SELECT count(*)::int v FROM runtime_tool_calls WHERE execution_id=$1 AND result IS NOT NULL',[origin.executionId]),0);
 assert.equal(await one(`SELECT count(*)::int v FROM bill2_receipts r JOIN bill2_calls bc ON bc.id=r.call_id
  WHERE bc.run_id=$1 AND r.payload::text LIKE '%DESCENDANT_PRIVATE%'`,[child.runId]),0);
 assert.equal(await one('SELECT credits v FROM profiles WHERE id=$1',[f.actor]),balance);
 await c.query('ROLLBACK');
 report.checks.push('native whole-conversation erasure clears own-post source/descendant content and receipts, preserves 998 credits');

 await c.query('SET ROLE service_role');
 try{await rpc(c,'publish_monitor_disconnect',f.actor,connection);}finally{await c.query('RESET ROLE');}
 assert.equal((await rpc(c,'runtime_work_items',f.actor,started.sessionId))[origin.executionId],undefined);
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
