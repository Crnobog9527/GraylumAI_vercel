/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {runtimeExecutor} from './execute';
import {freezeHostPromptCache} from './promptCache';
import {freezeHistorySelection} from './hostTurn';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {openRouterBound} from '../bill2/openRouterPolicy';
import {allowTestCalls} from '../__tests__/fixtures/runtimeGates';
const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable'))
 throw new Error('isolated runner required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST!,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
beforeAll(()=>db.connect());afterAll(()=>db.end());
async function rpc(name:string,args:Record<string,unknown>){
 const result=await admin.rpc(name,args);if(result.error)throw new Error(result.error.message);return result.data;
}
it.each(['v2','off','history-off','bad-hash'] as const)('RUNTIME: H1 %s freezes trimmed members and crash replay without another claim',async mode=>{
 const actor=randomUUID(),modelId=randomUUID(),windowId=randomUUID(),model='anthropic/history-fixture';
 await db.query('insert into profiles(id,credits) values($1,1000)',[actor]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)",[actor,'opening:'+actor]);
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic H1',$2,'openrouter','true')",[modelId,model]);
 const session=await rpc('runtime_start',{p_actor_id:actor,p_request_id:randomUUID(),p_payload:{scope:{kind:'positioning_draft'}}});
 const providerLimits={providerSlug:'anthropic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'10',
  requestUsd:'0',cacheWriteUsdPerMillion:'2.5'};
 const upperUsd=openRouterBound(providerLimits,100).upperUsd;
 const policy={modelId,provider:'openrouter',account:'synthetic',model,protocol:'openrouter-chat-v1',providerLimits,
  upperUsd,inputLimit:10000,outputLimit:100,automaticRetry:false,hiddenTools:false,lookupSupported:true};
 await db.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,10,10,now()+interval '2 hours')",[windowId,[actor],JSON.stringify([policy])]);
 const instructions='Pinned Skill\nFixed rules';
 async function admit(seed=false){
  const requestId=randomUUID();
  const promptCache=seed||mode==='off'?undefined:freezeHostPromptCache({real:true,role:'skill',model,instructions,
   skillChars:12,cacheWriteUsdPerMillion:'2.5',mentor:true,additionalInstructions:'Fixed rules',stableAdditionalPrefix:'Fixed rules',
   historyMarker:mode!=='history-off'});
  if(mode==='bad-hash'&&promptCache)promptCache.systemPrefixSha256='0'.repeat(64);
  const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'skill',input:'Synthetic current',instructions,model,
   maxOutputTokens:100,maxTurns:1,historyItems:seed?0:32,network:'deny',tools:seed?[]:['ask_question'],maxToolCalls:seed?0:1,
   providerRequestFormat:seed?'serial-tools-v2':'agent-turn-v5-stream',
   inputSelection:seed?'scope-projection-v1':'scope-projection-v2',
   ...(!seed?{hostTurnContext:{stepId:'s1',opening:false,checklist:[]},reasoning:{parameter:'none'},
    historySelection:{...freezeHistorySelection(),currentReserveBytes:1000}}:{}),
   request:{sessionId:session.sessionId,requestId},...(promptCache?{promptCache}:{})};
  const billing={contractVersion:'bill2.v1',mode:'staging_test',testWindowId:windowId,scope:session.scope,operation:'question',
   modelId,sourceHash:hash(JSON.stringify(context)),input:context,callPolicy:[policy],
   rules:{version:'runtime-staging-v1',quoteVersion:windowId,creditsPerUsd:'1000',multiplier:'1',fx:{}},
   limits:{costUsd:upperUsd,credits:26,maxPreDeduct:26,maxCalls:1,deadline:new Date(Date.now()+3600000).toISOString()}};
  return rpc('runtime_admit',{p_actor_id:actor,p_session_id:session.sessionId,p_request_id:requestId,p_payload:context,p_billing:billing});
 }
 const sent:string[]=[];
 const credential=vi.fn(async()=> 'SYNTHETIC_ONLY');
 const transport=vi.fn<typeof fetch>(async(_url,init)=>{
  const wire=String(init?.body);sent.push(wire);const request=JSON.parse(wire);
  const response={id:'gen-h1-'+randomUUID(),object:'chat.completion',created:1,model,
   choices:[{index:0,message:{role:'assistant',content:'Synthetic reply'},finish_reason:'stop'}],
   usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110,cost:0.00035}};
  if(!request.stream)return new Response(JSON.stringify(response));
  return new Response('data: '+JSON.stringify({...response,object:'chat.completion.chunk',
   choices:[{index:0,delta:{role:'assistant',content:'Synthetic reply'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
   {headers:{'content-type':'text/event-stream'}});
 });
 const adapter=openRouterAdapter({credential,transport,allowAgentTools:true});
 const seed=await admit(true);
 expect(await runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>actor,adapter}).execute(seed.executionId))
  .toMatchObject({state:'completed'});
 // Only this test's local session: supply 48 available original members through
 // the existing SQL tables, then let actual admission freeze its candidate window.
 await db.query('delete from runtime_session_history where session_id=$1',[session.sessionId]);
 for(let revision=1;revision<=48;revision++)await db.query(
  'insert into runtime_session_history(session_id,revision,execution_id,item) values($1,$2,$3,$4)',
  [session.sessionId,revision,seed.executionId,JSON.stringify({role:revision%2?'user':'assistant',content:String(revision).padStart(100,'h')})]);
 await db.query('update runtime_sessions set revision=48 where id=$1',[session.sessionId]);
 const execution=await admit();
 let crash=true;const hashes:string[]=[];
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')hashes.push(String(args.p_request_hash));
  if(name==='runtime_execution'&&args.p_action==='complete'&&crash){crash=false;return {data:null,error:{message:'synthetic crash'}};}
  return admin.rpc(name,args);
 }};
 const execute=()=>runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>actor,adapter}).execute(execution.executionId);
 const before=sent.length;
 expect(await execute()).toMatchObject({state:mode==='bad-hash'?'cancelled':'pending'});
 const frozen=(await db.query('select selected_history from runtime_executions where id=$1',[execution.executionId])).rows[0].selected_history;
 expect(frozen.map(Number)).toEqual(Array.from({length:32},(_,i)=>i+17));
 if(mode==='bad-hash'){
  expect(sent).toHaveLength(before);
  expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[execution.runId])).rows[0].n).toBe(0);return;
 }
 // Code defaults differ from this frozen execution; replay must retain 1000.
 expect(freezeHistorySelection().currentReserveBytes).not.toBe(1000);
 const replay=await execute();
 expect(replay.state).toBe('completed');
 expect(JSON.parse('body' in replay ? replay.body! : '').message).toBe('Synthetic reply');
 expect(sent).toHaveLength(before+1);expect(new Set(hashes)).toEqual(new Set([hash(sent.at(-1)!)]));
 expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[execution.runId])).rows[0].n).toBe(1);
 const messages=JSON.parse(sent.at(-1)!).messages;
 expect(messages.filter((m:{content:unknown})=>Array.isArray(m.content))).toHaveLength(mode==='v2'?2:mode==='history-off'?1:0);
 expect(JSON.parse(messages.at(-1).content).hostTurnContext).toEqual({stepId:'s1',opening:false,checklist:[]});
});
