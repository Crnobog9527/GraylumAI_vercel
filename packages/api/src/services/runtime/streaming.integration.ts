/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {jsonbBytes,fitNativeResult,attachNativeSummary} from './resultCapacity';
import {streamOriginalExecution,type ExecutionStreamEvent} from './executionStream';
import {allowTestCalls} from '../__tests__/fixtures/runtimeGates';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {logger} from '../../lib/logger';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {runtimeExecutor} from './execute';
import {QUESTION_CONTRACT,LEGACY_QUESTION_CONTRACT} from './agentTools';
import {createRuntimeBudget} from './budget';
import {runtimeActor} from './actor';
import {inflightFinancialHost} from './inflightFinancial';
import {recoverErasedAccounts,erasureFinancialBudget} from '../accountErasure/financialRecovery';
import type {BillingRpc} from '../bill2/service';
import {authoritativeBilling} from '../bill2/service';
import type {RuntimeProgress} from './progress';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import type {ReasoningPolicy} from './reasoningPolicy';
import {agentTurnBody,AGENT_TURN_MESSAGE_LIMIT,INVALID_REPLY_NOTICE,ASK_QUESTION_ARGUMENT_LIMIT} from '../../shared/agentTurn';
import {openRouterEvidence,decodeOpenRouterStreamObservation} from '../bill2/openRouterEvidence';

