/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB-4b: the real executor, SDK, BILL2 and 0262 SQL read referenced library documents; a deletion while the turn
// streams stops everything shown after it (LIB_DOCS_PLAN 6, 6.1, 7; #981 acceptance). Local synthetic provider only.
import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {allowTestCalls} from '../__tests__/fixtures/runtimeGates';
import {runtimeExecutor} from './execute';
import {streamOriginalExecution,type ExecutionStreamEvent} from './executionStream';
import {executionVisibility} from './libraryVisibility';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import {createRuntimeBudget} from './budget';

const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable'))throw new Error('isolated runner required');
if(!process.env.V3_LOCAL_REST?.startsWith('http://127.0.0.1:'))throw new Error('isolated REST required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
beforeAll(async()=>{await db.connect();});
afterAll(async()=>{await db.end();});
const staging=process.env.V3_LOCAL_STAGING_SCHEMA==='true';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function rpc(name:string,args:Record<string,unknown>){const r=await admin.rpc(name,args);if(r.error)throw new Error(r.error.message);return r.data;}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function until(test:()=>boolean){const deadline=Date.now()+5000;while(!test()){if(Date.now()>deadline)throw new Error('synthetic deadline');await new Promise(r=>setTimeout(r,10));}}
const SEGMENT='LIB4B_SEGMENT_CANARY';

/** One account with a ready two-segment Markdown document and an admitted free-chat turn that references it. */
async function fixture(options:{version?:number}={}){
 const actorId=randomUUID(),modelId=randomUUID(),windowId=randomUUID(),requestId=randomUUID(),model='synthetic/library';
 await db.query('insert into profiles(id,credits) values($1,100)',[actorId]);
 await db.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after)
  values($1,100,'addition','grant','opening_grant','system',$2,0,100)`,[actorId,'lib4b-opening:'+actorId]);
 const documentId=(await db.query(`insert into library_documents(actor_id,request_id,kind,format,purpose,filename,status,content_version)
  values($1,gen_random_uuid(),'document','md','reference','LIB4B_PRIVATE_NAME.md','ready',1) returning id`,[actorId])).rows[0].id;
 await db.query(`insert into library_document_segments(document_id,actor_id,ordinal,title,body,source)
  select $1,$2,g,'Chapter '||(g+1),$3||' '||(g+1),'extracted' from generate_series(0,1) g`,[documentId,actorId,SEGMENT]);
 const session=await rpc('runtime_start',{p_actor_id:actorId,p_request_id:randomUUID(),p_payload:{scope:{kind:'positioning_draft'}}});
 const policy={modelId,model,provider:'openrouter',account:'synthetic-library',protocol:'openrouter-chat-v1',upperUsd:'0.02',inputLimit:60000,
  outputLimit:200,automaticRetry:false,hiddenTools:false,lookupSupported:true,providerLimits:{providerSlug:'synthetic',contextTokens:40000,
   promptUsdPerMillion:'0.5',completionUsdPerMillion:'0',requestUsd:'0'}};
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic library integration',$2,'openrouter','true')",[modelId,model]);
 await db.query(`insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at)
  values($1,true,$2,$3,1000,1,0.10,3,now()+interval '2 hours')`,[windowId,[actorId],JSON.stringify([policy])]);
 const libraryReferences=[{documentId,version:options.version??1}];
 // The frozen shape admission.ts produces for free chat with one reference (plain-text native stream, v6, read slots 2).
 const context={version:'runtime.v1',sdkVersion:'0.18.0',inputSelection:'scope-projection-v1',nativeOutput:'native-output-v1',
  providerRequestFormat:'serial-tools-v6-reasoning',reasoning:{parameter:'none'},role:'ordinary',input:'Summarize my attached notes',
  instructions:'Answer the user request directly.',model,modelId,maxOutputTokens:200,maxTurns:3,historyItems:0,network:'deny',
  libraryReferences,tools:['read_source'],maxToolCalls:2,request:{sessionId:session.sessionId,requestId,input:'Summarize my attached notes',
   references:[{kind:'library_document',...libraryReferences[0]}]},sources:[],textStream:'plain-text-v1'};
 const billing={contractVersion:'bill2.v1',mode:'staging_test',testWindowId:windowId,scope:session.scope,operation:'question',modelId,
  sourceHash:hash(JSON.stringify(context)),input:context,callPolicy:[policy],
  rules:{version:'runtime-staging-v1',quoteVersion:windowId,creditsPerUsd:'1000',multiplier:'1',fx:{}},
  limits:{costUsd:'0.06',credits:60,maxPreDeduct:60,maxCalls:3,deadline:new Date(Date.now()+3600000).toISOString()}};
 const admit=()=>admin.rpc('runtime_admit',{p_actor_id:actorId,p_session_id:session.sessionId,p_request_id:requestId,p_payload:context,p_billing:billing});
 return {actorId,documentId,session,model,admit};
}
function chunk(response:ServerResponse,id:string,model:string,delta:unknown,finish:string|null=null){
 response.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
}
function endStream(response:ServerResponse,id:string,model:string){
 chunk(response,id,model,{},'stop');
 response.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created:1,model,choices:[],
  usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\n');
 response.end('data: [DONE]\n\n');
}
/** Synthetic provider: the first call reads doc-1/segment-1; later calls stream an answer, held at `gate` after `early`. */
async function provider(options:{early:string;late:string;gate?:Promise<void>;disconnect?:boolean}){
 const bodies:string[]=[];let streamed=false;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;bodies.push(raw);
  const request=JSON.parse(raw),id='gen-lib4b-'+randomUUID();
  res.setHeader('x-generation-id',id);res.setHeader('content-type','text/event-stream');
  if(bodies.length===1){
   chunk(res,id,request.model,{role:'assistant',tool_calls:[{index:0,id:'lib-read-1',type:'function',
    function:{name:'read_source',arguments:JSON.stringify({query:'doc-1/segment-1'})}}]},'tool_calls');
   res.write('data: '+JSON.stringify({id,model:request.model,choices:[],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\n');
   res.end('data: [DONE]\n\n');return;
  }
  chunk(res,id,request.model,{role:'assistant',content:options.early});streamed=true;
  await options.gate;
  if(options.disconnect){res.destroy(new Error('Synthetic provider disconnect'));return;}
  chunk(res,id,request.model,{content:options.late});endStream(res,id,request.model);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('isolated listener required');
 const adapter=openRouterAdapter({allowWorkspaceRead:true,credential:async()=>'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>fetch('http://127.0.0.1:'+address.port,init)});
 return {adapter,bodies,streamed:()=>streamed,
  close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
/** The streaming route's composition (routers/runtime.ts executeStream): one fence shared by the executor and every yield. */
function stream(f:{actorId:string},executionId:string,adapter:ReturnType<typeof openRouterAdapter>){
 const visibility=executionVisibility(admin,f.actorId,executionId),events:ExecutionStreamEvent[]=[];
 const executor=runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter,onContext:visibility.observe});
 let outcome:unknown;
 const generator=streamOriginalExecution(async onProgress=>{const r=await executor.execute(executionId,onProgress);outcome=r;return r;},
  undefined,'runtime.executeStream',undefined,'textDelta-v1',visibility.visible);
 const done=(async()=>{for await(const event of generator)events.push(event);})();
 done.catch(()=>{});
 return {events,done,outcome:()=>outcome,executor};
}
const shown=(events:ExecutionStreamEvent[])=>JSON.stringify(events);
async function stored(executionId:string){
 return JSON.stringify((await db.query(`select
  (select jsonb_agg(item) from runtime_session_history where execution_id=$1) history,
  (select jsonb_agg(items) from runtime_session_batches where execution_id=$1) batches,
  (select jsonb_agg(result) from runtime_tool_calls where execution_id=$1) tools,
  (select jsonb_build_object('result',result,'primary',primary_result) from runtime_executions where id=$1) execution`,[executionId])).rows[0]);
}

it.runIf(staging)('RUNTIME: library reference admission refuses a stale version before any reservation or charge',async()=>{
 const f=await fixture({version:2});
 const refused=await f.admit();
 expect(refused.error).toMatchObject({code:'P0001',message:'LIB_REFERENCE_STALE'});
 expect((await db.query('select count(*)::int n from runtime_executions where actor_id=$1',[f.actorId])).rows[0].n).toBe(0);
 expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(100);
});

it.runIf(staging)('RUNTIME: library read reaches the model, completes and replays without another POST or read',async()=>{
 const f=await fixture(),p=await provider({early:'From your notes: ',late:'chapter one.'});
 try{
  const admitted=await f.admit();expect(admitted.error).toBeNull();const executionId=admitted.data.executionId;
  const s=stream(f,executionId,p.adapter);await s.done;
  expect(s.outcome()).toMatchObject({state:'completed'});
  expect(p.bodies).toHaveLength(2);
  // The model received the segment as a tool result, and the library instructions with the request.
  const second=JSON.parse(p.bodies[1]!);
  expect(JSON.stringify(second.messages.filter((m:{role:string})=>m.role==='tool'))).toContain(SEGMENT+' 1');
  expect(JSON.stringify(second.messages)).toContain('doc-N/segment-S');
  expect(shown(s.events)).toContain('chapter one.');
  const replay=stream(f,executionId,p.adapter);await replay.done;
  expect(replay.outcome()).toEqual(s.outcome());expect(p.bodies).toHaveLength(2);
  expect((await db.query("select count(*)::int n from runtime_tool_calls where execution_id=$1 and result->>'kind'='library_segment'",
   [executionId])).rows[0].n).toBe(1);
 }finally{await p.close();}
});

it.runIf(staging)('RUNTIME: library document deleted mid-stream hides late text, deltas and result and keeps no copy',async()=>{
 const gate=latch(),f=await fixture(),p=await provider({early:'EARLY_VISIBLE ',late:'LATE_PRIVATE_TEXT',gate:gate.promise});
 try{
  const admitted=await f.admit();expect(admitted.error).toBeNull();const executionId=admitted.data.executionId;
  const s=stream(f,executionId,p.adapter);
  await until(()=>shown(s.events).includes('EARLY_VISIBLE'));
  // The user deletes the document while the answer streams (service-role library entry point, as library.delete).
  await rpc('library_delete',{a:f.actorId,did:f.documentId});
  gate.release();
  await expect(s.done).rejects.toMatchObject({message:expect.stringMatching(/^LIB_SOURCE_DELETED：/)});
  await until(()=>s.outcome()!==undefined);
  expect(shown(s.events)).not.toMatch(/LATE_PRIVATE|"result"/);
  // SQL refused to save the late answer: the turn ended cancelled and marked, and the view shows no body.
  expect(s.outcome()).toMatchObject({state:'cancelled'});
  const execution=(await db.query('select state,unavailable_reason,result from runtime_executions where id=$1',[executionId])).rows[0];
  expect(execution).toMatchObject({state:'cancelled',unavailable_reason:'source_deleted',result:null});
  const view=await rpc('runtime_view',{p_actor_id:f.actorId,p_session_id:f.session.sessionId});
  expect(JSON.stringify(view)).not.toMatch(/LATE_PRIVATE|LIB4B_SEGMENT|LIB4B_PRIVATE_NAME/);
  expect(view.executions[0]).toMatchObject({unavailableReason:'source_deleted',body:null});
  // Cleanup removes the copies the turn did store: the frozen segment and non-user history.
  for(let i=0;i<5;i++)await rpc('runtime_library_propagate',{p_actor_id:f.actorId,p_limit:20});
  expect(await stored(executionId)).not.toMatch(/LATE_PRIVATE|LIB4B_SEGMENT|LIB4B_PRIVATE_NAME/);
  expect((await db.query('select propagated_at is not null done from runtime_library_references where execution_id=$1',
   [executionId])).rows).toEqual([{done:true}]);
  // A later stream of the same turn shows nothing and sends nothing.
  const posts=p.bodies.length,again=stream(f,executionId,p.adapter);await again.done.catch(()=>{});
  expect(p.bodies).toHaveLength(posts);expect(shown(again.events)).not.toMatch(/LATE_PRIVATE|LIB4B_SEGMENT/);
 }finally{gate.release();await p.close();}
});

it.runIf(staging)('RUNTIME: library document changing version mid-stream is not a deletion: shown while streaming and after refresh',async()=>{
 const gate=latch(),f=await fixture(),p=await provider({early:'EARLY_SHOWN ',late:'LATE_SHOWN',gate:gate.promise});
 try{
  const admitted=await f.admit();expect(admitted.error).toBeNull();const executionId=admitted.data.executionId;
  const s=stream(f,executionId,p.adapter);
  await until(()=>shown(s.events).includes('EARLY_SHOWN'));
  // A recognized page raises the content version; the document is not deleted (#1022 decision C).
  await db.query('update library_documents set content_version=2 where id=$1',[f.documentId]);
  gate.release();await s.done;
  expect(s.outcome()).toMatchObject({state:'completed'});
  expect(shown(s.events)).toContain('LATE_SHOWN');
  const view=await rpc('runtime_view',{p_actor_id:f.actorId,p_session_id:f.session.sessionId});
  expect(view.executions[0].body).toContain('LATE_SHOWN');
  expect(await rpc('runtime_library_sources_gone',{p_actor_id:f.actorId,p_execution_ids:[executionId]})).toEqual([]);
 }finally{gate.release();await p.close();}
});

it.runIf(staging)('RUNTIME: library document deleted after admission and before any read cancels the turn without a provider call',async()=>{
 const f=await fixture(),p=await provider({early:'x',late:'y'});
 try{
  const admitted=await f.admit();expect(admitted.error).toBeNull();const executionId=admitted.data.executionId;
  // 0277: read-only, an execution is listed only while one of its frozen references is gone.
  const gone=(ids:string[])=>rpc('runtime_library_sources_gone',{p_actor_id:f.actorId,p_execution_ids:ids});
  expect(await gone([executionId,randomUUID()])).toEqual([]);
  await rpc('library_delete',{a:f.actorId,did:f.documentId});
  expect(await gone([executionId,randomUUID()])).toEqual([executionId]);
  // Deletion finds the frozen reference although no tool call exists yet (LIB_DOCS_PLAN 6.1).
  const s=stream(f,executionId,p.adapter);await s.done.catch(()=>{});
  expect(p.bodies).toHaveLength(0);
  expect(s.outcome()).toMatchObject({state:'cancelled'});
  expect((await db.query('select unavailable_reason from runtime_executions where id=$1',[executionId])).rows[0].unavailable_reason)
   .toBe('source_deleted');
  for(let i=0;i<5;i++)await rpc('runtime_library_propagate',{p_actor_id:f.actorId,p_limit:20});
  expect((await db.query('select propagated_at is not null done from runtime_library_references where execution_id=$1',
   [executionId])).rows).toEqual([{done:true}]);
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(100);
 }finally{await p.close();}
});

it.runIf(staging)('RUNTIME: library read replayed in recovery is rechecked and a changed document is refused',async()=>{
 const f=await fixture(),p=await provider({early:'Recovered ',late:'answer.'});
 try{
  const admitted=await f.admit();expect(admitted.error).toBeNull();const executionId=admitted.data.executionId;
  // The process stops after the read is stored and before the second model call (no dispatch, nothing charged for it).
  const base=createRuntimeBudget(),budget={...base,modelCallTimeout:(maximum:number)=>{
   if(p.bodies.length>=1)throw new Error('RUNTIME_TIME_BUDGET_EXHAUSTED');return base.modelCallTimeout(maximum);}};
  await runtimeExecutor({callGate:allowTestCalls,database:admin,actor:async()=>f.actorId,adapter:p.adapter,budget})
   .execute(executionId).catch(()=>null);
  expect(p.bodies).toHaveLength(1);
  expect((await db.query("select count(*)::int n from runtime_tool_calls where execution_id=$1 and result->>'kind'='library_segment'",
   [executionId])).rows[0].n).toBe(1);
  // The document changes version (e.g. a recognized page); the frozen segment is no longer at the referenced version.
  await db.query('update library_documents set content_version=2 where id=$1',[f.documentId]);
  // A version change is not a deletion (#1022 decision C); the replayed read below is still rechecked.
  expect(await rpc('runtime_library_sources_gone',{p_actor_id:f.actorId,p_execution_ids:[executionId]})).toEqual([]);
  // Recovery replays the SDK from the stored round: the saved read is rechecked before it reaches the model again.
  const checks:unknown[]=[];
  const database={rpc:async(name:string,args:Record<string,unknown>)=>{
   const r=await admin.rpc(name,args);if(name==='runtime_library_visible')checks.push(r.data);return r;}};
  const result=await runtimeExecutor({callGate:allowTestCalls,database,actor:async()=>f.actorId,adapter:p.adapter}).execute(executionId);
  // The second call was never dispatched, so recovery cannot send it; nothing new reaches the provider.
  expect(result).toMatchObject({state:'pending'});expect(p.bodies).toHaveLength(1);
  expect(checks).toEqual([false]);
 }finally{await p.close();}
});
