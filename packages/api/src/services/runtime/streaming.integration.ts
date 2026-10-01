/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {logger} from '../../lib/logger';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {runtimeExecutor} from './execute';
import type {RuntimeProgress} from './progress';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import type {ReasoningPolicy} from './reasoningPolicy';
import {decodeOpenRouterStreamObservation} from '../bill2/openRouterEvidence';

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
async function fixture(format:'serial-tools-v2'|'serial-tools-v3-stream'|'serial-tools-v4-stream'|'agent-turn-v5-stream'|'serial-tools-v6-reasoning',organize=false,outputLimit=100,tool=false,reasoning?:{primary:ReasoningPolicy;organizer:ReasoningPolicy}){
 const actorId=randomUUID(),mentorId=randomUUID(),organizerId=randomUUID(),windowId=randomUUID(),requestId=randomUUID();
 await db.query('insert into profiles(id,credits) values($1,100)',[actorId]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actorId,'stream-opening:'+actorId]);
 const session=await rpc('runtime_start',{p_actor_id:actorId,p_request_id:randomUUID(),p_payload:{scope:{kind:'positioning_draft'}}});
 const policies=[[mentorId,'synthetic/mentor'],[organizerId,'synthetic/organizer']].map(([modelId,model])=>({modelId,model,provider:'openrouter',account:'synthetic-stream',protocol:'openrouter-chat-v1',upperUsd:'0.02',inputLimit:10000,outputLimit,automaticRetry:false,hiddenTools:false,lookupSupported:true,providerLimits:{providerSlug:'synthetic',contextTokens:10000,promptUsdPerMillion:'2',completionUsdPerMillion:'0',requestUsd:'0'}}));
 for(const policy of policies)await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic streaming integration',$2,'openrouter','true')",[policy.modelId,policy.model]);
 await db.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,0.10,3,now()+interval '2 hours')",[windowId,[actorId],JSON.stringify(policies)]);
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',inputSelection:'scope-projection-v1',providerRequestFormat:format,...(reasoning?{reasoning:reasoning.primary}:format==='serial-tools-v4-stream'||format==='agent-turn-v5-stream'?{reasoning:{effort:'none'}}:{}),input:'Synthetic original input',instructions:'Return the public mentor message in the message property; keep protocol fields private.',model:policies[0]!.model,modelId:mentorId,maxOutputTokens:outputLimit,maxTurns:1,historyItems:20,network:'deny',tools:format==='agent-turn-v5-stream'?['ask_question']:tool?['read_source']:[],...(tool?{workspaceContext:true,maxToolCalls:1,maxTurns:2}:{}),request:{sessionId:session.sessionId,requestId},...(organize?{attachedOrganizer:{modelId:organizerId,model:policies[1]!.model,maxOutputTokens:reasoning?outputLimit:100,...(reasoning?{reasoning:reasoning.organizer}:{}),instructions:'Synthetic organizer only',input:'Synthetic original input'}}:{})};
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