// Deliberately no remote fallback, application credentials or real model keys.
const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable'))throw new Error('isolated runner required');
if(!process.env.V3_LOCAL_REST?.startsWith('http://127.0.0.1:'))throw new Error('isolated REST required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
beforeAll(async()=>{await db.connect();});
afterAll(async()=>{await db.end();});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function rpc(name:string,args:Record<string,unknown>){const result=await admin.rpc(name,args);if(result.error)throw new Error(result.error.message);return result.data;}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function until(test:()=>boolean){const deadline=Date.now()+5000;while(!test()){if(Date.now()>deadline)throw new Error('synthetic progress deadline');await new Promise(resolve=>setTimeout(resolve,10));}}
async function fixture(format:'serial-tools-v2'|'serial-tools-v3-stream'|'serial-tools-v4-stream'|'agent-turn-v5-stream'|'serial-tools-v6-reasoning',organize=false,outputLimit=100,tool=false,reasoning?:{primary:ReasoningPolicy;organizer:ReasoningPolicy},opening=false,inputLimit=10000,fiveFields:boolean|'legacy'=false,native:boolean|'append'=false){
 const actorId=randomUUID(),mentorId=randomUUID(),organizerId=randomUUID(),windowId=randomUUID(),requestId=randomUUID();
 await db.query('insert into profiles(id,credits) values($1,100)',[actorId]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actorId,'stream-opening:'+actorId]);
 const session=await rpc('runtime_start',{p_actor_id:actorId,p_request_id:randomUUID(),p_payload:{scope:{kind:'positioning_draft'}}});
 const policies=[[mentorId,'synthetic/mentor'],[organizerId,'synthetic/organizer']].map(([modelId,model])=>({modelId,model,provider:'openrouter',account:'synthetic-stream',protocol:'openrouter-chat-v1',upperUsd:'0.02',inputLimit,outputLimit,automaticRetry:false,hiddenTools:false,lookupSupported:true,providerLimits:{providerSlug:'synthetic',contextTokens:inputLimit>10000?40000:10000,promptUsdPerMillion:inputLimit>10000?'0.5':'2',completionUsdPerMillion:'0',requestUsd:'0'}}));
 for(const policy of policies)await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic streaming integration',$2,'openrouter','true')",[policy.modelId,policy.model]);
 await db.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,0.10,3,now()+interval '2 hours')",[windowId,[actorId],JSON.stringify(policies)]);
 const context={...(native?{nativeOutput:'native-output-v1',...(native==='append'?{mentorText:'append-card-v1'}:{}),...(format==='serial-tools-v4-stream'?{envelopeOrder:'message-first-v1'}:{})}:{}),version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',inputSelection:'scope-projection-v1',providerRequestFormat:format,...(fiveFields?{questionContract:fiveFields==='legacy'?LEGACY_QUESTION_CONTRACT:QUESTION_CONTRACT}:{}),...(reasoning?{reasoning:reasoning.primary}:format==='serial-tools-v4-stream'||format==='agent-turn-v5-stream'?{reasoning:{effort:'none'}}:{}),input:opening?'HOST_OPEN_CURRENT_QUESTION':'Synthetic original input',instructions:'Return the public mentor message in the message property; keep protocol fields private.',model:policies[0]!.model,modelId:mentorId,maxOutputTokens:outputLimit,maxTurns:1,historyItems:20,network:'deny',tools:format==='agent-turn-v5-stream'?(fiveFields&&opening?[]:['ask_question']):tool?['read_source']:[],...(tool?{workspaceContext:true,maxToolCalls:1,maxTurns:2}:{}),request:{sessionId:session.sessionId,requestId,organizeAfter:false},...(organize?{attachedOrganizer:{modelId:organizerId,model:policies[1]!.model,maxOutputTokens:reasoning?outputLimit:100,...(reasoning?{reasoning:reasoning.organizer}:{}),instructions:'Synthetic organizer only',input:'Synthetic original input'}}:{})};
 const billing={contractVersion:'bill2.v1',mode:'staging_test',testWindowId:windowId,scope:session.scope,operation:'question',modelId:mentorId,sourceHash:hash('synthetic-stream'),input:context,callPolicy:organize?policies:[policies[0]],rules:{version:'runtime-staging-v1',quoteVersion:windowId,creditsPerUsd:'1000',multiplier:'1',fx:{}},limits:{costUsd:tool?'0.06':organize?'0.04':'0.02',credits:tool?60:organize?40:20,maxPreDeduct:tool?60:organize?40:20,maxCalls:tool?3:organize?2:1,deadline:new Date(Date.now()+3600000).toISOString()}};
 const execution=await rpc('runtime_admit',{p_actor_id:actorId,p_session_id:session.sessionId,p_request_id:requestId,p_payload:context,p_billing:billing});
 return {actorId,context,execution,session,billing};
}
function chunk(response:ServerResponse,id:string,model:string,delta:unknown,finish:string|null=null){response.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');}
function endStream(response:ServerResponse,id:string,model:string){
 chunk(response,id,model,{},'stop');
 response.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\n');
 response.end('data: [DONE]\n\n');
}
function completion(id:string,model:string,content:string){return JSON.stringify({id,object:'chat.completion',created:1,model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}});}

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([{format:'serial-tools-v3-stream' as const,native:false},{format:'serial-tools-v4-stream' as const,native:false},{format:'serial-tools-v4-stream' as const,native:true}])('RUNTIME: streaming $format native=$native real SDK/executor/BILL2 delivers public text before model and organizer completion, preserving one dispatch and immutable request',async({format,native})=>{
 const f=await fixture(format,true,100,false,undefined,false,10000,false,native),mentorGate=latch(),organizerGate=latch(),bodies:string[]=[],events:Array<{event:RuntimeProgress;at:number}>=[];
 const publicMessage='已经知道你的产品名称。请说说它主要帮助谁。',body=JSON.stringify({message:publicMessage,patches:[],privateProtocol:'PRIVATE_PROTOCOL'}),organizer='{"patches":[],"private":"PRIVATE_ORGANIZER"}';
 let mentorFinished=false,organizerStarted=false,organizerFinished=false,finished=false;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;bodies.push(raw);const request=JSON.parse(raw),id='gen-stream-'+f.execution.executionId+'-'+bodies.length;
  res.setHeader('x-generation-id',id);
  if(request.model==='synthetic/mentor'){
   res.setHeader('content-type','text/event-stream');
   chunk(res,id,request.model,{role:'assistant',reasoning:'PRIVATE_REASONING'});
   chunk(res,id,request.model,{content:'{"message":"已经知道你的产品名称。'});
   await mentorGate.promise;
   chunk(res,id,request.model,{content:'请说说它主要帮助谁。","patches":[],"privateProtocol":"PRIVATE_PROTOCOL"}'});
   mentorFinished=true;endStream(res,id,request.model);
  }else{
   organizerStarted=true;await organizerGate.promise;organizerFinished=true;
   res.setHeader('content-type','application/json');res.end(completion(id,request.model,organizer));
  }
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 const frozen=(await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload;
 const start=Date.now(),host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
 const running=host.execute(f.execution.executionId,event=>{events.push({event,at:Date.now()-start});}).then(result=>{finished=true;return result;});
 try{
  await until(()=>events.some(({event})=>event.type==='text'));
  expect(mentorFinished).toBe(false);expect(finished).toBe(false);expect(bodies).toHaveLength(1);
  expect(events.filter(({event})=>event.type==='text').map(({event})=>event.type==='text'?event.text:'')).toContain('已经知道你的产品名称。');
  const firstTextMs=events.find(({event})=>event.type==='text')!.at;
  mentorGate.release();await until(()=>organizerStarted);
  expect(organizerFinished).toBe(false);expect(finished).toBe(false);
  expect(events.filter(({event})=>event.type==='text').at(-1)?.event).toMatchObject({type:'text',text:publicMessage});
  expect(events.map(({event})=>event)).toContainEqual({type:'phase',phase:'organizer'});
  expect(JSON.stringify(events.map(({event})=>event.type==='text'?event.text:event))).not.toMatch(/PRIVATE_|patches|reasoning|encrypted|"message"/);
  const expected={state:'completed',body:native?JSON.stringify({message:publicMessage}):body,summary:organizer,
   ...(native?{completeness:'complete',messageFirst:true,organized:true}:{})};
  organizerGate.release();expect(await running).toEqual(expected);
  expect(await host.execute(f.execution.executionId)).toEqual(expected);
  expect(bodies).toHaveLength(2);expect(JSON.parse(bodies[0]!).stream).toBe(true);expect(JSON.parse(bodies[0]!).stream_options).toEqual({include_usage:true});
  expect(JSON.parse(bodies[1]!).stream).toBe(false);
  // Only the primary mentor call carries the frozen reasoning policy; the organizer keeps its bytes.
  expect(JSON.parse(bodies[0]!).reasoning_effort).toBe(format==='serial-tools-v4-stream'?'none':undefined);expect(bodies[1]).not.toMatch(/reasoning/);
  const calls=(await db.query('select id,payload,provider_id,state from bill2_calls where run_id=$1 order by sequence',[f.execution.runId])).rows;
  expect(calls).toHaveLength(2);expect(calls.map(call=>call.payload.requestHash)).toEqual(bodies.map(hash));
  expect(calls.map(call=>call.provider_id)).toEqual([1,2].map(n=>'gen-stream-'+f.execution.executionId+'-'+n));
  expect((await db.query("select count(*)::int n from bill2_receipts where call_id=any($1::uuid[]) and payload ? 'transport'",[calls.map(call=>call.id)])).rows[0].n).toBe(2);
  expect((await db.query('select state,closed,charged,actual_restore,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',closed:true,charged:6,actual_restore:34,cost:'0.006'});
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(94);
  expect((await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload).toEqual(frozen);
  console.info('Synthetic streaming segment timing',JSON.stringify({firstPublicTextMs:firstTextMs,mentorToOrganizerMs:events.find(({event})=>event.type==='phase'&&event.phase==='organizer')!.at,completedMs:Date.now()-start}));
 }finally{mentorGate.release();organizerGate.release();await running;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: streaming mid-body disconnect retains provider identity and uncertain reservation without POST retry or zero-cost refund',async()=>{
 const f=await fixture('serial-tools-v3-stream'),gate=latch(),events:RuntimeProgress[]=[];let posts=0;
 const id='gen-disconnect-'+f.execution.executionId;
 const server=createServer(async(req,res)=>{
  for await(const _ of req){/* consume only the local frozen request */}posts++;
  res.setHeader('content-type','text/event-stream');res.setHeader('x-generation-id',id);
  chunk(res,id,'synthetic/mentor',{role:'assistant',content:'{"message":"仅已收到的正文片段'});
  await gate.promise;res.destroy(new Error('Synthetic provider disconnect'));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 const running=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId,event=>{events.push(event);});
 try{
  await until(()=>events.some(event=>event.type==='text'));gate.release();
  expect(await running).toMatchObject({state:'pending'});expect(posts).toBe(1);
  const calls=(await db.query('select id,state,provider_id from bill2_calls where run_id=$1',[f.execution.runId])).rows;
  expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({state:'dispatched',provider_id:id});
  expect((await db.query('select state,charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toMatchObject({state:'cost_pending',charged:null,actual_restore:null});
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(80);
  const receipts=(await db.query("select payload from bill2_receipts where call_id=$1 and payload ? 'transport'",[calls[0].id])).rows;
  expect(receipts).toHaveLength(1);expect(JSON.stringify(receipts)).toContain(id);
  expect(events.some(event=>event.type==='phase'&&event.phase==='saving')).toBe(false);
 }finally{gate.release();await running;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: streaming old v2 frozen execution stays non-streaming and cached replay preserves original hash without another POST',async()=>{
 const f=await fixture('serial-tools-v2'),bodies:string[]=[],events:RuntimeProgress[]=[];
 const body='{"message":"Original non-streaming answer","patches":[]}';
 const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;bodies.push(raw);res.setHeader('content-type','application/json');res.end(completion('gen-v2-'+f.execution.executionId,'synthetic/mentor',body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 const frozen=(await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload;
 try{
  const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter}),result=await host.execute(f.execution.executionId,event=>{events.push(event);});
  expect(result).toEqual({state:'completed',body});expect(await host.execute(f.execution.executionId)).toEqual(result);expect(bodies).toHaveLength(1);
  const request=JSON.parse(bodies[0]!);expect(request.stream).toBe(false);expect(request.stream_options).toBeUndefined();
  expect(events.filter(event=>event.type==='text')).toEqual([{type:'text',text:'Original non-streaming answer'}]);
  expect((await db.query('select payload from bill2_calls where run_id=$1',[f.execution.runId])).rows[0].payload.requestHash).toBe(hash(bodies[0]!));
  expect((await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload).toEqual(frozen);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: streaming saved receipt replays through SDK after completion failure without POST, charge or history duplication',async()=>{
 const f=await fixture('serial-tools-v3-stream'),bodies:string[]=[],events:RuntimeProgress[]=[],responseHashes:string[]=[];
 const id='gen-stream-recovery-'+f.execution.executionId,publicMessage='这条真实传输的正文应从原始回执恢复。';
 const body=JSON.stringify({message:publicMessage,patches:[],privateProtocol:'PRIVATE_RECOVERY_PROTOCOL'});
 let completionFailed=false;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;bodies.push(raw);
  res.setHeader('content-type','text/event-stream');res.setHeader('x-generation-id',id);
  chunk(res,id,'synthetic/mentor',{role:'assistant',reasoning:'PRIVATE_STREAM_RECOVERY'});
  chunk(res,id,'synthetic/mentor',{content:body.slice(0,24)});
  chunk(res,id,'synthetic/mentor',{content:body.slice(24)});
  endStream(res,id,'synthetic/mentor');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')responseHashes.push(String(args.p_request_hash));
  // Provider response, durable receipt and SDK Session append have succeeded.
  // Lose only the first result write; recovery must use the original response.
  if(name==='runtime_execution'&&args.p_action==='complete'&&!completionFailed){completionFailed=true;return {data:null,error:{message:'Synthetic result persistence outage'}};}
  return admin.rpc(name,args);
 }};
 const frozen=(await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload;
 try{
  const options={database,actor:async()=>f.actorId,adapter};
  expect(await runtimeExecutor({...options,callGate:allowTestCalls}).execute(f.execution.executionId)).toEqual({state:'pending'});
  expect(completionFailed).toBe(true);expect(bodies).toHaveLength(1);expect(JSON.parse(bodies[0]!).stream).toBe(true);
  const call=(await db.query('select id,payload,provider_id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[f.execution.runId])).rows[0];
  expect(call.provider_id).toBe(id);expect(call.cost).toBe('0.003');expect(call.payload.requestHash).toBe(hash(bodies[0]!));
  const receiptBefore=(await db.query('select id,payload,payload_hash from bill2_receipts where call_id=$1',[call.id])).rows;
  expect(receiptBefore.filter(row=>row.payload.transport)).toHaveLength(1);
  expect(receiptBefore.filter(row=>!row.payload.transport)).toHaveLength(1);
  const historyBefore=(await db.query('select revision,execution_id,item from runtime_session_history where session_id=$1 order by revision',[f.session.sessionId])).rows;
  expect(historyBefore.length).toBeGreaterThan(0);expect(historyBefore.filter(row=>row.item.role==='assistant')).toHaveLength(1);
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(80);
  // Recreate the host: the SSE replay cannot rely on a process-local buffer.
  const recovered=await runtimeExecutor({...options,callGate:allowTestCalls}).execute(f.execution.executionId,event=>{events.push(event);});
  expect(recovered).toEqual({state:'completed',body});
  expect(events.filter(event=>event.type==='text').at(-1)).toEqual({type:'text',text:publicMessage});
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|patches|reasoning|encrypted/);
  expect(await runtimeExecutor({...options,callGate:allowTestCalls}).execute(f.execution.executionId)).toEqual(recovered);expect(bodies).toHaveLength(1);
  expect(responseHashes.length).toBeGreaterThanOrEqual(3);expect(new Set(responseHashes)).toEqual(new Set([hash(bodies[0]!)]));
  expect((await db.query('select id,payload,provider_id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[f.execution.runId])).rows).toEqual([call]);
  expect((await db.query('select id,payload,payload_hash from bill2_receipts where call_id=$1',[call.id])).rows).toEqual(receiptBefore);
  expect((await db.query('select revision,execution_id,item from runtime_session_history where session_id=$1 order by revision',[f.session.sessionId])).rows).toEqual(historyBefore);
  expect((await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload).toEqual(frozen);
  expect((await db.query('select state,closed,charged,actual_restore,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',closed:true,charged:3,actual_restore:17,cost:'0.003'});
  expect((await db.query("select credits,(select count(*)::int from billing_history where user_id=$1 and operation_type='settle') terminals from profiles where id=$1",[f.actorId])).rows[0]).toEqual({credits:97,terminals:1});
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: streaming 4096 real SSE deltas above 512 KiB persist reversible evidence and settle once in BILL2',async()=>{
 const f=await fixture('serial-tools-v3-stream',false,4096),bodies:string[]=[],id='gen-large-'+f.execution.executionId,model='synthetic/mentor';
 const publicMessage='x'.repeat(4096),body=JSON.stringify({message:publicMessage,patches:[]});
 const frame=(delta:Record<string,unknown>,finish:string|null=null)=>'data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
 const wire=Array.from({length:4096},(_,i)=>frame({content:(i===0?'{"message":"':'')+'x'+(i===4095?'","patches":[]}':'')})).join('')+
  frame({},'stop')+'data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices:[],usage:{prompt_tokens:10,completion_tokens:4096,total_tokens:4106,cost:0.003}})+'\n\ndata: [DONE]\n\n';
 expect(Buffer.byteLength(wire)).toBeGreaterThan(524288);
 const server=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;bodies.push(raw);res.setHeader('content-type','text/event-stream');res.setHeader('x-generation-id',id);res.end(wire);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 try{
  const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter}),result=await host.execute(f.execution.executionId);
  expect(result).toEqual({state:'completed',body});expect(await host.execute(f.execution.executionId)).toEqual(result);expect(bodies).toHaveLength(1);expect(JSON.parse(bodies[0]!).max_tokens).toBe(4096);
  const call=(await db.query('select id,payload,provider_id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[f.execution.runId])).rows[0];
  expect(call.provider_id).toBe(id);expect(call.cost).toBe('0.003');expect(call.payload.requestHash).toBe(hash(bodies[0]!));
  const receipts=(await db.query("select payload,octet_length(payload::text) bytes from bill2_receipts where call_id=$1 and payload ? 'transport'",[call.id])).rows;
  expect(receipts).toHaveLength(1);expect(receipts[0].bytes).toBeLessThan(524288);expect(receipts[0].payload.sourceHash).toBe(hash(wire));
  expect(decodeOpenRouterStreamObservation(receipts[0].payload.transport).toString()).toBe(wire);expect(JSON.parse(receipts[0].payload.rawBody).choices[0].message.content).toBe(body);
  expect((await db.query('select state,closed,charged,actual_restore,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',closed:true,charged:3,actual_restore:17,cost:'0.003'});
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(97);
  console.info('Synthetic large SSE receipt',JSON.stringify({providerBytes:Buffer.byteLength(wire),postgresReceiptBytes:receipts[0].bytes,contentDeltas:4096,posts:bodies.length}));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: streaming tool waits for persisted receipt then continues mentor and organizer within three calls',async()=>{
 const f=await fixture('serial-tools-v3-stream',true,100,true),gate=latch(),bodies:string[]=[],body='{"message":"Source read completed.","patches":[]}',organizer='{"patches":[]}';let toolFrameSent=false,sourceReads=0;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;bodies.push(raw);const request=JSON.parse(raw),id='gen-tool-stream-'+f.execution.executionId+'-'+bodies.length;
  res.setHeader('x-generation-id',id);
  if(bodies.length===1){
   res.setHeader('content-type','text/event-stream');
   chunk(res,id,request.model,{tool_calls:[{index:0,id:'source-stream',type:'function',function:{name:'read_source',arguments:'{}'}}]},'tool_calls');toolFrameSent=true;
   await gate.promise;
   res.write('data: '+JSON.stringify({id,model:request.model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\n');res.end('data: [DONE]\n\n');
  }else if(bodies.length===2){res.setHeader('content-type','text/event-stream');chunk(res,id,request.model,{content:body});endStream(res,id,request.model);}
  else{res.setHeader('content-type','application/json');res.end(completion(id,request.model,organizer));}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({allowWorkspaceRead:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_workspace_source'){
   sourceReads++;const rows=(await db.query("select count(*)::int n from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1 and r.payload ? 'transport'",[f.execution.runId])).rows;
   expect(rows[0].n).toBe(1);
  }
  return admin.rpc(name,args);
 }};
 const host=runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter}),running=host.execute(f.execution.executionId);
 try{
  await until(()=>toolFrameSent);await new Promise(resolve=>setTimeout(resolve,40));expect(sourceReads).toBe(0);expect(bodies).toHaveLength(1);
  expect((await db.query('select count(*)::int n from runtime_tool_calls where execution_id=$1',[f.execution.executionId])).rows[0].n).toBe(0);
  gate.release();expect(await running).toEqual({state:'completed',body,summary:organizer});expect(sourceReads).toBe(1);expect(bodies).toHaveLength(3);
  expect(bodies.map(value=>JSON.parse(value).stream)).toEqual([true,true,false]);expect(JSON.parse(bodies[1]!).messages.some((message:{role:string})=>message.role==='tool')).toBe(true);
  expect((await db.query('select count(*)::int n from runtime_tool_calls where execution_id=$1',[f.execution.executionId])).rows[0].n).toBe(1);
  expect((await db.query('select state,closed,charged,actual_restore,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',closed:true,charged:9,actual_restore:51,cost:'0.009'});
  expect(await host.execute(f.execution.executionId)).toEqual({state:'completed',body,summary:organizer});expect(bodies).toHaveLength(3);
 }finally{gate.release();await running;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

// Exercise the frozen v5 context through the real SDK, transport and database.
it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([{finish:'tool_calls',native:false},{finish:'length',native:false},{finish:'length',native:true}])('RUNTIME: streaming Agent turn keeps the first of two question cards, bills one call and replays without POST (finish $finish native=$native)',async({finish,native})=>{
 const f=await fixture('agent-turn-v5-stream',false,100,false,undefined,false,10000,false,native),bodies:string[]=[],events:RuntimeProgress[]=[],id='gen-agent-'+f.execution.executionId,model='synthetic/mentor';
 const card={question:'你现在主要在哪个平台发内容？',options:['小红书','抖音'],recommended:null};
 const call=(index:number,callId:string,args:unknown)=>({tool_calls:[{index,id:callId,type:'function',function:{name:'ask_question',arguments:JSON.stringify(args)}}]});
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;bodies.push(raw);
  res.setHeader('content-type','text/event-stream');res.setHeader('x-generation-id',id);
  chunk(res,id,model,{role:'assistant',reasoning:'PRIVATE_AGENT_REASONING'});chunk(res,id,model,{content:'先了解一下你的情况。'});
  chunk(res,id,model,call(0,'call_first',card));chunk(res,id,model,call(1,'call_second',{question:'SECOND_CARD',options:['x','y']}));
  chunk(res,id,model,{},finish);
  res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 const warned=vi.spyOn(logger,'warn');
 try{
  const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter}),result=await host.execute(f.execution.executionId,event=>{events.push(event);});
  const request=JSON.parse(bodies[0]!);
  expect(bodies).toHaveLength(1);expect(request).not.toHaveProperty('parallel_tool_calls');expect(request).not.toHaveProperty('tool_choice');
  expect(request).toMatchObject({stream:true,reasoning_effort:'none'});expect(request.tools.map((t:{function:{name:string}})=>t.function.name)).toEqual(['ask_question']);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|SECOND_CARD/);
  expect(events.filter(event=>event.type==='text').at(-1)).toMatchObject({type:'text',text:native?INVALID_REPLY_NOTICE:'先了解一下你的情况。'});
  const call=(await db.query('select id,payload,provider_id from bill2_calls where run_id=$1',[f.execution.runId])).rows;
  expect(call).toHaveLength(1);expect(call[0].payload.requestHash).toBe(hash(bodies[0]!));
  // The provider response stays whole as evidence, including the dropped call.
  const receipt=(await db.query("select payload from bill2_receipts where call_id=$1 and payload ? 'transport'",[call[0].id])).rows[0].payload;
  expect(decodeOpenRouterStreamObservation(receipt.transport).toString()).toContain('call_second');
  if(finish==='tool_calls'){
   expect(result).toEqual({state:'completed',body:agentTurnBody('先了解一下你的情况。',card)});
   expect(events.filter(event=>event.type==='card')).toEqual([{type:'card',card}]);
   expect(warned.mock.calls.filter(c=>c[1]==='runtime_tool_calls_dropped')).toEqual([['api','runtime_tool_calls_dropped',{executionId:f.execution.executionId,dropped:1}]]);
   const history=JSON.stringify((await db.query('select item from runtime_session_history where session_id=$1 order by revision',[f.session.sessionId])).rows);
   expect(history).toContain('call_first');expect(history).not.toContain('call_second');
   expect((await db.query('select state,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',charged:3});
  }else{
   // A tool call cut off by the output limit is never executed or shown.
   expect(result).toMatchObject({unavailable:'output_truncated'});
   expect((await db.query('select count(*)::int n from runtime_tool_calls where execution_id=$1',[f.execution.executionId])).rows[0].n).toBe(0);
   expect(events.filter(event=>event.type==='card')).toEqual([]);
   expect(JSON.stringify((await db.query('select item from runtime_session_history where session_id=$1',[f.session.sessionId])).rows)).not.toContain('call_first');
  }
  // Replay after the outcome: the stored result, no further provider POST.
  expect(await runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId)).toMatchObject({state:result.state});
  expect(bodies).toHaveLength(1);
 }finally{warned.mockRestore();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([
 {format:'serial-tools-v4-stream',primary:{parameter:'reasoning',value:{enabled:false}},organizer:{parameter:'reasoning',value:{max_tokens:2048}}},
 {format:'serial-tools-v4-stream',primary:{effort:'none'},organizer:{parameter:'none'}},
 {format:'serial-tools-v6-reasoning',primary:{parameter:'none'},organizer:{effort:'max'}},
] as const)('RUNTIME: MR-2 $format frozen primary/organizer bytes replay after config changes with one settlement',async settings=>{
 const f=await fixture(settings.format,true,4096,false,settings),bodies:string[]=[],replayed:string[]=[];
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  const raw=String(init!.body);bodies.push(raw);const request=JSON.parse(raw);
  const id='gen-mr2-'+f.execution.executionId+'-'+bodies.length;
  if(request.stream){
   const frame={id,object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta:{role:'assistant',content:'Synthetic answer'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}};
   return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  return new Response(completion(id,request.model,'Synthetic answer'),{headers:{'content-type':'application/json'}});
 }});
 let failComplete=true;
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')replayed.push(String(args.p_request_hash));
  if(name==='runtime_execution'&&args.p_action==='complete'&&failComplete){failComplete=false;return {data:null,error:{message:'Synthetic completion write failure'}};}
  return admin.rpc(name,args);
 }};
 const host=runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter});
 expect(await host.execute(f.execution.executionId)).toMatchObject({state:'pending'});
 const frozen=(await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload;
 // Deliberately replace live configuration after both paid responses were retained.
 await db.query('update ai_models set config=$1 where id=any($2::uuid[])',[JSON.stringify({reasoning:{purposes:{}}}),f.billing.callPolicy.map(p=>p!.modelId)]);
 expect(await host.execute(f.execution.executionId)).toMatchObject({state:'completed',body:'Synthetic answer',summary:'Synthetic answer'});
 expect(await host.execute(f.execution.executionId)).toMatchObject({state:'completed'});
 expect(bodies).toHaveLength(2);
 const fields=(policy:ReasoningPolicy)=>'effort' in policy?{reasoning_effort:policy.effort}:policy.parameter==='reasoning'?{reasoning:policy.value}:{};
 for(const [index,policy] of [settings.primary,settings.organizer].entries()){
  const request=JSON.parse(bodies[index]!);
  expect(Object.fromEntries(Object.entries(request).filter(([key])=>['reasoning','reasoning_effort'].includes(key)))).toEqual(fields(policy));
 }
 const calls=(await db.query('select id,payload from bill2_calls where run_id=$1 order by sequence',[f.execution.runId])).rows;
 expect(calls.map(call=>call.payload.requestHash)).toEqual(bodies.map(hash));
 expect(new Set(replayed)).toEqual(new Set(bodies.map(hash)));expect(replayed.length).toBeGreaterThan(4);
 expect((await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload).toEqual(frozen);
 expect((await db.query("select count(*)::int n from bill2_receipts where call_id=any($1::uuid[]) and payload ? 'transport'",[calls.map(c=>c.id)])).rows[0].n).toBe(2);
 expect((await db.query('select state,charged,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',charged:6,cost:'0.006'});
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",[f.execution.runId])).rows[0].n).toBe(1);
});


it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([
 {format:'serial-tools-v4-stream',lostInterrupt:false},
 {format:'agent-turn-v5-stream',lostInterrupt:false},
 {format:'agent-turn-v5-stream',lostInterrupt:true},
] as const)(
 'RUNTIME: $format opening receipts recover with frozen bytes and one settlement (lost interrupt=$lostInterrupt)',async({format,lostInterrupt})=>{
 const v5=format==='agent-turn-v5-stream',f=await fixture(format,v5,4096,false,undefined,true),bodies:string[]=[],replayed:string[]=[];
 // Host attaches the organizer independently of the preserved original request.
  const text='这是可以核对的具体建议。',body=v5?agentTurnBody(text,null):JSON.stringify({message:text,informationPatch:{}});
 const summary='{"inputKind":"answer","informationPatch":{}}';
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  const raw=String(init!.body);bodies.push(raw);const request=JSON.parse(raw),id='gen-opening-'+f.execution.executionId+'-'+bodies.length;
  if(request.stream){
   const frame={id,object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta:{role:'assistant',content:v5?text:body},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}};
   return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  return new Response(completion(id,request.model,summary),{headers:{'content-type':'application/json'}});
 }});
 let failComplete=true;
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_response')replayed.push(String(args.p_request_hash));
  if(name==='runtime_execution'&&args.p_action==='complete'&&failComplete){failComplete=false;return {data:null,error:{message:'Synthetic completion write failure'}};}
  // Model a process loss after durable replies: no interrupt transition reached SQL.
  if(lostInterrupt&&name==='runtime_execution'&&args.p_action==='interrupt')return {data:null,error:{message:'Synthetic process loss'}};
  return admin.rpc(name,args);
 }};
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter});
 expect(await host().execute(f.execution.executionId)).toEqual({state:'pending'});
 expect((await db.query('select state from runtime_executions where id=$1',[f.execution.executionId])).rows[0].state)
  .toBe(lostInterrupt?'running':'interrupted');
 expect(bodies).toHaveLength(v5?2:1);
 const saved=(await db.query('select payload,primary_result from runtime_executions where id=$1',[f.execution.executionId])).rows[0];
 expect(saved.payload.request.organizeAfter).toBe(false);
 expect(saved.payload.providerRequestFormat).toBe(format);
 expect(Boolean(saved.payload.attachedOrganizer)).toBe(v5);
 if(v5)expect(saved.primary_result).toMatchObject({body,truncated:false});
 await db.query('update ai_models set config=$1 where id=any($2::uuid[])',[JSON.stringify({reasoning:{purposes:{}}}),f.billing.callPolicy.map(p=>p!.modelId)]);
 const result={state:'completed',body,...(v5?{summary}:{})};
 expect(await host().execute(f.execution.executionId)).toEqual(result);
 expect(await host().execute(f.execution.executionId)).toEqual(result);
 expect(bodies).toHaveLength(v5?2:1);
 const calls=(await db.query('select id,payload from bill2_calls where run_id=$1 order by sequence',[f.execution.runId])).rows;
 expect(calls.map(call=>call.payload.requestHash)).toEqual(bodies.map(hash));
 expect(new Set(replayed)).toEqual(new Set(bodies.map(hash)));
 expect((await db.query('select payload from runtime_executions where id=$1',[f.execution.executionId])).rows[0].payload).toEqual(saved.payload);
 expect((await db.query('select state,charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',charged:v5?6:3,actual_restore:v5?34:17});
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",[f.execution.runId])).rows[0].n).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: v5 opening unknown organizer dispatch preserves two-call reservation without duplicate dispatch or spend',async()=>{
 const f=await fixture('agent-turn-v5-stream',true,100,false,undefined,true),body=agentTurnBody('已有开场建议。',null);let posts=0,dispatches=0;
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  posts++;const request=JSON.parse(String(init!.body)),id='gen-unknown-opening-'+f.execution.executionId;
  const frame={id,object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta:{role:'assistant',content:'已有开场建议。'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}};
  return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='bill2_dispatch'&&++dispatches===2){const committed=await admin.rpc(name,args);if(committed.error)throw committed.error;return {data:null,error:{message:'Synthetic lost organizer dispatch response'}};}
  return admin.rpc(name,args);
 }};
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter});
 expect(await host().execute(f.execution.executionId)).toEqual({state:'pending'});
 expect(posts).toBe(1);
 const snapshot=async()=>(await db.query('select c.id,c.state,c.provider_id,c.payload from bill2_calls c where run_id=$1 order by sequence',[f.execution.runId])).rows;
 const original=await snapshot();expect(original).toHaveLength(2);expect(original[1].provider_id).toBeNull();
 expect((await db.query('select primary_result from runtime_executions where id=$1',[f.execution.executionId])).rows[0].primary_result).toMatchObject({body,truncated:false});
 await host().execute(f.execution.executionId);await host().execute(f.execution.executionId);
 expect(await snapshot()).toEqual(original);expect(posts).toBe(1);
 expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(60);
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code in ('bill2_spend','bill2_restore')",[f.execution.runId])).rows[0].n).toBe(0);
});


it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['empty','invalid-card','long'] as const)(
 'RUNTIME: v5 %s paid reply persists its safe envelope and checkpoint, replay never dispatches twice',async scenario=>{
 const f=await fixture('agent-turn-v5-stream',true,4096,false,undefined,false,30000),bodies:string[]=[],events:RuntimeProgress[]=[];
 const text=scenario==='long'?'x'.repeat(AGENT_TURN_MESSAGE_LIMIT+7):'';
 const message=scenario==='long'?text.slice(0,AGENT_TURN_MESSAGE_LIMIT):INVALID_REPLY_NOTICE;
 const body=agentTurnBody(message,null),summary='{"informationPatch":{}}';
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  bodies.push(String(init!.body));const request=JSON.parse(bodies.at(-1)!),id='gen-safe-'+f.execution.executionId+'-'+bodies.length;
  if(!request.stream)return new Response(completion(id,request.model,summary),{headers:{'content-type':'application/json'}});
  const frames:unknown[]=[{role:'assistant',content:text}];
  if(scenario==='invalid-card')frames.push({tool_calls:[{index:0,id:'bad-card',type:'function',function:{name:'ask_question',arguments:'{"question":"","options":[]}'}}]});
  const wire=frames.map((delta,index)=>'data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model:request.model,choices:[{index:0,delta,finish_reason:index===frames.length-1?(scenario==='invalid-card'?'tool_calls':'stop'):null}]})+'\n\n').join('');
  return new Response(wire+'data: '+JSON.stringify({id,model:request.model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
 expect(await host().execute(f.execution.executionId,event=>events.push(event))).toEqual({state:'completed',body,summary});
 expect(events.filter(event=>event.type==='card')).toEqual([]);
 expect(events.filter(event=>event.type==='text').at(-1)).toEqual({type:'text',text:message});
 const saved=(await db.query('select result,primary_result from runtime_executions where id=$1',[f.execution.executionId])).rows[0];
 expect(saved.result).toMatchObject({body,truncated:scenario==='long'});
 expect(saved.primary_result).toMatchObject({body,truncated:scenario==='long'});
 expect(await host().execute(f.execution.executionId)).toEqual({state:'completed',body,summary});expect(bodies).toHaveLength(2);
 expect((await db.query("select count(*)::int n from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1 and r.payload ? 'transport'",[f.execution.runId])).rows[0].n).toBe(2);
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",[f.execution.runId])).rows[0].n).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([8192,32768])('RUNTIME: %i one-token frames finish as clean output_truncated',async(outputLimit)=>{
 const f=await fixture('serial-tools-v4-stream',true,outputLimit,false,undefined,false,40000);
 let sends=0;
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  sends++;
  const request=JSON.parse(String(init!.body));
  expect(request.max_tokens).toBe(outputLimit);
  const envelope={id:'gen-token-frames-'+f.execution.executionId,model:request.model,object:'chat.completion.chunk'};
  const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({...envelope,
   choices:[{index:0,delta,finish_reason}]})+'\n\n';
  const wire=frame({role:'assistant'})+frame({reasoning:'x'}).repeat(outputLimit)+frame({},'length')+
   'data: '+JSON.stringify({...envelope,choices:[],usage:{prompt_tokens:10,completion_tokens:outputLimit,
    total_tokens:outputLimit+10,cost:0.003}})+'\n\ndata: [DONE]\n\n';
  expect(Buffer.byteLength(wire)).toBeLessThan(16_777_216);
  return new Response(wire,{headers:{'content-type':'text/event-stream'}});
 }});
 const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
 const result=await host.execute(f.execution.executionId);
 expect(result).toEqual({state:'cancelled',unavailable:'output_truncated'});
 const calls=(await db.query('select id from bill2_calls where run_id=$1',[f.execution.runId])).rows;
 expect(calls).toHaveLength(1);
 const receipt=(await db.query("select payload from bill2_receipts where call_id=$1 and payload ? 'transport'",[calls[0].id])).rows[0].payload;
 expect(receipt).toMatchObject({final:true,cost:'0.003',transport:{complete:true,transportIssue:null}});
 expect(receipt.usage.sdkResponse.choices[0]).toMatchObject({finish_reason:'length',
  message:{content:null,reasoning:'x'.repeat(outputLimit)}});
 expect((await db.query('select state,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0])
  .toEqual({state:'settled',charged:3});
 expect(await host.execute(f.execution.executionId)).toMatchObject({state:'cancelled'});
 expect(sends).toBe(1);
});


it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: full ask_question arguments persist with one card and one settlement',async()=>{
 const f=await fixture('agent-turn-v5-stream',false,8192);
 const card={question:'Synthetic range?',options:['First','Second'],recommended:null};
 const args=JSON.stringify(card).padEnd(ASK_QUESTION_ARGUMENT_LIMIT,' ');
 let sends=0;
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  sends++;
  const request=JSON.parse(String(init!.body));
  const envelope={id:'gen-arguments',model:request.model};
  const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({...envelope,
   choices:[{index:0,delta,finish_reason}]})+'\n\n';
  let wire=frame({role:'assistant',content:'Synthetic message'});
  for(let index=0;index<args.length;index+=2048){
   wire+=frame({tool_calls:[{index:0,...(index===0?{id:'call-long',type:'function'}:{}),
    function:{...(index===0?{name:'ask_question'}:{}),arguments:args.slice(index,index+2048)}}]});
  }
  wire+=frame({},'tool_calls')+'data: '+JSON.stringify({...envelope,choices:[],
   usage:{prompt_tokens:10,completion_tokens:8192,total_tokens:8202,cost:0.003}})+'\n\ndata: [DONE]\n\n';
  return new Response(wire,{headers:{'content-type':'text/event-stream'}});
 }});
 const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
 const result=await host.execute(f.execution.executionId);
 expect(result).toEqual({state:'completed',body:agentTurnBody('Synthetic message',card)});
 const receipt=(await db.query("select r.payload from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1 and r.payload ? 'transport'",
  [f.execution.runId])).rows[0].payload;
 expect(receipt.final).toBe(true);
 expect(receipt.usage.sdkResponse.choices[0].message.tool_calls[0].function.arguments).toBe(args);
 expect(decodeOpenRouterStreamObservation(receipt.transport).toString()).toContain('call-long');
 const history=(await db.query('select item from runtime_session_history where session_id=$1',[f.session.sessionId])).rows;
 expect(history.some(row=>row.item.type==='function_call'&&row.item.arguments===args)).toBe(true);
 expect(await host.execute(f.execution.executionId)).toEqual(result);
 expect(sends).toBe(1);
 expect((await db.query('select state,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0])
  .toEqual({state:'settled',charged:3});
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",
  [f.execution.runId])).rows[0].n).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['settled','refunded'] as const)(
 'RUNTIME: legacy >4000 invalid_stream %s recovery preserves verdict, ledger and receipts',async terminal=>{
 const f=await fixture('agent-turn-v5-stream',false,8192);
 const args=JSON.stringify({question:'Old range?',options:['First','Second'],recommended:null}).padEnd(4001,' ');
 let posts=0,lookups=0,projected=0;
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  const id='gen-legacy-'+f.execution.executionId;
  if(init?.method==='GET'){
   lookups++;
   return new Response(JSON.stringify({data:{id,model:'synthetic/mentor',total_cost:0.003,finish_reason:'tool_calls'}}));
  }
  posts++;
  const frame={id,model:'synthetic/mentor',choices:[{index:0,delta:{role:'assistant',content:null,
   tool_calls:[{index:0,id:'old-call',type:'function',function:{name:'ask_question',arguments:args}}]},finish_reason:'tool_calls'}],
   usage:{prompt_tokens:10,completion_tokens:100,total_tokens:110,cost:0.003}};
  return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',
   {headers:{'content-type':'text/event-stream'}});
 }});
 // Seed the historical saved verdict, not the current parser's verdict. The
 // transport is complete and retained: current reprojection really would pass.
 const oldDatabase={rpc:async(name:string,input:Record<string,unknown>)=>{
  if(name==='bill2_record'){
   const evidence=input.p_evidence as Record<string,unknown>;
   if(evidence.source==='response'){
    projected++;
    expect(evidence).toMatchObject({final:true,cost:'0.003'});
    return admin.rpc(name,{...input,p_evidence:{...evidence,rawBody:'',usage:null,cost:null,final:false,
     evidenceKind:'transport_observation',rejectedReason:'invalid_stream'}});
   }
  }
  return admin.rpc(name,input);
 }};
 expect(await runtimeExecutor({callGate:allowTestCalls,database:oldDatabase,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId))
  .toEqual({state:'pending'});
 const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
 await authoritativeBilling({admin,actor:async()=>f.actorId,adapter}).recoverReceipts(f.execution.runId);
 if(terminal==='refunded'){
  await rpc('bill2_close',{p_actor_id:f.actorId,p_run_id:f.execution.runId,p_outcome:'confirmed_failure',
   p_result:{kind:'confirmed_delivery_failure',evidenceRef:'legacy-invalid-stream',evidenceHash:hash('invalid_stream')}});
  await rpc('bill2_finalize',{p_actor_id:f.actorId,p_run_id:f.execution.runId});
 }
 await host.cancel(f.execution.executionId);
 const snapshot=async()=>({
  execution:(await db.query('select state,result,primary_result,payload from runtime_executions where id=$1',[f.execution.executionId])).rows,
  run:(await db.query('select state,outcome,result,charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows,
  receipts:(await db.query('select r.* from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1 order by r.created_at,r.id',[f.execution.runId])).rows,
  transactions:(await db.query('select * from credit_transactions where bill2_run_id=$1 order by id',[f.execution.runId])).rows,
  balance:(await db.query('select credits from profiles where id=$1',[f.actorId])).rows,
  history:(await db.query('select * from runtime_session_history where session_id=$1 order by revision',[f.session.sessionId])).rows,
 });
 const before=await snapshot();
 expect(before.run[0]).toMatchObject({state:terminal,charged:terminal==='settled'?3:0});
 const rejected=before.receipts.find(row=>row.payload.rejectedReason==='invalid_stream')!.payload;
 expect(openRouterEvidence(rejected.transport,{provider:'openrouter',account:'synthetic-stream',
  model:'synthetic/mentor',protocol:'openrouter-chat-v1'},'response')).toMatchObject({final:true,cost:'0.003'});
 const counts={posts,lookups,projected};
 for(let repeat=0;repeat<2;repeat++){
  expect(await host.execute(f.execution.executionId)).toEqual({state:'cancelled'});
  await host.recoverFinancial(f.execution.executionId);
  await rpc('bill2_finalize',{p_actor_id:f.actorId,p_run_id:f.execution.runId});
  // Even a conflicting close attempt cannot replace a terminal result.
  await rpc('bill2_close',{p_actor_id:f.actorId,p_run_id:f.execution.runId,p_outcome:'delivered',
   p_result:{kind:'usable_result',evidenceRef:'new-parser',evidenceHash:hash('new-parser')}});
 }
 expect(await snapshot()).toEqual(before);
 expect({posts,lookups,projected}).toEqual(counts);
 expect(posts).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['card','multiple','invalid','plain','opening'] as const)(
 'RUNTIME: five-field %s buffers prose and persists the sole public result',async scenario=>{
 const f=await fixture('agent-turn-v5-stream',false,8192,false,undefined,scenario==='opening',30000,true);
 const card={message:'Canonical card message',question:'Range?',options:['First','Second'],
  recommended:0,recommendationReason:'First matches your stated constraint'};
 const gate=latch(),seen=latch(),events:RuntimeProgress[]=[];
 let posts=0;
 const server=createServer(async(req,res)=>{
  posts++;let raw='';for await(const part of req)raw+=part;
  const request=JSON.parse(raw),id='gen-five-'+f.execution.executionId;
  if(scenario==='opening')expect(request.tools).toBeUndefined();
  else expect(request.tools[0].function.parameters.required).toEqual(expect.arrayContaining([
   'message','question','options','recommended','recommendationReason']));
  res.setHeader('content-type','text/event-stream');
  chunk(res,id,request.model,{role:'assistant',content:scenario==='invalid'?null:'Separate assistant text'});
  seen.release();await gate.promise;
  if((scenario==='card'||scenario==='multiple')||scenario==='invalid')chunk(res,id,request.model,{tool_calls:[{index:0,id:'five-call',type:'function',
   function:{name:'ask_question',arguments:JSON.stringify(scenario==='invalid'?{...card,recommendationReason:null}:card)}}]});
  if(scenario==='multiple')chunk(res,id,request.model,{tool_calls:[{index:1,id:'ignored-second',type:'function',
   function:{name:'ask_question',arguments:JSON.stringify({...card,message:'Ignored second card'})}}]});
  chunk(res,id,request.model,{},(scenario==='card'||scenario==='multiple')||scenario==='invalid'?'tool_calls':'stop');
  res.end('data: '+JSON.stringify({id,model:request.model,choices:[],
   usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('local listener required');
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 try{
  const budget=createRuntimeBudget();
  const host=()=>runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter,budget});
  const pending=host().execute(f.execution.executionId,event=>events.push(event));
  await Promise.race([seen.promise,pending.then(result=>{throw new Error('No stream: '+JSON.stringify(result));})]);
  if(scenario==='opening')await until(()=>events.some(event=>event.type==='text'));
  else expect(events.filter(event=>event.type==='text'||event.type==='card')).toEqual([]);
  gate.release();const result=await pending;
  const expected=agentTurnBody((scenario==='card'||scenario==='multiple')||scenario==='invalid'?card.message:'Separate assistant text',(scenario==='card'||scenario==='multiple')?card:null);
  expect(result).toEqual({state:'completed',body:expected});
  const texts=events.filter(event=>event.type==='text');
  expect(texts).toEqual(Array(scenario==='opening'?2:1).fill({type:'text',text:(scenario==='card'||scenario==='multiple')||scenario==='invalid'?card.message:'Separate assistant text'}));
  expect(budget.timing.summary().marks).toMatchObject({firstValidContentMs:expect.any(Number),fullModelReplyMs:expect.any(Number)});
  expect(events.filter(event=>event.type==='card')).toEqual((scenario==='card'||scenario==='multiple')?[{type:'card',card}]:[]);
  expect(await host().execute(f.execution.executionId)).toEqual(result);expect(posts).toBe(1);
 }finally{gate.release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['reason','duplicate','oversize','bad-message'] as const)(
 'RUNTIME: invalid five-field %s preserves paid message without assistant prose through interrupted replay',async kind=>{
 const f=await fixture('agent-turn-v5-stream',false,8192,false,undefined,false,30000,true);
 const card={message:kind==='bad-message'?' ': 'Paid valid public message',question:'Choose?',
  options:kind==='duplicate'?['Same','Same']:kind==='oversize'?['x'.repeat(201),'Other']:['First','Second'],
  recommended:0,recommendationReason:kind==='reason'?null:'Grounded reason'};
 let posts=0,failComplete=true;
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  posts++;const request=JSON.parse(String(init!.body));
  const frame={id:'gen-invalid-'+f.execution.executionId,model:request.model,choices:[{index:0,
   delta:{role:'assistant',content:null,tool_calls:[{index:0,id:'bad-card',type:'function',
    function:{name:'ask_question',arguments:JSON.stringify(card)}}]},finish_reason:'tool_calls'}],
   usage:{prompt_tokens:10,completion_tokens:100,total_tokens:110,cost:0.003}};
  return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_execution'&&args.p_action==='complete'&&failComplete){
   failComplete=false;return {data:null,error:{message:'Synthetic completion loss'}};
  }
  return admin.rpc(name,args);
 }};
 const expected=kind==='bad-message'?INVALID_REPLY_NOTICE:card.message;
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter});
 const first:RuntimeProgress[]=[],replayed:RuntimeProgress[]=[];
 expect(await host().execute(f.execution.executionId,event=>first.push(event))).toEqual({state:'pending'});
 const before=(await db.query('select r.* from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1',[f.execution.runId])).rows;
 const result={state:'completed',body:agentTurnBody(expected,null)};
 expect(await host().execute(f.execution.executionId,event=>replayed.push(event))).toEqual(result);
 expect(await host().execute(f.execution.executionId)).toEqual(result);
 for(const events of [first,replayed]){
  expect(events.filter(event=>event.type==='text')).toEqual([{type:'text',text:expected}]);
  expect(events.filter(event=>event.type==='card')).toEqual([]);
 }
 const history=(await db.query('select item from runtime_session_history where session_id=$1 order by revision',[f.session.sessionId])).rows;
 const toolResult=history.find(row=>row.item.type==='function_call_result')?.item;
 expect(JSON.stringify(toolResult)).toContain('card');
 expect(JSON.stringify(toolResult)).toContain('invalid');
 expect(JSON.stringify(toolResult)).not.toContain(card.message.trim()||'Paid valid public message');
 expect((await db.query('select r.* from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1',[f.execution.runId])).rows).toEqual(before);
 expect((await db.query('select state,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',charged:3});
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",[f.execution.runId])).rows[0].n).toBe(1);
 expect(posts).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([0,20])(
 'RUNTIME: attached organizer frozen history=%i preserves request replay and only explicit-zero skips history reads',async historyItems=>{
 const f=await fixture('agent-turn-v5-stream',true,8192,false,undefined,false,30000,true);
 const bodies:string[]=[];
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  const body=String(init!.body);bodies.push(body);const request=JSON.parse(body);
  const id='gen-history-'+f.execution.executionId+'-'+bodies.length;
  if(!request.stream)return new Response(completion(id,request.model,'Organized explicit material'));
  const content=bodies.length===1?'OLD_SESSION_ONLY':'Current primary reply';
  const frame={id,model:request.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],
   usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}};
  return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 expect(await runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId)).toMatchObject({state:'completed'});
 await db.query('update runtime_test_windows set max_calls=4 where id=$1',[f.billing.testWindowId]);
 const requestId=randomUUID();
 const context={...f.context,input:'Current answer',request:{...f.context.request,requestId},
  attachedOrganizer:{...f.context.attachedOrganizer!,historyItems,input:'EXPLICIT_ORGANIZER_INPUT'}};
 const billing={...f.billing,input:context};
 const next=await rpc('runtime_admit',{p_actor_id:f.actorId,p_session_id:f.session.sessionId,p_request_id:requestId,p_payload:context,p_billing:billing});
 let organizing=false,historyReads=0,failComplete=true;
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(organizing&&name==='runtime_session_items'&&args.p_action==='read'&&args.p_limit!==0)historyReads++;
  if(name==='runtime_execution'&&args.p_action==='complete'&&failComplete){failComplete=false;return {data:null,error:{message:'Synthetic completion loss'}};}
  return admin.rpc(name,args);
 }};
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter});
 const progress=(event:RuntimeProgress)=>{if(event.type==='phase')organizing=event.phase==='organizer';};
 expect(await host().execute(next.executionId,progress)).toEqual({state:'pending'});
 organizing=false;
 expect(await host().execute(next.executionId,progress)).toMatchObject({state:'completed'});
 expect(historyReads).toBe(historyItems===0?0:2);
 expect(bodies).toHaveLength(4);
 expect(bodies[2]).toContain('OLD_SESSION_ONLY'); // The mentor still gets its normal history.
 expect(bodies[3]!.includes('OLD_SESSION_ONLY')).toBe(historyItems>0);
 expect(bodies[3]).toContain('EXPLICIT_ORGANIZER_INPUT');
 expect(bodies[3]).toContain('Current primary reply');
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",[next.runId])).rows[0].n).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['legacy',true] as const)(
 'RUNTIME: question contract %s preserves its invalid-card primary checkpoint and organizer bytes on recovery',async contract=>{
 const f=await fixture('agent-turn-v5-stream',true,8192,false,undefined,false,30000,contract);
 const message='Valid prose inside invalid card';
 const expected=contract==='legacy'?INVALID_REPLY_NOTICE:message;
 const bodies:string[]=[];let failComplete=true;
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  bodies.push(String(init!.body));const request=JSON.parse(bodies.at(-1)!);
  const id='gen-checkpoint-'+f.execution.executionId+'-'+bodies.length;
  if(!request.stream)return new Response(completion(id,request.model,'Organized'));
  const frame={id,model:request.model,choices:[{index:0,delta:{role:'assistant',content:null,
   tool_calls:[{index:0,id:'invalid-card',type:'function',function:{name:'ask_question',
    arguments:JSON.stringify({message,question:'Choose?',options:['First','Second'],recommended:0,recommendationReason:null})}}]},
   finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}};
  return new Response('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 }});
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_execution'&&args.p_action==='complete'&&failComplete){failComplete=false;return {data:null,error:{message:'Synthetic completion loss'}};}
  return admin.rpc(name,args);
 }};
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter});
 expect(await host().execute(f.execution.executionId)).toEqual({state:'pending'});
 const checkpoint=(await db.query('select primary_result from runtime_executions where id=$1',[f.execution.executionId])).rows[0].primary_result;
 expect(checkpoint.body).toBe(agentTurnBody(expected,null));
 expect(JSON.parse(bodies[1]!).messages.at(-1).content).toContain(expected);
 const calls=(await db.query('select id,payload from bill2_calls where run_id=$1 order by sequence',[f.execution.runId])).rows;
 expect(await host().execute(f.execution.executionId)).toEqual({state:'completed',body:agentTurnBody(expected,null),summary:'Organized'});
 expect((await db.query('select primary_result from runtime_executions where id=$1',[f.execution.executionId])).rows[0].primary_result).toEqual(checkpoint);
 expect((await db.query('select id,payload from bill2_calls where run_id=$1 order by sequence',[f.execution.runId])).rows).toEqual(calls);
 expect(bodies).toHaveLength(2);
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",[f.execution.runId])).rows[0].n).toBe(1);
});

// DATA-ERASURE B2a host: a confirmation that commits while an execution is in
// flight. The executor must not read back, show or store late provider content.
const closeAccount=(actorId:string)=>db.query('select account_erasure_confirm_with_digests($1,$2,$3)',[actorId,randomUUID(),
 JSON.stringify([{kind:'email',key_version:'b2a_local_v1',digest:hash(actorId)}])]);
const replayOnly=(adapter:ReturnType<typeof openRouterAdapter>)=>({dispatch:async()=>{throw new Error('RUNTIME_DISPATCH_DISABLED');},lookup:adapter.lookup});
const fiveCard={message:'PRIVATE_CLOSED_CARD',question:'Range?',options:['First','Second'],recommended:null,recommendationReason:null};
async function closedProvider(format:'serial-tools-v2'|'agent-turn-v5-stream',gate:Promise<void>,seen:()=>void,onPost:()=>void){
 const server=createServer(async(req,res)=>{
  onPost();let raw='';for await(const part of req)raw+=part;
  const request=JSON.parse(raw),id='gen-closed-'+randomUUID();res.setHeader('x-generation-id',id);
  if(format==='serial-tools-v2'){
   seen();await gate;res.setHeader('content-type','application/json');
   res.end(completion(id,request.model,JSON.stringify({message:'PRIVATE_CLOSED_TEXT',patches:[]})));return;
  }
  res.setHeader('content-type','text/event-stream');
  chunk(res,id,request.model,{role:'assistant',content:'PRIVATE_CLOSED_TEXT'});
  seen();await gate;
  chunk(res,id,request.model,{tool_calls:[{index:0,id:'closed-call',type:'function',
   function:{name:'ask_question',arguments:JSON.stringify(fiveCard)}}]});
  chunk(res,id,request.model,{},'tool_calls');
  res.end('data: '+JSON.stringify({id,model:request.model,choices:[],
   usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('local listener required');
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 return {server,adapter};
}
const closedFixture=(format:'serial-tools-v2'|'agent-turn-v5-stream')=>format==='serial-tools-v2'?fixture(format):
 fixture(format,false,8192,false,undefined,false,30000,true);
async function expectNothingRetained(f:Awaited<ReturnType<typeof fixture>>,events:RuntimeProgress[]){
 expect(events.filter(event=>event.type==='text'||event.type==='card')).toEqual([]);
 expect(events).not.toContainEqual({type:'phase',phase:'saving'});
 expect(JSON.stringify(events)).not.toContain('PRIVATE_CLOSED');
 const history=JSON.stringify((await db.query('select item from runtime_session_history where session_id=$1',[f.session.sessionId])).rows);
 expect(history).not.toContain('PRIVATE_CLOSED');
 const execution=(await db.query('select state,result from runtime_executions where id=$1',[f.execution.executionId])).rows[0];
 expect(execution.result).toBeNull();expect(execution.state).not.toBe('completed');
}

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['serial-tools-v2','agent-turn-v5-stream'] as const)(
 'RUNTIME: erasure confirmed during the provider call (%s) keeps only a financial projection and shows nothing late',async format=>{
 const f=await closedFixture(format),gate=latch(),seen=latch(),events:RuntimeProgress[]=[];let posts=0;
 const {server,adapter}=await closedProvider(format,gate.promise,seen.release,()=>{posts++;});
 try{
  // After the confirmation, the host records the receipt once and makes no further Runtime call.
  const afterClose:string[]=[];let closing=false;
  const database={rpc:(name:string,args:Record<string,unknown>)=>{if(closing)afterClose.push(name);return admin.rpc(name,args);}};
  const pending=runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId,event=>events.push(event));
  await Promise.race([seen.promise,pending.then(result=>{throw new Error('No provider call: '+JSON.stringify(result));})]);
  await closeAccount(f.actorId);closing=true;gate.release();
  expect(await pending).toEqual({state:'pending'});expect(posts).toBe(1);expect(afterClose.filter(name=>name!=='bill2_record')).toEqual([]);expect(afterClose).toContain('bill2_record');
  await expectNothingRetained(f,events);
  const receipts=(await db.query('select r.payload,r.financial_projection_version v from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1',[f.execution.runId])).rows;
  expect(receipts.filter(row=>row.payload.final===true)).toHaveLength(1);
  expect(receipts.find(row=>row.payload.final===true)?.v).toBe(1);
  expect(JSON.stringify(receipts)).not.toContain('PRIVATE_CLOSED');
  // Trusted maintenance finishes the original run once; nothing is dispatched again.
  const recovered=await runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter:replayOnly(adapter)}).recoverFinancial(f.execution.executionId);
  expect(recovered.state).toBe('cancelled');expect(posts).toBe(1);
  expect((await db.query('select state,closed,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',closed:true,charged:3});
  expect((await db.query('select active_execution from runtime_sessions where id=$1',[f.session.sessionId])).rows[0].active_execution).toBeNull();
 }finally{gate.release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')(
 'RUNTIME: erasure confirmed after the receipt but before the Session write shows no card and stores no turn',async()=>{
 const f=await closedFixture('agent-turn-v5-stream'),gate=latch(),events:RuntimeProgress[]=[];let posts=0,closed=false;
 gate.release();
 const {server,adapter}=await closedProvider('agent-turn-v5-stream',gate.promise,()=>{},()=>{posts++;});
 // Close the account exactly before the first Session append of this turn.
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(!closed&&name==='runtime_session_items'&&args.p_action==='append'){closed=true;await closeAccount(f.actorId);}
  return admin.rpc(name,args);
 }};
 try{
  expect(await runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId,event=>events.push(event)))
   .toEqual({state:'pending'});
  expect(closed).toBe(true);expect(posts).toBe(1);
  await expectNothingRetained(f,events);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

function revocableRuntimeIdentity(actorId:string) {
 let revoked=false;
 const budget=createRuntimeBudget();
 const jwt='local.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.only';
 const auth={getSession:vi.fn(async()=>({data:{session:{access_token:jwt}},error:null})),
  getUser:vi.fn(async()=>({data:{user:revoked?null:{id:actorId}},error:revoked?{message:'Synthetic revoked token',status:401}:null}))};
 return {budget,auth,actor:runtimeActor(auth as unknown as Parameters<typeof runtimeActor>[0],actorId,budget),
  revoke:()=>{revoked=true;}};
}
it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['serial-tools-v2','agent-turn-v5-stream'] as const)(
 'RUNTIME: real Auth revocation during %s uses the dispatched host capability and automatically finishes late money',async format=>{
 const f=await closedFixture(format),identity=revocableRuntimeIdentity(f.actorId);
 const gate=latch(),seen=latch(),events:RuntimeProgress[]=[];let posts=0;
 const {server,adapter}=await closedProvider(format,gate.promise,seen.release,()=>{posts++;});
 const financial=inflightFinancialHost({database:admin,actorId:f.actorId,executionId:f.execution.executionId,
  actor:identity.actor,budget:identity.budget});
 // This is the same executor/financial-finally composition as executionStream, with local transport only.
 const pending=(async()=>{
  try{return await runtimeExecutor({callGate:allowTestCalls,database:financial.database,
   actor:identity.actor,budget:identity.budget,adapter}).execute(f.execution.executionId,event=>events.push(event));}
  finally{await financial.finish(adapter);}
 })();
 try{
  await Promise.race([seen.promise,pending.then(value=>{throw new Error('No provider: '+JSON.stringify(value));})]);
  await closeAccount(f.actorId);identity.revoke();
  await expect(identity.actor()).rejects.toThrow('RUNTIME_DENIED');
  gate.release();expect(await pending).toEqual({state:'pending'});
  await expectNothingRetained(f,events);
  expect(posts).toBe(1);
  expect((await db.query('select state,closed,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0])
   .toEqual({state:'settled',closed:true,charged:3});
  expect((await db.query('select state from runtime_executions where id=$1',[f.execution.executionId])).rows[0].state).toBe('cancelled');
  expect((await db.query('select active_execution from runtime_sessions where id=$1',[f.session.sessionId])).rows[0].active_execution).toBeNull();
  expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",
   [f.execution.runId])).rows[0].n).toBe(1);
  expect((await db.query('select r.payload from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1',
   [f.execution.runId])).rows.some(row=>JSON.stringify(row).includes('PRIVATE_CLOSED'))).toBe(false);
  await financial.finish(adapter);expect(posts).toBe(1);
 }finally{gate.release();await pending;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([false,true])(
 'RUNTIME: a new erasure batch closes a lost host with early ID=%s without replaying its model call',async withId=>{
 const f=await fixture('serial-tools-v3-stream'),identity=revocableRuntimeIdentity(f.actorId);
 const sent=latch(),earlySaved=latch(),tail=latch();let crashed=false,posts=0,lookups=0;
 const id='gen-lost-'+f.execution.executionId;
 const database:BillingRpc={rpc:async(name,args)=>{
  if(crashed)throw new Error('Synthetic invocation lost');
  const result=await admin.rpc(name,args);
  if(name==='bill2_record'&&!result.error&&(args.p_evidence as {providerId?:string}).providerId===id)earlySaved.release();
  return result;
 }};
 const adapter=openRouterAdapter({budget:identity.budget,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>{
   if(init?.method==='GET'){
    lookups++;return new Response(JSON.stringify({data:{id,model:'synthetic/mentor',total_cost:0.003,finish_reason:'stop'}}));
   }
   posts++;sent.release();
   return new Response(new ReadableStream<Uint8Array>({async start(controller){
    if(withId)controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id,model:'synthetic/mentor',
     choices:[{index:0,delta:{role:'assistant',content:'{"message":"partial'},finish_reason:null}]})+'\n\n'));
    await tail.promise;controller.close();
   }}),{headers:{'content-type':'text/event-stream',...(withId?{'x-generation-id':id}:{})}});
  }});
 // Simulate process loss after its already-durable dispatch/early ID: no invocation finally can run.
 const pending=runtimeExecutor({callGate:allowTestCalls,database,actor:identity.actor,budget:identity.budget,adapter})
  .execute(f.execution.executionId).catch(()=>({state:'lost'}));
 await Promise.race([withId?earlySaved.promise:sent.promise,pending.then(value=>{throw new Error('No dispatch: '+JSON.stringify(value));})]);
 await closeAccount(f.actorId);identity.revoke();crashed=true;tail.release();await pending;
 const before=(await db.query('select closed from bill2_runs where id=$1',[f.execution.runId])).rows[0];
 expect(before.closed).toBe(false);
 const call=(await db.query('select provider_id,selected_cost_usd from bill2_calls where run_id=$1',[f.execution.runId])).rows[0];
 expect(call).toEqual({provider_id:withId?id:null,selected_cost_usd:null});
 const freshAdapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  expect(init?.method).toBe('GET');lookups++;
  return new Response(JSON.stringify({data:{id,model:'synthetic/mentor',total_cost:0.003,finish_reason:'stop'}}));
 }});
 const report=await recoverErasedAccounts({database:admin,budget:erasureFinancialBudget(55_000),profileId:f.actorId,
  adapter:()=>freshAdapter});
 expect(report.failed).toBe(0);expect(report.processed).toBeGreaterThanOrEqual(1);
 expect(posts).toBe(1);expect(lookups).toBe(withId?1:0);
 expect((await db.query('select state,closed,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0])
  // Existing BILL2 finalize leaves the dispatched ledger state while actual cost is unknown.
  .toEqual({state:withId?'settled':'dispatched',closed:true,charged:withId?3:null});
 expect((await db.query('select provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0].cost)
  .toBe(withId?'0.003':null);
 expect((await db.query('select state from runtime_executions where id=$1',[f.execution.executionId])).rows[0].state)
  .toBe(withId?'cancelled':'cost_pending');
 expect((await db.query('select active_execution from runtime_sessions where id=$1',[f.session.sessionId])).rows[0].active_execution).toBeNull();
 expect(report.pending).toBe(withId?0:1);expect(report.success).toBe(withId);
 if(!withId){
  expect(report.oldestPendingAt).not.toBeNull();
  expect((await db.query('select actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0].actual_restore).toBeNull();
 }
});

it.each(['rejected','timeout','5xx','started'].flatMap(kind=>[false,true].map(native=>({kind,native}))))('RUNTIME: provider refusal boundary $kind native=$native preserves original execution',async({kind,native})=>{
 const f=await fixture('serial-tools-v4-stream',false,100,false,undefined,false,10000,false,native);let sends=0;
 const error={user_id:'synthetic-user',error:{code:402,message:'Synthetic refusal',
  metadata:{limit_source:'openrouter_key_limit',provider_name:null}}};
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  if(init?.method==='GET')return new Response('{}',{status:503});
  sends++;
  if(kind==='timeout')throw new Error('synthetic timeout');
  if(kind==='started')return new Response('data: '+JSON.stringify({id:'gen-started',model:'synthetic/mentor',
   choices:[{index:0,delta:{content:'partial'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify(error)+'\n\n',
   {status:200,headers:{'content-type':'text/event-stream'}});
  return new Response(JSON.stringify(error),{status:kind==='5xx'?503:402,headers:{'content-type':'application/json'}});
 }});
 const executor=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:allowTestCalls});
 await executor.execute(f.execution.executionId);
 await executor.execute(f.execution.executionId);
 // Cancellation/recovery never issues another provider POST, including a fresh process composition.
 await executor.cancel(f.execution.executionId);
 const recovered=await runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:allowTestCalls})
  .recoverFinancial(f.execution.executionId);
 expect(recovered.state).toBe(kind==='rejected'?'cancelled':'cost_pending');
 expect(sends).toBe(1);
 const run=(await db.query('select state,charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0];
 expect(run.state).toBe(kind==='rejected'?'refunded':kind==='started'?'cost_pending':'unknown');
 if(kind==='rejected')expect(run).toMatchObject({charged:0,actual_restore:20});
 else expect(run.actual_restore).toBeNull();
});


it.each(['not-found','zero','positive','missing-cost','mismatched-id'] as const)(
 'RUNTIME: strict 402 with header identity is queried immediately (%s)',async(kind)=>{
 const f=await fixture('serial-tools-v4-stream',false),id='gen-synthetic-'+f.execution.executionId;
 let posts=0,lookups=0;
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  if(init?.method==='GET'){
   lookups++;
   if(kind==='not-found')return new Response(JSON.stringify({error:{code:404,message:'Synthetic missing'}}),{status:404});
   return new Response(JSON.stringify({data:{id:kind==='mismatched-id'?'gen-synthetic-other':id,
    model:'synthetic/mentor',finish_reason:'stop',native_tokens_prompt:0,native_tokens_completion:0,
    ...(kind==='missing-cost'?{}:{total_cost:kind==='positive'?0.003:0})}}));
  }
  posts++;
  return new Response(JSON.stringify({user_id:'synthetic-user',error:{code:402,message:'Synthetic limit',
   metadata:{limit_source:'openrouter_key_limit',provider_name:null}}}),
   {status:402,headers:{'content-type':'application/json','x-generation-id':id}});
 }});
 const executor=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:allowTestCalls});
 await executor.execute(f.execution.executionId);
 await executor.cancel(f.execution.executionId);
 const recovered=await executor.recoverFinancial(f.execution.executionId);
 const confirmed=kind!=='mismatched-id';
 expect(recovered.state).toBe(confirmed?'cancelled':'cost_pending');
 expect(posts).toBe(1);expect(lookups).toBeGreaterThan(0);
 const run=(await db.query('select charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0];
 expect(run.actual_restore).toBe(confirmed?(kind==='positive'?17:20):null);
 const call=(await db.query('select provider_id,provider_rejected from bill2_calls where run_id=$1',[f.execution.runId])).rows[0];
 expect(call).toMatchObject({provider_id:id,provider_rejected:kind==='not-found'||kind==='missing-cost'});
 await executor.recoverFinancial(f.execution.executionId);
 expect(posts).toBe(1);
});

it.each(['missing','cost','terminal-no-cost','nonterminal-cost','timeout','5xx'] as const)(
 'RUNTIME: strict 402 uses two immediate bounded queries (%s)',async(kind)=>{
 const f=await fixture('serial-tools-v4-stream',false),id='gen-synthetic-'+f.execution.executionId;
 let posts=0,lookups=0;
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  if(init?.method==='GET'){
   lookups++;
   if(lookups===2){
    if(kind==='timeout')throw new Error('Synthetic query failure');
    if(kind==='5xx')return new Response('{}',{status:503});
    if(['cost','terminal-no-cost','nonterminal-cost'].includes(kind))return new Response(JSON.stringify({data:{
     id,model:'synthetic/mentor',user_id:'SYNTHETIC_PRIVATE',
     finish_reason:kind==='nonterminal-cost'?null:'stop',
     ...(kind==='terminal-no-cost'?{}:{total_cost:0.003})}}));
   }
   return new Response(JSON.stringify({user_id:'SYNTHETIC_PRIVATE',error:{code:404,message:'SYNTHETIC_PRIVATE'}}),{status:404});
  }
  posts++;
  return new Response(JSON.stringify({user_id:'SYNTHETIC_PRIVATE',error:{code:402,message:'SYNTHETIC_PRIVATE',
   metadata:{limit_source:'openrouter_key_limit',provider_name:null}}}),
   {status:402,headers:{'content-type':'application/json','x-generation-id':id}});
 }});
 const executor=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:allowTestCalls});
 await executor.execute(f.execution.executionId);
 const state=(await db.query('select provider_rejected,recovery_attempts from bill2_calls where run_id=$1',[f.execution.runId])).rows[0];
 expect(state.provider_rejected).toBe(kind==='missing'||kind==='terminal-no-cost');
 expect(state.recovery_attempts).toBe(1);
 expect(lookups).toBe(2);expect(posts).toBe(1);
 const run=(await db.query('select charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0];
 expect(run.actual_restore).toBe(['missing','terminal-no-cost'].includes(kind)?20:kind==='cost'?17:null);
 const receipts=(await db.query('select r.payload from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1',[f.execution.runId])).rows;
 expect(JSON.stringify(receipts)).not.toMatch(/SYNTHETIC_PRIVATE|rawBody|"transport"/);
 const audits=receipts.map(r=>r.payload.rejectionRecovery).filter(Boolean);
 expect(audits).toHaveLength(1);
 expect(audits[0].queryCount).toBe(2);
 expect(audits[0].queryTimes).toHaveLength(2);
 for(const audit of audits){expect(audit.claimedAt).toBeTruthy();expect(audit.observedAt).toBeTruthy();}
 await executor.recoverFinancial(f.execution.executionId);
 expect(lookups).toBe(2);expect(posts).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['step','large','fallback','card','length','plain-step','confirmed','empty','invalid-length'] as const)(
 'RUNTIME: native C0 C1 %s streams safely and replays a terminal snapshot without redispatch',async mode=>{
 const agent=mode==='card'||mode==='length';
 const f=await fixture(agent?'agent-turn-v5-stream':'serial-tools-v4-stream',false,mode==='large'?32768:8192,
  false,undefined,false,40000,agent,true);
 const card={question:'Private question?',options:['First','Second'],recommended:0,message:'公开😀正文',recommendationReason:'Private reason'};
 const text=mode==='large'?'文'.repeat(32768):mode==='empty'?'':mode==='length'?'长正文😀':card.message;
 const body=mode==='plain-step'?text:mode==='invalid-length'?'unfinished non-envelope':agent?text:JSON.stringify(
  mode==='fallback'?{informationPatch:{},message:text}:mode==='confirmed'?{message:text,informationPatch:{audience:{value:'读者',status:'confirmed',nature:'fact'}}}:{message:text,informationPatch:{}});
 const gate=latch(),started=latch();let posts=0;
 const server=createServer(async(req,res)=>{
  posts++;let raw='';for await(const part of req)raw+=part;
  const request=JSON.parse(raw),id='gen-native-'+f.execution.executionId;
  res.setHeader('content-type','text/event-stream');
  if(mode==='large'){
   expect(request.max_tokens).toBe(32768);
   for(let i=0;i<body.length-2;i+=2048)chunk(res,id,request.model,{content:body.slice(i,Math.min(i+2048,body.length-2))});
  }else chunk(res,id,request.model,{role:'assistant',content:mode==='card'?'Earlier prose':body.slice(0,body.length-2)});
  started.release();await gate.promise;
  if(mode==='card'){
   const args=JSON.stringify(card);
   chunk(res,id,request.model,{tool_calls:[{index:0,id:'native-card',type:'function',function:{name:'ask_question',arguments:''}}]});
   for(const char of args)chunk(res,id,request.model,{tool_calls:[{index:0,function:{arguments:char}}]});
  }else chunk(res,id,request.model,{content:body.slice(-2)});
  chunk(res,id,request.model,{},mode==='card'?'tool_calls':mode==='length'||mode==='invalid-length'?'length':'stop');
  res.end('data: '+JSON.stringify({id,model:request.model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('local listener required');
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
 const events:ExecutionStreamEvent[]=[];
 const running=(async()=>{for await(const e of streamOriginalExecution(cb=>host().execute(f.execution.executionId,cb),undefined,'test',undefined,'textDelta-v1'))events.push(e);})();
 try{
  await started.promise;
  const pendingEvents:RuntimeProgress[]=[];
  expect(await host().execute(f.execution.executionId,e=>pendingEvents.push(e))).toEqual({state:'pending'});
  expect(pendingEvents.filter(e=>e.type==='text')).toEqual([]);
  if(['fallback','plain-step','empty','invalid-length'].includes(mode))expect(events.filter((e)=>e.type==='textDelta')).toEqual([]);
  else await until(()=>events.some((e)=>e.type==='textDelta'));
  gate.release();await running;
  if(mode==='invalid-length'){
   expect(events.at(-1)).toMatchObject({type:'result',result:{state:'cancelled',unavailable:'output_truncated'}});
   expect((await db.query('select charged from bill2_runs where id=$1',[f.execution.runId])).rows[0].charged).toBe(3);
   expect(posts).toBe(1);return;
  }
  const frames=events.filter((e)=>e.type==='textDelta') as Array<{offset:number;rev:number;text:string}>;
  let displayed='';let rev=0;
  for(const frame of frames){
   if(frame.offset===0){displayed=frame.text;rev=frame.rev;}
   else{expect(frame.rev).toBe(rev);expect(frame.offset).toBe(Array.from(displayed).length);displayed+=frame.text;}
  }
  expect(displayed).toBe(text);
  const terminal=events.at(-1);if(terminal?.type!=='result')throw new Error('missing terminal');
  const result=terminal.result;
  expect(result).toMatchObject({state:'completed',completeness:mode==='length'?'length_limit':'complete'});
  if(!agent)expect(result.messageFirst).toBe(!['fallback','plain-step'].includes(mode));
  if(mode==='plain-step')expect(result.body).toBe(text);
  else expect(JSON.parse(result.body!).message).toBe(text);
  if(mode==='confirmed')expect(JSON.parse(result.body!).informationPatch.audience).toMatchObject({value:'读者',status:'provisional',nature:'fact'});
  const replay=[];for await(const e of streamOriginalExecution(cb=>host().execute(f.execution.executionId,cb),undefined,'test',undefined,'textDelta-v1'))replay.push(e);
  expect(replay).toEqual([{type:'textDelta',offset:0,rev:0,text,source:'final'},{type:'result',result}]);
  expect(posts).toBe(1);
  const saved=(await db.query('select result,octet_length(result::text) bytes from runtime_executions where id=$1',[f.execution.executionId])).rows[0];
  expect(saved.bytes).toBe(jsonbBytes(saved.result));expect(saved.bytes).toBeLessThanOrEqual(262144);
  const charges=await db.query('select count(*)::int n from bill2_calls where run_id=$1',[f.execution.runId]);
  expect(charges.rows[0].n).toBe(1);
 }finally{gate.release();await running;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: native capacity matches PostgreSQL jsonb bytes with escaped Unicode and summary omission',async()=>{
 for(const message of ['😀中\\\"\n'.repeat(60000),'x'.repeat(300000)]){
  const primary=fitNativeResult({body:JSON.stringify({message}),n:1e21,small:1e-7},{attachedOrganizer:true});
  const result=attachNativeSummary(primary,'summary');
  const measured=await db.query('select octet_length($1::jsonb::text) bytes',[JSON.stringify(result)]);
  expect(measured.rows[0].bytes).toBe(jsonbBytes(result));
  expect(measured.rows[0].bytes).toBeLessThanOrEqual(262144);
  expect(result.body).toBe(primary.body);expect(result.summaryOmitted).toBe(true);
 }
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: native streaming and frozen buffered calls settle identical billing evidence',async()=>{
 const settlements:unknown[]=[];
 for(const streamed of [false,true]){
  const f=await fixture(streamed?'serial-tools-v4-stream':'serial-tools-v2',false,8192,false,undefined,false,30000,false,streamed);
  const body='{"message":"Identical billed answer"}';let posts=0;
  const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
   posts++;const request=JSON.parse(String(init?.body)),id='gen-equal-'+f.execution.executionId;
   expect(request.stream).toBe(streamed);
   if(!streamed)return new Response(completion(id,request.model,body),{status:200,headers:{'content-type':'application/json'}});
   const chunks:string[]=[];
   const res={write:(part:string)=>chunks.push(part),end:(part:string)=>chunks.push(part)} as unknown as ServerResponse;
   chunk(res,id,request.model,{role:'assistant',content:body});endStream(res,id,request.model);
   return new Response(chunks.join(''),{status:200,headers:{'content-type':'text/event-stream'}});
  }});
  const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
  expect(await host.execute(f.execution.executionId)).toMatchObject({state:'completed',body});
  const evidence=(await db.query('select state,closed,charged,actual_restore,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0];
  settlements.push(evidence);
  const calls=(await db.query('select id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[f.execution.runId])).rows;
  expect(calls).toHaveLength(1);expect(calls[0].cost).toBe('0.003');
  const receipts=(await db.query('select payload_hash,payload from bill2_receipts where call_id=$1 order by id',[calls[0].id])).rows;
  await host.execute(f.execution.executionId);
  expect((await db.query('select payload_hash,payload from bill2_receipts where call_id=$1 order by id',[calls[0].id])).rows).toEqual(receipts);
  expect(posts).toBe(1);
 }
 expect(settlements).toEqual(Array(2).fill({state:'settled',closed:true,charged:3,actual_restore:17,cost:'0.003'}));
});


it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: native length body completes without dispatching an unusable attached organizer',async()=>{
 const f=await fixture('agent-turn-v5-stream',true,8192,false,undefined,false,30000,true,true);
 const message='x'.repeat(35000);let posts=0;
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  posts++;const request=JSON.parse(String(init?.body));
  expect(request.model).toBe('synthetic/mentor');
  const id='gen-omit-'+f.execution.executionId;
  return new Response('data: '+JSON.stringify({id,model:request.model,choices:[{index:0,
   delta:{role:'assistant',content:message},finish_reason:'length'}],
   usage:{prompt_tokens:10,completion_tokens:8192,total_tokens:8202,cost:0.003}})+'\n\ndata: [DONE]\n\n',
   {status:200,headers:{'content-type':'text/event-stream'}});
 }});
 const host=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter});
 const result=await host.execute(f.execution.executionId);
 expect(result).toMatchObject({state:'completed',summary:'',completeness:'length_limit',organized:false,summaryOmitted:true});
 if (!('body' in result) || typeof result.body!=='string') throw new Error('Expected saved primary body');
 expect(JSON.parse(result.body).message).toBe(message);
 expect(await host.execute(f.execution.executionId)).toEqual(result);expect(posts).toBe(1);
 const saved=(await db.query('select primary_result,result from runtime_executions where id=$1',[f.execution.executionId])).rows[0];
 expect(saved.primary_result.body).toBe(saved.result.body);expect(jsonbBytes(saved.result)).toBeLessThanOrEqual(262144);
 expect((await db.query('select state,closed,charged,actual_restore,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0])
  .toEqual({state:'settled',closed:true,charged:3,actual_restore:37,cost:'0.003'});
 expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[f.execution.runId])).rows[0].n).toBe(1);
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['call_limited','paused','limit_unavailable'] as const)(
 'RUNTIME: native first-call gate %s cancels with stable reason and no provider call or retry',async reason=>{
 const f=await fixture('serial-tools-v4-stream',false,100,false,undefined,false,10000,false,true);
 let posts=0;const events:RuntimeProgress[]=[];
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async()=>{
  posts++;throw new Error('gate must prevent transport');
 }});
 const gate=vi.fn(async()=>({ok:false as const,reason,retryAfter:60}));
 const host=()=>runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:gate});
 const result=await host().execute(f.execution.executionId,event=>events.push(event));
 expect(result).toEqual({state:'cancelled',unavailable:reason});
 expect(events.filter(event=>event.type==='text')).toEqual([]);
 expect(await host().execute(f.execution.executionId)).toMatchObject({state:'cancelled'});
 expect(posts).toBe(0);expect(gate).toHaveBeenCalledTimes(1);
 expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[f.execution.runId])).rows[0].n).toBe(0);
 expect((await db.query('select charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0])
  .toEqual({charged:0,actual_restore:20});
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['plan','workspace','topics'] as const)(
 'RUNTIME: native non-C0 %s remains fully buffered through executeStream',async mode=>{
 const f=await fixture('serial-tools-v2',false,100,false,undefined,false,10000,false,true);
 const body=mode==='workspace'?'Full workspace answer':JSON.stringify([{title:mode+' structured answer'}]);
 const entered=latch(),release=latch();let posts=0,done=false;
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  posts++;const request=JSON.parse(String(init?.body));expect(request.stream).toBe(false);
  expect(request.stream_options).toBeUndefined();entered.release();await release.promise;
  return new Response(completion('gen-buffered-'+f.execution.executionId,request.model,body));
 }});
 const host=()=>runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:allowTestCalls});
 const events:ExecutionStreamEvent[]=[];
 const run=(async()=>{for await(const event of streamOriginalExecution(cb=>host().execute(f.execution.executionId,cb),
  undefined,'runtime.executeStream',undefined,'textDelta-v1'))events.push(event);done=true;})();
 try{
  await entered.promise;expect(done).toBe(false);
  expect(events.filter(event=>event.type==='text'||event.type==='textDelta')).toEqual([]);
  release.release();await run;
  expect(events.filter(event=>event.type==='text'||event.type==='textDelta')).toEqual([]);
  expect(events.at(-1)).toMatchObject({type:'result',result:{state:'completed',body,completeness:'complete'}});
  expect(posts).toBe(1);
 }finally{release.release();await run;}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each([
 ...['assistant','message','zero','normal','receipt'].map(stage=>({stage,whitespace:'',withCard:true})),
 ...['\n',' '].flatMap(whitespace=>[false,true].map(withCard=>({stage:'assistant',whitespace,withCard}))),
])('RUNTIME: C2 real stream stop $stage whitespace=$whitespace card=$withCard persists identical text once',async({stage,whitespace,withCard})=>{
 const f=await fixture('agent-turn-v5-stream',false,8192,false,undefined,false,30000,true,'append');
 const analysis='长分析😀'.repeat(1000)+whitespace,card={question:'问题？',options:['甲','乙'],recommended:0,message:'接下来的问题。',recommendationReason:'原因'};
 const toolGate=latch(),endGate=latch();let posts=0;
 const server=createServer(async(req,res)=>{
  posts++;let raw='';for await(const part of req)raw+=part;const request=JSON.parse(raw),id='gen-c2-'+f.execution.executionId;
  res.setHeader('content-type','text/event-stream');
  chunk(res,id,request.model,{role:'assistant',content:analysis});
  await toolGate.promise;
  if(withCard)chunk(res,id,request.model,{tool_calls:[{index:0,id:'card',type:'function',function:{name:'ask_question',arguments:JSON.stringify(card)}}]});
  await endGate.promise;
  chunk(res,id,request.model,{},withCard?'tool_calls':'stop');
  res.end('data: '+JSON.stringify({id,model:request.model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('local listener required');
 const adapter=openRouterAdapter({allowAgentTools:true,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 const completeGate=latch(),receiptGate=latch(),receiptReady=latch(),submissions:string[]=[];let receiptBlocked=false;
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  if(stage!=='normal'&&name==='runtime_execution'&&args.p_action==='complete'){
   submissions.push(JSON.stringify(args.p_result));if(submissions.length===2)completeGate.release();
   await completeGate.promise;
  }
  const response=await admin.rpc(name,args);
  if(stage==='receipt'&&name==='runtime_response'&&response.data?.rawBody&&!receiptBlocked){
   receiptBlocked=true;receiptReady.release();await receiptGate.promise;
  }
  return response;
 }};
 const host=()=>runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter});
 const updates:RuntimeProgress[]=[];
 const running=host().execute(f.execution.executionId,event=>updates.push(event));
 try{
  await until(()=>updates.some(e=>e.type==='text'&&e.text===analysis.trimEnd()));
  let stopAt=stage==='zero'?0:whitespace?5:Array.from(analysis).length;
  if(stage==='message'||stage==='normal'){
   toolGate.release();await until(()=>updates.some(e=>e.type==='text'&&e.text===analysis+'\n\n'+card.message));
   stopAt+=4;
  }
  if(stage==='receipt'){toolGate.release();endGate.release();await receiptReady.promise;}
  if(stage!=='normal')expect(await rpc('runtime_execution',{p_actor_id:f.actorId,p_execution_id:f.execution.executionId,
   p_action:'stop',p_result:{stopAt,source:'assistant'}}))
   .toMatchObject({state:stage==='receipt'?'stopped_pending_result':'stopping'});
  if(stage!=='normal'&&stage!=='receipt'){
   for(let attempt=0;attempt<4;attempt++)expect(await host().execute(f.execution.executionId)).toEqual({state:'stopping'});
   expect(submissions).toEqual([]);
  }
  toolGate.release();endGate.release();receiptGate.release();
  if(stage!=='normal')await until(()=>submissions.length===1);
  const recovering=stage==='normal'?running.then(()=>host().execute(f.execution.executionId)):host().execute(f.execution.executionId);
  const winner=await running;
  const recovered=await recovering;
  if(stage!=='normal')expect(submissions[0]).toBe(submissions[1]);
  expect(recovered).toEqual(winner);expect(posts).toBe(1);
  if(stage==='zero')expect(winner.state).toBe('cancelled');
  else{
   const full=analysis.trimEnd()+(withCard?'\n\n'+card.message:'');
   const expected=stage==='normal'?full:Array.from(full).slice(0,stopAt).join('').trimEnd();
   if(!('body' in winner))throw new Error('missing saved body');
   expect(JSON.parse(winner.body!)).toMatchObject({message:expected,card:stage==='normal'?card:null});
   if(stage!=='normal')expect(winner).toMatchObject({stopped:true,completeness:'stopped'});
   const saved=(await db.query('select result from runtime_executions where id=$1',[f.execution.executionId])).rows[0].result;
   expect(saved.body).toBe(winner.body);
   const next=await rpc('runtime_admit',{p_actor_id:f.actorId,p_session_id:f.session.sessionId,p_request_id:randomUUID(),
    p_payload:f.context,p_billing:f.billing});
   const history=await rpc('runtime_session_items',{p_actor_id:f.actorId,p_session_id:f.session.sessionId,
    p_execution_id:next.executionId,p_action:'read'});
   await rpc('runtime_cancel',{p_actor_id:f.actorId,p_execution_id:next.executionId});
   expect(JSON.stringify(history)).toContain(expected.slice(0,100));
  }
  const calls=(await db.query('select state from bill2_calls where run_id=$1',[f.execution.runId])).rows;
  expect(calls).toHaveLength(1);
  const before=(await db.query('select to_jsonb(b) body from bill2_runs b where id=$1',[f.execution.runId])).rows;
  await host().execute(f.execution.executionId);
  expect((await db.query('select to_jsonb(b) body from bill2_runs b where id=$1',[f.execution.runId])).rows).toEqual(before);
 }finally{receiptGate.release();completeGate.release();toolGate.release();endGate.release();await running.catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['primary','between','organizer','organizer-cut'] as const)(
 'RUNTIME: C2 attached organizer stop %s preserves only eligible paid output',async stage=>{
 const f=await fixture('serial-tools-v4-stream',true,8192,false,undefined,false,30000,false,true);
 const primaryGate=latch(),organizerGate=latch(),checkpointGate=latch(),checkpointReady=latch();
 const text='正文😀完成',summary='已完成的整理';let organizerStarted=false,posts=0;
 const server=createServer(async(req,res)=>{
  posts++;let raw='';for await(const part of req)raw+=part;const request=JSON.parse(raw),id='gen-c2-organizer-'+f.execution.executionId+'-'+posts;
  if(request.model==='synthetic/mentor'){
   res.setHeader('content-type','text/event-stream');chunk(res,id,request.model,{role:'assistant',content:'{"message":"正文'});
   await primaryGate.promise;chunk(res,id,request.model,{content:'😀完成"}'});endStream(res,id,request.model);
  }else{
   organizerStarted=true;await organizerGate.promise;
   res.setHeader('content-type','application/json');res.end(completion(id,request.model,summary));
  }
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('local listener required');
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>fetch(`http://127.0.0.1:${address.port}`,init)});
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  const result=await admin.rpc(name,args);
  if(stage==='between'&&name==='runtime_execution'&&args.p_action==='checkpoint_primary'){
   checkpointReady.release();await checkpointGate.promise;
  }
  return result;
 }};
 const updates:RuntimeProgress[]=[];
 const running=runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter})
  .execute(f.execution.executionId,event=>updates.push(event));
 try{
  await until(()=>updates.some(e=>e.type==='text'&&e.text==='正文'));
  if(stage!=='primary'){
   primaryGate.release();
   if(stage==='between')await checkpointReady.promise;else await until(()=>organizerStarted);
  }
  const stopAt=stage==='primary'||stage==='organizer-cut'?2:Array.from(text).length;
  expect(await rpc('runtime_execution',{p_actor_id:f.actorId,p_execution_id:f.execution.executionId,
   p_action:'stop',p_result:{stopAt,source:'message'}})).toMatchObject({state:stage==='between'?'stopped_pending_result':'stopping'});
  let replay;
  if(stage==='between')replay=await runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,
   callGate:async()=>{throw new Error('No new calls during stop');}}).execute(f.execution.executionId);
  checkpointGate.release();primaryGate.release();organizerGate.release();
  const result=await running;
  expect(result).toMatchObject({state:'completed',stopped:true,body:JSON.stringify({message:stopAt===2?'正文':text}),
   completeness:stopAt===2?'stopped':'complete',organized:stage==='organizer',summary:stage==='organizer'?summary:''});
  if(replay)expect(result).toEqual(replay);
  expect(posts).toBe(stage==='primary'||stage==='between'?1:2);
  expect((await db.query('select charged from bill2_runs where id=$1',[f.execution.runId])).rows[0].charged).toBe(posts*3);
  const again=await runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId);
  expect(again).toEqual(result);expect(posts).toBe(stage==='primary'||stage==='between'?1:2);
 }finally{checkpointGate.release();primaryGate.release();organizerGate.release();await running.catch(()=>{});
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it.each(['\n',' ','\u3000'].flatMap(space=>[true,false].flatMap(leading=>[true,false].map(stop=>({space,leading,stop})))))(
 'RUNTIME: step whitespace leading=$leading stop=$stop space=$space saves the streamed source',async({space,leading,stop})=>{
 const f=await fixture('serial-tools-v4-stream',false,100,false,undefined,false,10000,false,true);
 const content=leading?space+'Hello world':'Hello world'+space,tail=latch();
 const id='gen-step-space-'+f.execution.executionId;
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  expect(init?.method).toBe('POST');const request=JSON.parse(String(init?.body));
  const frame=(delta:object,finish_reason:string|null=null)=>'data: '+JSON.stringify({id,model:request.model,
   choices:[{index:0,delta,finish_reason}]})+'\n\n';
  return new Response(new ReadableStream({async start(controller){
   const send=(text:string)=>controller.enqueue(new TextEncoder().encode(text));
   send(frame({role:'assistant',content:JSON.stringify({message:content})}));
   await tail.promise;send(frame({},'stop'));
   send('data: '+JSON.stringify({id,model:request.model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\ndata: [DONE]\n\n');
   controller.close();
  }}),{headers:{'content-type':'text/event-stream'}});
 }});
 const updates:RuntimeProgress[]=[];
 const run=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:allowTestCalls})
  .execute(f.execution.executionId,event=>updates.push(event));
 try{
  await until(()=>updates.some(e=>e.type==='text'&&e.text==='Hello world'));
  if(stop)await rpc('runtime_execution',{p_actor_id:f.actorId,p_execution_id:f.execution.executionId,
   p_action:'stop',p_result:{stopAt:5,source:'message'}});
  tail.release();const result=await run;
  expect(result).toMatchObject({state:'completed',body:JSON.stringify({message:stop?'Hello':'Hello world'})});
  if(stop)expect(result).toMatchObject({stopped:true,completeness:'stopped'});
  else expect(updates.filter(e=>e.type==='text').some(e=>'source' in e&&e.source==='final')).toBe(false);
 }finally{tail.release();await run.catch(()=>{});}
});

it.each(['disconnect','5xx','rejected'] as const)('RUNTIME: original stopped HTTP finishes immediately after %s',async kind=>{
 const f=await fixture('serial-tools-v4-stream',false,100,false,undefined,false,10000,false,true);
 const sent=latch(),tail=latch();let lookups=0;const id='gen-stop-error-'+f.execution.executionId;
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  if(init?.method==='GET'){lookups++;return new Response(JSON.stringify({data:{id,model:'synthetic/mentor',total_cost:0.003,finish_reason:'stop'}}));}
  if(kind!=='disconnect'){
   sent.release();await tail.promise;
   return new Response(JSON.stringify({error:{code:402,message:'Synthetic refusal',metadata:{limit_source:'openrouter_key_limit',provider_name:null}}}),
    {status:kind==='5xx'?503:402,headers:{'content-type':'application/json'}});
  }
  return new Response(new ReadableStream({async start(controller){
   controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id,model:'synthetic/mentor',
    choices:[{index:0,delta:{content:'{"message":"partial'},finish_reason:null}]})+'\n\n'));
   sent.release();await tail.promise;controller.error(new Error('Synthetic disconnect'));
  }}),{headers:{'content-type':'text/event-stream'}});
 }});
 const run=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter,callGate:allowTestCalls}).execute(f.execution.executionId);
 try{
  await sent.promise;
  await rpc('runtime_execution',{p_actor_id:f.actorId,p_execution_id:f.execution.executionId,p_action:'stop',p_result:{stopAt:3,source:'message'}});
  tail.release();const result=await run;
  expect(['cancelled','cost_pending']).toContain(result.state);
  if(kind==='disconnect')expect(lookups).toBe(1);
 }finally{tail.release();await run.catch(()=>{});}
});
