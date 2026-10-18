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
 await c.query('SET ROLE service_role');
 try{await rpc(c,'publish_monitor_disconnect',f.actor,connection);}finally{await c.query('RESET ROLE');}
 assert.equal(await one('SELECT closed v FROM bill2_runs WHERE id=$1',[f.run]),false);
 const receipts=()=>one('SELECT jsonb_agg(to_jsonb(r)) v FROM bill2_receipts r JOIN bill2_calls bc ON bc.id=r.call_id WHERE bc.run_id=$1',[f.run]);
 assert.match(JSON.stringify(await receipts()),/OWN_POST_PENDING_PRIVATE/);
 const waiting=await rpc(c,'runtime_library_propagate',f.actor,20);assert.ok(waiting.waiting>0);
 await rpc(c,'runtime_cancel',f.actor,execution);
 const money=await one('SELECT jsonb_build_object(\'credits\',p.credits,\'weighted\',r.weighted_nominal_usd) v FROM profiles p,bill2_runs r WHERE p.id=$1 AND r.id=$2',[f.actor,f.run]);
 const old=read('packages/db/migrations/0302_chat_library_search.sql');
 const at=old.indexOf('CREATE OR REPLACE FUNCTION public.runtime_library_propagate(');
 await c.query('BEGIN');await c.query(old.slice(at,old.indexOf('END $$;',at)+7));
 await rpc(c,'runtime_library_propagate',f.actor,20);
 assert.match(JSON.stringify(await receipts()),/OWN_POST_PENDING_PRIVATE/);
 report.checks.push('RED: old deletion worker leaves pre-disconnect receipt content after the original open run settles');
 await c.query('ROLLBACK');
 await rpc(c,'runtime_library_propagate',f.actor,20);await rpc(c,'runtime_library_propagate',f.actor,20);
 assert.doesNotMatch(JSON.stringify(await receipts()),/OWN_POST_PENDING_PRIVATE|rawBody/);
 assert.ok((await receipts()).every(r=>r.financial_projection_version===1));
 assert.deepEqual(await one('SELECT jsonb_build_object(\'credits\',p.credits,\'weighted\',r.weighted_nominal_usd) v FROM profiles p,bill2_runs r WHERE p.id=$1 AND r.id=$2',[f.actor,f.run]),money);
 report.checks.push('GREEN: existing worker retries the persisted pending copy after native settlement, projects receipts once and preserves money');
}