it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['serial-tools-v3-stream','serial-tools-v4-stream'] as const)('RUNTIME: streaming %s real SDK/executor/BILL2 delivers public text before model and organizer completion, preserving one dispatch and immutable request',async(format)=>{
 const f=await fixture(format,true),mentorGate=latch(),organizerGate=latch(),bodies:string[]=[],events:Array<{event:RuntimeProgress;at:number}>=[];
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
 const start=Date.now(),host=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter});
 const running=host.execute(f.execution.executionId,event=>{events.push({event,at:Date.now()-start});}).then(result=>{finished=true;return result;});
 try{
  await until(()=>events.some(({event})=>event.type==='text'));
  expect(mentorFinished).toBe(false);expect(finished).toBe(false);expect(bodies).toHaveLength(1);
  expect(events.filter(({event})=>event.type==='text').map(({event})=>event.type==='text'?event.text:'')).toContain('已经知道你的产品名称。');
  const firstTextMs=events.find(({event})=>event.type==='text')!.at;
  mentorGate.release();await until(()=>organizerStarted);
  expect(organizerFinished).toBe(false);expect(finished).toBe(false);
  expect(events.filter(({event})=>event.type==='text').at(-1)?.event).toEqual({type:'text',text:publicMessage});
  expect(events.map(({event})=>event)).toContainEqual({type:'phase',phase:'organizer'});
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|patches|reasoning|encrypted|"message"/);
  organizerGate.release();expect(await running).toEqual({state:'completed',body,summary:organizer});
  expect(await host.execute(f.execution.executionId)).toEqual({state:'completed',body,summary:organizer});
  expect(bodies).toHaveLength(2);expect(JSON.parse(bodies[0]!).stream).toBe(true);expect(JSON.parse(bodies[0]!).stream_options).toEqual({include_usage:true});
  expect(JSON.parse(bodies[1]!).stream).toBe(false);
  // Only the primary mentor call carries the frozen reasoning policy; the organizer keeps its bytes.
  expect(JSON.parse(bodies[0]!).reasoning_effort).toBe(format==='serial-tools-v4-stream'?'none':undefined);expect(bodies[1]).not.toMatch(/reasoning/);
  const calls=(await db.query('select id,payload,provider_id,state from bill2_calls where run_id=$1 order by sequence',[f.execution.runId])).rows;
  expect(calls).toHaveLength(2);expect(calls.map(call=>call.payload.requestHash)).toEqual(bodies.map(hash));
  expect(calls.map(call=>call.provider_id)).toEqual([1,2].map(n=>'gen-stream-'+f.execution.executionId+'-'+n));
  expect((await db.query('select count(*)::int n from bill2_receipts where call_id=any($1::uuid[])',[calls.map(call=>call.id)])).rows[0].n).toBe(2);
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
 const running=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId,event=>{events.push(event);});
 try{
  await until(()=>events.some(event=>event.type==='text'));gate.release();
  expect(await running).toMatchObject({state:'pending'});expect(posts).toBe(1);
  const calls=(await db.query('select id,state,provider_id from bill2_calls where run_id=$1',[f.execution.runId])).rows;
  expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({state:'dispatched',provider_id:id});
  expect((await db.query('select state,charged,actual_restore from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toMatchObject({state:'cost_pending',charged:null,actual_restore:null});
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(80);
  const receipts=(await db.query('select payload from bill2_receipts where call_id=$1',[calls[0].id])).rows;
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
  const host=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter}),result=await host.execute(f.execution.executionId,event=>{events.push(event);});
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
  expect(await runtimeExecutor(options).execute(f.execution.executionId)).toEqual({state:'pending'});
  expect(completionFailed).toBe(true);expect(bodies).toHaveLength(1);expect(JSON.parse(bodies[0]!).stream).toBe(true);
  const call=(await db.query('select id,payload,provider_id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[f.execution.runId])).rows[0];
  expect(call.provider_id).toBe(id);expect(call.cost).toBe('0.003');expect(call.payload.requestHash).toBe(hash(bodies[0]!));
  const receiptBefore=(await db.query('select id,payload,payload_hash from bill2_receipts where call_id=$1',[call.id])).rows;
  expect(receiptBefore).toHaveLength(1);
  const historyBefore=(await db.query('select revision,execution_id,item from runtime_session_history where session_id=$1 order by revision',[f.session.sessionId])).rows;
  expect(historyBefore.length).toBeGreaterThan(0);expect(historyBefore.filter(row=>row.item.role==='assistant')).toHaveLength(1);
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(80);
  // Recreate the host: the SSE replay cannot rely on a process-local buffer.
  const recovered=await runtimeExecutor(options).execute(f.execution.executionId,event=>{events.push(event);});
  expect(recovered).toEqual({state:'completed',body});
  expect(events.filter(event=>event.type==='text').at(-1)).toEqual({type:'text',text:publicMessage});
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|patches|reasoning|encrypted/);
  expect(await runtimeExecutor(options).execute(f.execution.executionId)).toEqual(recovered);expect(bodies).toHaveLength(1);
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
  const host=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter}),result=await host.execute(f.execution.executionId);
  expect(result).toEqual({state:'completed',body});expect(await host.execute(f.execution.executionId)).toEqual(result);expect(bodies).toHaveLength(1);expect(JSON.parse(bodies[0]!).max_tokens).toBe(4096);
  const call=(await db.query('select id,payload,provider_id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[f.execution.runId])).rows[0];
  expect(call.provider_id).toBe(id);expect(call.cost).toBe('0.003');expect(call.payload.requestHash).toBe(hash(bodies[0]!));
  const receipts=(await db.query('select payload,octet_length(payload::text) bytes from bill2_receipts where call_id=$1',[call.id])).rows;
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
   sourceReads++;const rows=(await db.query('select count(*)::int n from bill2_receipts r join bill2_calls c on c.id=r.call_id where c.run_id=$1',[f.execution.runId])).rows;
   expect(rows[0].n).toBe(1);
  }
  return admin.rpc(name,args);
 }};
 const host=runtimeExecutor({database,actor:async()=>f.actorId,adapter}),running=host.execute(f.execution.executionId);
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

