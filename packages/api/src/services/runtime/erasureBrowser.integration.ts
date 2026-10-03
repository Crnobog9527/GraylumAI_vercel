/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {createRequire} from 'node:module';
import {allowTestCalls} from '../__tests__/fixtures/runtimeGates';
import {runtimeExecutor} from './execute';
import {runtimeActor} from './actor';
import {createRuntimeBudget} from './budget';
import {inflightFinancialHost} from './inflightFinancial';
import {streamOriginalExecution} from './executionStream';
import {QUESTION_CONTRACT} from './agentTools';
import {openRouterAdapter} from '../bill2/openRouterAdapter';
import type {RuntimeProgress} from './progress';

// The browser dependency belongs to web; resolve its runtime there without adding an API dependency.
type LocalPage={goto:(url:string)=>Promise<unknown>;waitForFunction:(fn:()=>boolean)=>Promise<unknown>;
 locator:(selector:string)=>{textContent:()=>Promise<string|null>;innerText:()=>Promise<string>};
 evaluate:<T>(fn:()=>T)=>Promise<T>;screenshot:(options:{path:string})=>Promise<unknown>};
type LocalRoute={request:()=>{url:()=>string};continue:()=>Promise<void>;abort:()=>Promise<void>};
type LocalContext={route:(pattern:string,handler:(route:LocalRoute)=>Promise<void>)=>Promise<void>;
 newPage:()=>Promise<LocalPage>;close:()=>Promise<void>};
const {chromium}=createRequire(new URL('../../../../../apps/web/package.json',import.meta.url))('@playwright/test') as {
 chromium:{launch:(options:{headless:boolean;executablePath?:string})=>Promise<{newContext:()=>Promise<LocalContext>;close:()=>Promise<void>}>};
};

// Additional explicit local-browser proof. Existing CI suites and exclusions are unchanged.
const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable'))
 throw new Error('isolated runner required');
if(!process.env.V3_LOCAL_REST?.startsWith('http://127.0.0.1:'))throw new Error('isolated REST required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
beforeAll(async()=>{await db.connect();});
afterAll(async()=>{await db.end();});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function rpc(name:string,args:Record<string,unknown>){
 const result=await admin.rpc(name,args);if(result.error)throw new Error(result.error.message);return result.data;
}
function latch(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
async function fixture(){
 const actorId=randomUUID(),modelId=randomUUID(),windowId=randomUUID(),requestId=randomUUID();
 await db.query('insert into profiles(id,credits) values($1,100)',[actorId]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actorId,'browser-opening:'+actorId]);
 const session=await rpc('runtime_start',{p_actor_id:actorId,p_request_id:randomUUID(),p_payload:{scope:{kind:'positioning_draft'}}});
 const policy={modelId,model:'synthetic/mentor',provider:'openrouter',account:'synthetic-browser',protocol:'openrouter-chat-v1',
  upperUsd:'0.02',inputLimit:30000,outputLimit:8192,automaticRetry:false,hiddenTools:false,lookupSupported:true,
  providerLimits:{providerSlug:'synthetic',contextTokens:40000,promptUsdPerMillion:'0.5',completionUsdPerMillion:'0',requestUsd:'0'}};
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Synthetic browser',$2,'openrouter',true)",[modelId,policy.model]);
 await db.query("insert into runtime_test_windows(id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at) values($1,true,$2,$3,1000,1,0.10,3,now()+interval '2 hours')",[windowId,[actorId],JSON.stringify([policy])]);
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',inputSelection:'scope-projection-v1',
  providerRequestFormat:'agent-turn-v5-stream',questionContract:QUESTION_CONTRACT,reasoning:{effort:'none'},
  input:'Synthetic original input',instructions:'Return one public question',model:policy.model,modelId,maxOutputTokens:8192,
  maxTurns:1,historyItems:20,network:'deny',tools:['ask_question'],request:{sessionId:session.sessionId,requestId,organizeAfter:false}};
 const billing={contractVersion:'bill2.v1',mode:'staging_test',testWindowId:windowId,scope:session.scope,operation:'question',
  modelId,sourceHash:hash('synthetic-browser'),input:context,callPolicy:[policy],rules:{version:'runtime-staging-v1',
   quoteVersion:windowId,creditsPerUsd:'1000',multiplier:'1',fx:{}},limits:{costUsd:'0.02',credits:20,maxPreDeduct:20,
   maxCalls:1,deadline:new Date(Date.now()+3600000).toISOString()}};
 const execution=await rpc('runtime_admit',{p_actor_id:actorId,p_session_id:session.sessionId,p_request_id:requestId,
  p_payload:context,p_billing:billing});
 return {actorId,execution,session};
}

