/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {runtimeExecutor} from './execute';
import {freezePromptCache} from './promptCache';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';
const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable'))
 throw new Error('isolated runner required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST!,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
beforeAll(()=>db.connect());
afterAll(()=>db.end());
async function rpc(name:string,args:Record<string,unknown>){
 const result=await admin.rpc(name,args);if(result.error)throw new Error(result.error.message);return result.data;
}
it.each(['write','read','legacy','bad-hash'] as const)('RUNTIME: prompt cache %s preserves frozen billing and crash replay',async mode=>{
 const actor=randomUUID(),modelId=randomUUID(),windowId=randomUUID(),requestId=randomUUID(),model='anthropic/cache-fixture';
 await db.query('insert into profiles(id,credits) values($1,100)',[actor]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,'opening:'+actor]);
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic cache',$2,'openrouter','true')",[modelId,model]);
 const session=await rpc('runtime_start',{p_actor_id:actor,p_request_id:randomUUID(),p_payload:{scope:{kind:'positioning_draft'}}});
 const providerLimits={providerSlug:'anthropic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'10',
  requestUsd:'0',...(mode==='legacy'?{}:{cacheWriteUsdPerMillion:'2.5'})};
 const upperUsd=openRouterBound(providerLimits,100).upperUsd;
 const policy={modelId,provider:'openrouter',account:'synthetic',model,protocol:'openrouter-chat-v1',providerLimits,
  upperUsd,inputLimit:10000,outputLimit:100,automaticRetry:false,hiddenTools:false,lookupSupported:true};
 const instructions='Pinned Skill\nFixed rules\n\nMutable material';
 const promptCache=freezePromptCache({real:true,role:'skill',model,instructions,skillChars:26,
  cacheWriteUsdPerMillion:providerLimits.cacheWriteUsdPerMillion});
 if(mode==='bad-hash')promptCache!.systemPrefixSha256='0'.repeat(64);
 // The SQL fixture freezes the same context as admission, isolating actual
 // execute/claim/dispatch/receipt/recovery behavior from Skill installation.
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',input:'Synthetic user',instructions,model,
  maxOutputTokens:100,maxTurns:1,historyItems:0,network:'deny',tools:[],providerRequestFormat:'serial-tools-v2',
  inputSelection:'scope-projection-v1',request:{sessionId:session.sessionId,requestId},...(promptCache?{promptCache}:{})};
 const billing={contractVersion:'bill2.v1',mode:'staging_test',testWindowId:windowId,scope:session.scope,operation:'question',
  modelId,sourceHash:hash(JSON.stringify(context)),input:context,callPolicy:[policy],
  rules:{version:'runtime-staging-v1',quoteVersion:windowId,creditsPerUsd:'1000',multiplier:'1',fx:{}},
  limits:{costUsd:upperUsd,credits:mode==='legacy'?21:26,maxPreDeduct:mode==='legacy'?21:26,maxCalls:1,deadline:new Date(Date.now()+3600000).toISOString()}};
 await db.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,1,1,now()+interval '2 hours')",[windowId,[actor],JSON.stringify([policy])]);
 const execution=await rpc('runtime_admit',{p_actor_id:actor,p_session_id:session.sessionId,p_request_id:requestId,
  p_payload:context,p_billing:billing});
 const usage={prompt_tokens:1000,completion_tokens:100,total_tokens:1100,cost:mode==='read'?0.0012:0.0035,
  prompt_tokens_details:{cached_tokens:mode==='read'?1000:0,cache_write_tokens:mode==='write'?1000:0}};
 let sent='';
 const transport=vi.fn<typeof fetch>(async(_url,init)=>{
  sent=String(init?.body);const parsed=JSON.parse(sent);
  if(mode==='legacy')expect(parsed.messages[0].content).toBe(instructions);
  else expect(parsed.messages[0].content[0].cache_control).toEqual({type:'ephemeral'});
  return new Response(JSON.stringify({id:'gen-cache-'+windowId,object:'chat.completion',created:1,model,
   choices:[{index:0,message:{role:'assistant',content:'Synthetic reply'},finish_reason:'stop'}],usage}));
 });
 const credential=vi.fn(async()=> 'SYNTHETIC_ONLY');
 const adapter=openRouterAdapter({credential,transport});
 let failCompletion=true;const replayHashes:string[]=[];
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')replayHashes.push(String(args.p_request_hash));
  if(name==='runtime_execution'&&args.p_action==='complete'&&failCompletion){
   failCompletion=false;return {data:null,error:{message:'synthetic crash before completion'}};
  }
  return admin.rpc(name,args);
 }};
 const execute=()=>runtimeExecutor({database,actor:async()=>actor,adapter}).execute(execution.executionId);
 if(mode==='bad-hash'){
  await execute();
  expect(transport).not.toHaveBeenCalled();expect(credential).not.toHaveBeenCalled();
  expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[execution.runId])).rows[0].n).toBe(0);
  return;
 }
 expect(await execute()).toMatchObject({state:'pending'});
 const result=await execute();expect(result).toMatchObject({state:'completed',body:'Synthetic reply'});
 expect(await execute()).toEqual(result);expect(transport).toHaveBeenCalledTimes(1);
 expect(new Set(replayHashes)).toEqual(new Set([hash(sent)]));
 const call=(await db.query('select payload from bill2_calls where run_id=$1',[execution.runId])).rows[0].payload;
 expect(call.requestHash).toBe(hash(sent));expect(call.providerLimits).toEqual(providerLimits);expect(call.upperUsd).toBe(upperUsd);
 const run=(await db.query('select state,charged,provider_cost_usd::text cost from bill2_runs where id=$1',[execution.runId])).rows[0];
 expect(run).toMatchObject({state:'settled',charged:mode==='read'?2:4});expect(Number(run.cost)).toBe(usage.cost);
 expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(mode==='read'?98:96);
});