// AC-1 tool plumbing: the Agent turn format is dormant (no admission produces
// it), so this frozen context is admitted directly, as the fixture does above.
it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true').each(['tool_calls','length'] as const)('RUNTIME: streaming Agent turn keeps the first of two question cards, bills one call and replays without POST (finish %s)',async(finish)=>{
 const f=await fixture('agent-turn-v5-stream'),bodies:string[]=[],events:RuntimeProgress[]=[],id='gen-agent-'+f.execution.executionId,model='synthetic/mentor';
 const card={question:'你现在主要在哪个平台发内容？',options:['小红书','抖音']};
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
  const host=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter}),result=await host.execute(f.execution.executionId,event=>{events.push(event);});
  const request=JSON.parse(bodies[0]!);
  expect(bodies).toHaveLength(1);expect(request).not.toHaveProperty('parallel_tool_calls');expect(request).not.toHaveProperty('tool_choice');
  expect(request).toMatchObject({stream:true,reasoning_effort:'none'});expect(request.tools.map((t:{function:{name:string}})=>t.function.name)).toEqual(['ask_question']);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|SECOND_CARD/);
  expect(events.filter(event=>event.type==='text').at(-1)).toEqual({type:'text',text:'先了解一下你的情况。'});
  const call=(await db.query('select id,payload,provider_id from bill2_calls where run_id=$1',[f.execution.runId])).rows;
  expect(call).toHaveLength(1);expect(call[0].payload.requestHash).toBe(hash(bodies[0]!));
  // The provider response stays whole as evidence, including the dropped call.
  const receipt=(await db.query('select payload from bill2_receipts where call_id=$1',[call[0].id])).rows[0].payload;
  expect(decodeOpenRouterStreamObservation(receipt.transport).toString()).toContain('call_second');
  if(finish==='tool_calls'){
   expect(result).toEqual({state:'completed',body:JSON.stringify({card:'question',...card})});
   expect(warned.mock.calls.filter(c=>c[1]==='runtime_tool_calls_dropped')).toEqual([['api','runtime_tool_calls_dropped',{executionId:f.execution.executionId,dropped:1}]]);
   const history=JSON.stringify((await db.query('select item from runtime_session_history where session_id=$1 order by revision',[f.session.sessionId])).rows);
   expect(history).toContain('call_first');expect(history).not.toContain('call_second');
   expect((await db.query('select state,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',charged:3});
  }else{
   // A tool call cut off by the output limit is never executed or shown.
   expect(result).toMatchObject({unavailable:'output_truncated'});
   expect(JSON.stringify((await db.query('select item from runtime_session_history where session_id=$1',[f.session.sessionId])).rows)).not.toContain('call_first');
  }
  // Replay after the outcome: the stored result, no further provider POST.
  expect(await runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter}).execute(f.execution.executionId)).toMatchObject({state:result.state});
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
 const host=runtimeExecutor({database,actor:async()=>f.actorId,adapter});
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
 expect((await db.query('select count(*)::int n from bill2_receipts where call_id=any($1::uuid[])',[calls.map(c=>c.id)])).rows[0].n).toBe(2);
 expect((await db.query('select state,charged,provider_cost_usd::text cost from bill2_runs where id=$1',[f.execution.runId])).rows[0]).toEqual({state:'settled',charged:6,cost:'0.006'});
 expect((await db.query("select count(*)::int n from credit_transactions where bill2_run_id=$1 and reason_code='bill2_spend'",[f.execution.runId])).rows[0].n).toBe(1);
});


it.runIf(process.env.V3_LOCAL_STAGING_SCHEMA==='true')('RUNTIME: 8192 one-token frames finish as clean output_truncated',async()=>{
 const outputLimit=8192;
 const f=await fixture('serial-tools-v4-stream',true,outputLimit);
 let sends=0;
 const adapter=openRouterAdapter({credential:async()=> 'SYNTHETIC_LOCAL_ONLY',transport:async(_url,init)=>{
  sends++;
  const request=JSON.parse(String(init!.body));
  expect(request.max_tokens).toBe(outputLimit);
  const envelope={id:'gen-token-frames',model:request.model,object:'chat.completion.chunk'};
  const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({...envelope,
   choices:[{index:0,delta,finish_reason}]})+'\n\n';
  const wire=frame({role:'assistant'})+frame({reasoning:'x'}).repeat(outputLimit)+frame({},'length')+
   'data: '+JSON.stringify({...envelope,choices:[],usage:{prompt_tokens:10,completion_tokens:outputLimit,
    total_tokens:outputLimit+10,cost:0.003}})+'\n\ndata: [DONE]\n\n';
  expect(Buffer.byteLength(wire)).toBeLessThan(4_194_304);
  return new Response(wire,{headers:{'content-type':'text/event-stream'}});
 }});
 const host=runtimeExecutor({database:admin,actor:async()=>f.actorId,adapter});
 const result=await host.execute(f.execution.executionId);
 expect(result).toEqual({state:'cancelled',unavailable:'output_truncated'});
 const calls=(await db.query('select id from bill2_calls where run_id=$1',[f.execution.runId])).rows;
 expect(calls).toHaveLength(1);
 const receipt=(await db.query('select payload from bill2_receipts where call_id=$1',[calls[0].id])).rows[0].payload;
 expect(receipt).toMatchObject({final:true,cost:'0.003',transport:{complete:true,transportIssue:null}});
 expect(receipt.usage.sdkResponse.choices[0]).toMatchObject({finish_reason:'length',
  message:{content:null,reasoning:'x'.repeat(outputLimit)}});
 expect((await db.query('select state,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0])
  .toEqual({state:'settled',charged:3});
 expect(await host.execute(f.execution.executionId)).toMatchObject({state:'cancelled'});
 expect(sends).toBe(1);
});