it('ERASURE_BROWSER: erasure during streamed execution retains only financial evidence',async()=>{
 const f=await fixture(),budget=createRuntimeBudget();let revoked=false,posts=0;
 const gate=latch(),seen=latch();
 const jwt='local.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.only';
 const auth={getSession:vi.fn(async()=>({data:{session:{access_token:jwt}},error:null})),
  getUser:vi.fn(async()=>({data:{user:revoked?null:{id:f.actorId}},error:revoked?{message:'Synthetic revoked token',status:401}:null}))};
 const actor=runtimeActor(auth as unknown as Parameters<typeof runtimeActor>[0],f.actorId,budget);
 const id='gen-browser-'+f.execution.executionId;
 const adapter=openRouterAdapter({allowAgentTools:true,budget,credential:async()=> 'SYNTHETIC_LOCAL_ONLY',
  transport:async(_url,init)=>{
   expect(init?.method).toBe('POST');posts++;
   const frame=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id,model:'synthetic/mentor',
    choices:[{index:0,delta,finish_reason}]})+'\n\n';
   const encoder=new TextEncoder();
   return new Response(new ReadableStream<Uint8Array>({async start(controller){
    controller.enqueue(encoder.encode(frame({role:'assistant',content:'PRIVATE_CLOSED_TEXT'})));seen.release();
    await gate.promise;
    controller.enqueue(encoder.encode(frame({tool_calls:[{index:0,id:'closed-card',type:'function',function:{name:'ask_question',
     arguments:JSON.stringify({message:'PRIVATE_CLOSED_CARD',question:'Range?',options:['First','Second'],recommended:null,
      recommendationReason:null})}}]},'tool_calls')));
    controller.enqueue(encoder.encode('data: '+JSON.stringify({id,model:'synthetic/mentor',choices:[],
     usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,cost:0.003}})+'\n\ndata: [DONE]\n\n'));controller.close();
   }}),{headers:{'content-type':'text/event-stream','x-generation-id':id}});
  }});
 const financial=inflightFinancialHost({database:admin,actorId:f.actorId,executionId:f.execution.executionId,actor,budget});
 const run=async(onProgress:(event:RuntimeProgress)=>void)=>{
  try{return await runtimeExecutor({callGate:allowTestCalls,database:financial.database,actor,budget,adapter})
   .execute(f.execution.executionId,onProgress);}
  finally{await financial.finish(adapter);}
 };
 let eventRequest:Promise<void>|undefined;
 const html=`<!doctype html><html><body><h1>Local erasure recovery proof</h1>
 <p id="status">Connecting</p><pre id="reply"></pre><script>
 window.events=[];
 (async()=>{const response=await fetch('/events');const reader=response.body.getReader();
 const decoder=new TextDecoder();let pending='';
 for(;;){const part=await reader.read();if(part.done)break;pending+=decoder.decode(part.value,{stream:true});
 let end;while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);
 if(!line)continue;const event=JSON.parse(line);window.events.push(event);
 if(event.type==='text')document.querySelector('#reply').textContent=event.text;
 if(event.type==='card')document.querySelector('#reply').textContent+=JSON.stringify(event.card);
 document.querySelector('#status').textContent=event.type==='result'?event.result.state:event.phase||event.type;
 }}document.body.dataset.done='true';})().catch(()=>{document.body.dataset.failed='true';});
 </script></body></html>`;
 const web=createServer((req,res)=>{
  if(req.url!=='/events'){res.setHeader('content-type','text/html');res.end(html);return;}
  res.setHeader('content-type','application/x-ndjson');res.flushHeaders();
  eventRequest=(async()=>{
   try{for await(const event of streamOriginalExecution(run,budget.timing,'local-erasure-proof'))res.write(JSON.stringify(event)+'\n');}
   finally{res.end();}
  })();
 });
 await new Promise<void>(resolve=>web.listen(0,'127.0.0.1',resolve));
 const address=web.address();if(!address||typeof address==='string')throw new Error('local browser listener required');
 const origin='http://127.0.0.1:'+address.port;
 const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const browser=await chromium.launch({headless:true,...(existsSync(chrome)?{executablePath:chrome}:{})});
 const context=await browser.newContext();
 await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
 const page=await context.newPage();
 try{
  await page.goto(origin);await seen.promise;
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent==='mentor');
  expect(await page.locator('#reply').textContent()).toBe('');
  await db.query('select account_erasure_confirm_with_digests($1,$2,$3)',[f.actorId,randomUUID(),
   JSON.stringify([{kind:'email',key_version:'b2a_local_v1',digest:hash(f.actorId)}])]);revoked=true;
  await expect(actor()).rejects.toThrow('RUNTIME_DENIED');
  gate.release();await page.waitForFunction(()=>document.body.dataset.done==='true');
  expect(await page.locator('body').innerText()).not.toContain('PRIVATE_CLOSED');
  expect(await page.locator('#reply').textContent()).toBe('');
  expect(await page.locator('#status').textContent()).toBe('pending');
  const events=await page.evaluate(()=>Reflect.get(window,'events') as RuntimeProgress[]);
  expect(events.filter(event=>event.type==='text'||event.type==='card')).toEqual([]);
  expect(posts).toBe(1);
  expect((await db.query('select state,closed,charged from bill2_runs where id=$1',[f.execution.runId])).rows[0])
   .toEqual({state:'settled',closed:true,charged:3});
  expect((await db.query('select state,result from runtime_executions where id=$1',[f.execution.executionId])).rows[0])
   .toEqual({state:'cancelled',result:null});
  expect((await db.query('select active_execution from runtime_sessions where id=$1',[f.session.sessionId])).rows[0].active_execution).toBeNull();
  expect(JSON.stringify((await db.query('select item from runtime_session_history where session_id=$1',[f.session.sessionId])).rows))
   .not.toContain('PRIVATE_CLOSED');
  await page.screenshot({path:'/tmp/erasure-browser-proof.png'});
 }finally{
  gate.release();await eventRequest;await context.close();await browser.close();web.closeAllConnections();
  await new Promise<void>(resolve=>web.close(()=>resolve()));
 }
},30000);
