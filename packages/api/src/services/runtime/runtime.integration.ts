/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { PostgresSession } from './session';
import { runRuntime } from './runner';
import { runtimeExecutor } from './execute';
import { runtimeAdmissionService } from './admission';
import { activateRuntimeCandidate } from './matching';
import { makePackage, makeWorkflow } from '../__tests__/fixtures/artifacts';
import { workbenchService } from '../artifacts/workbench';
import { artifactReuse } from '../artifacts/reuse';
import { publishSkillPackage } from '../skills/publication';
import { chromium } from '../../../../../apps/web/node_modules/@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable')) throw new Error('isolated runner required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST!,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const modelId=randomUUID();
async function rpc(name:string,args:Record<string,unknown>){const r=await admin.rpc(name,args);if(r.error)throw new Error(r.error.message);return r.data;}
beforeAll(async()=>{await db.connect();await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Runtime local','runtime-m','fixture','true')",[modelId]);});
afterAll(async()=>{await db.end();});
async function fixture(){
 const actorId=randomUUID();await db.query('insert into profiles(id,credits) values($1,100)',[actorId]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actorId,'opening:'+actorId]);
 const requestId=randomUUID(),start={scope:{kind:'positioning_draft'}};
 const s=await rpc('runtime_start',{p_actor_id:actorId,p_request_id:requestId,p_payload:start});
 const billing={contractVersion:'bill2.v1',mode:'isolated',scope:s.scope,operation:'question',modelId,sourceHash:createHash('sha256').update('runtime').digest('hex'),input:{text:'hello'},
 callPolicy:[{modelId,provider:'fixture',account:'sandbox',model:'runtime-m',protocol:'fixture-cost-v1',upperUsd:'0.02',inputLimit:10000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true}],
 rules:{version:'v1',quoteVersion:'local-v1',creditsPerUsd:'1000',multiplier:'1',fx:{}},limits:{costUsd:'0.02',credits:20,maxPreDeduct:20,maxCalls:1,deadline:new Date(Date.now()+3600000).toISOString()}};
 const admit={p_actor_id:actorId,p_session_id:s.sessionId,p_request_id:randomUUID(),p_payload:{text:'hello'},p_billing:billing};
 return {actorId,start,requestId,s,billing,admit};
}
it('RUNTIME: atomic draft/session/start replay, admission and SDK append identities',async()=>{
 const f=await fixture();expect(await rpc('runtime_start',{p_actor_id:f.actorId,p_request_id:f.requestId,p_payload:f.start})).toEqual(f.s);
 const e=await rpc('runtime_admit',f.admit);expect(await rpc('runtime_admit',f.admit)).toEqual(e);
 const state=(await db.query('select credits,(select session_ref from bill2_runs where id=$2) session from profiles where id=$1',[f.actorId,e.runId])).rows[0];
 expect(state).toEqual({credits:80,session:f.s.sessionId});
 const binding={actorId:f.actorId,sessionId:f.s.sessionId,executionId:e.executionId};
 const session=new PostgresSession(admin,binding);expect(await session.getSessionId()).toBe(f.s.sessionId);expect(await session.getItems()).toEqual([]);
 const item={role:'user' as const,content:'same message'};
 await session.addItems([item]);await session.addItems([item]);
 // Same bytes in two distinct SDK batches are legitimate; replay batch zero is idempotent.
 await new PostgresSession(admin,binding).addItems([item]);
 expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[f.s.sessionId])).rows[0].n).toBe(2);
 await expect(new PostgresSession(admin,binding).addItems([{role:'user',content:'conflict'}])).rejects.toThrow('UNAVAILABLE');
 await expect(session.clearSession()).rejects.toThrow('IMMUTABLE');
 await expect(rpc('runtime_admit',{...f.admit,p_request_id:randomUUID()})).rejects.toThrow('BUSY');
 await expect(rpc('runtime_admit',{...f.admit,p_payload:{text:'changed'}})).rejects.toThrow('CONFLICT');
 await expect(db.query('update bill2_runs set session_ref=null where id=$1',[e.runId])).rejects.toThrow('IMMUTABLE_BINDING');
});
it('RUNTIME: rejected binding rolls back reservation and excludes wrong actor/session',async()=>{
 const f=await fixture();await expect(rpc('runtime_admit',{...f.admit,p_billing:{...f.billing,scope:{kind:'positioning_draft',draftId:randomUUID()}}})).rejects.toThrow('BINDING_DENIED');
 expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(100);
 await expect(rpc('runtime_admit',{...f.admit,p_session_id:randomUUID()})).rejects.toThrow('DENIED');
 const g=await fixture();await expect(rpc('runtime_admit',{...f.admit,p_actor_id:g.actorId})).rejects.toThrow('DENIED');
});

it('RUNTIME: official SDK uses bound PostgreSQL Session and persists input/output after local HTTP',async()=>{
 const f=await fixture(),e=await rpc('runtime_admit',f.admit);
 const session=new PostgresSession(admin,{actorId:f.actorId,sessionId:f.s.sessionId,executionId:e.executionId});
 let requests=0;let beforeHttpItems=-1;let sentModel='';let boundBeforeHttp=false;
 const server=createServer(async(req,res)=>{requests++;let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw);sentModel=body.model;
  const rows=await db.query('select item from runtime_session_history where session_id=$1',[f.s.sessionId]);
  beforeHttpItems=rows.rows.length;
  boundBeforeHttp=Boolean((await db.query('select 1 from runtime_executions e join bill2_runs b on b.id=e.billing_run_id where e.id=$1 and b.session_ref=e.session_id and e.payload is not null',[e.executionId])).rowCount);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'local-sdk-1',object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:{role:'assistant',content:'SDK durable answer'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('local server');
  const body=await runRuntime({model:'runtime-m',instructions:'Local test',input:'Hello',session,maxOutputTokens:100,maxTurns:1,tools:[],
   selectHistory:async(history,incoming)=>[...history,...incoming],exchange:async(_sequence,request)=>{
    const response=await fetch('http://127.0.0.1:'+address.port,{method:'POST',body:request,signal:AbortSignal.timeout(5000)});return response.text();
   }});
  expect(body).toBe('SDK durable answer');expect(requests).toBe(1);expect(sentModel).toBe('runtime-m');expect(boundBeforeHttp).toBe(true);expect(beforeHttpItems).toBe(0); // Locked SDK persists the initial batch at its final checkpoint, not before HTTP.
  const saved=(await db.query('select item from runtime_session_history where session_id=$1 order by revision',[f.s.sessionId])).rows;
  expect(JSON.stringify(saved)).toContain('SDK durable answer');expect(saved.length).toBe(2);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it.each(['none','session','result_before','result_after','receipt_before','receipt_after','receipt_unavailable','receipt_revoked','result_revoked'])('RUNTIME: SDK to receipt/Session/financial terminal, %s fault recovers without HTTP replay',async fault=>{
 const f=await fixture();
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'hello',instructions:'Fixture instruction',model:'runtime-m',maxOutputTokens:100,maxTurns:1,historyItems:20};
 const e=await rpc('runtime_admit',{...f.admit,p_payload:context,p_billing:{...f.billing,input:context}});let requests=0;
 const response={id:'generation-runtime-'+e.executionId,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:{role:'assistant',content:'Original durable answer'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}};
 const server=createServer(async(req,res)=>{for await(const _ of req){/* isolated request */}requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:response.id,model:'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:response}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('local fixture');
  let injected=false;
  const database={rpc:(name:string,args:Record<string,unknown>)=>{
   const target=(fault==='session'&&name==='runtime_session_items'&&args.p_action==='append')
    ||(fault.startsWith('result_')&&name==='runtime_execution'&&args.p_action==='complete')
    ||(fault.startsWith('receipt_')&&name==='bill2_record');
   if(target&&(!injected||fault==='receipt_unavailable')){
    injected=true;
    return (async()=>{
     if(fault==='result_revoked'||fault==='receipt_revoked')await rpc('bill2_revoke_draft',{p_actor_id:f.actorId,p_draft_id:f.s.scope.draftId});
     if(fault.endsWith('_after')){const committed=await admin.rpc(name,args);if(committed.error)throw committed.error;}
     return {data:null,error:{message:'synthetic durable response failure'}};
    })();
   }
   return admin.rpc(name,args);
  }};
  const options={database,actor:async()=>f.actorId,endpoint:'http://127.0.0.1:'+address.port};
  const first=await runtimeExecutor(options).execute(e.executionId);
  if(!['none','receipt_before','receipt_after'].includes(fault)){expect(injected).toBe(true);expect(first).toEqual({state:'pending'});expect(requests).toBe(1);expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(fault==='result_after'?97:80);}
  else expect(first).toEqual({state:'completed',body:'Original durable answer'});
  if(fault==='receipt_unavailable'){
   // Every bounded persistence attempt is unavailable; process-local evidence
   // cannot be reconstructed by a new host if no storage accepted it.
   expect(await runtimeExecutor(options).execute(e.executionId)).toEqual({state:'pending'});
   expect((await runtimeExecutor(options).cancel(e.executionId)).state).toBe('cost_pending');
   expect((await runtimeExecutor(options).execute(e.executionId)).state).toBe('cost_pending');
   expect(requests).toBe(1);
   const run=(await db.query('select request_id,session_ref,scope from bill2_runs where id=$1',[e.runId])).rows[0];
   expect(run).toEqual({request_id:f.admit.p_request_id,session_ref:f.s.sessionId,scope:f.s.scope});
   expect((await db.query('select state,provider_id from bill2_calls where run_id=$1',[e.runId])).rows).toEqual([{state:'dispatched',provider_id:null}]);
   expect((await db.query('select result from runtime_executions where id=$1',[e.executionId])).rows[0].result).toBeNull();
   expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[f.s.sessionId])).rows[0].n).toBe(0);
   expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits:80,ledger:80});
   return;
  }
  if(fault==='receipt_revoked'){
   const calls=(await db.query('select id,provider_id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[e.runId])).rows;
   expect(calls).toHaveLength(1);expect(calls[0].provider_id).toBe(response.id);expect(Number(calls[0].cost)).toBe(0.003);
   const receipts=(await db.query('select payload from bill2_receipts where call_id=$1',[calls[0].id])).rows;
   expect(receipts).toHaveLength(1);expect(JSON.stringify(receipts)).toContain('Original durable answer');
   const inspection={p_actor_id:f.actorId,p_execution_id:e.executionId,p_run_id:e.runId,p_call_id:calls[0].id,p_evidence:receipts[0].payload};
   expect(await rpc('runtime_receipt_saved',inspection)).toBe(true);
   await expect(rpc('runtime_receipt_saved',{...inspection,p_actor_id:randomUUID()})).rejects.toThrow('DENIED');
   await expect(rpc('runtime_receipt_saved',{...inspection,p_call_id:randomUUID()})).rejects.toThrow('DENIED');
   const anonymous=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
   expect((await anonymous.rpc('runtime_receipt_saved',inspection)).error).not.toBeNull();
   await expect(runtimeExecutor(options).execute(e.executionId)).rejects.toThrow('UNAVAILABLE');
   const financial=await runtimeExecutor(options).recoverFinancial(e.executionId);
   expect(financial.state).toBe('cancelled');expect(JSON.stringify(financial)).not.toContain('Original durable answer');
   expect(await runtimeExecutor(options).recoverFinancial(e.executionId)).toEqual(financial);
   expect(requests).toBe(1);
   expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[f.s.sessionId])).rows[0].n).toBe(0);
   expect((await db.query("select credits,(select count(*)::int from billing_history where user_id=$1 and operation_type='settle') terminals from profiles where id=$1",[f.actorId])).rows[0]).toEqual({credits:97,terminals:1});
   return;
  }
  if(fault==='result_revoked'){
   await expect(runtimeExecutor(options).execute(e.executionId)).rejects.toThrow('UNAVAILABLE');
   const saved=(await db.query('select item from runtime_session_history where session_id=$1 order by revision',[f.s.sessionId])).rows;
   expect(saved).toHaveLength(2);expect(JSON.stringify(saved)).toContain('Original durable answer');
   expect((await db.query('select result from runtime_executions where id=$1',[e.executionId])).rows[0].result).toBeNull();
   const financial=await runtimeExecutor(options).recoverFinancial(e.executionId);expect(financial.state).toBe('cancelled');
   expect(JSON.stringify(financial)).not.toContain('Original durable answer');
   expect(await runtimeExecutor(options).recoverFinancial(e.executionId)).toEqual(financial);
   await expect(new PostgresSession(admin,{actorId:f.actorId,sessionId:f.s.sessionId,executionId:e.executionId}).getItems()).rejects.toThrow('UNAVAILABLE');
   expect((await db.query('select item from runtime_session_history where session_id=$1 order by revision',[f.s.sessionId])).rows).toEqual(saved);
  }else{
   const recovered=await runtimeExecutor(options).execute(e.executionId);
   expect(recovered).toEqual({state:'completed',body:'Original durable answer'});
  }
  expect(requests).toBe(1);
  if(fault.startsWith('receipt_')){
   expect(injected).toBe(true);
   const call=(await db.query('select id,provider_id,selected_cost_usd::text cost from bill2_calls where run_id=$1',[e.runId])).rows[0];
   expect(call.provider_id).toBe(response.id);expect(Number(call.cost)).toBe(0.003);
   const receipts=(await db.query('select payload from bill2_receipts where call_id=$1',[call.id])).rows;
   expect(receipts).toHaveLength(1);expect(JSON.stringify(receipts)).toContain(response.id);expect(JSON.stringify(receipts)).toContain('Original durable answer');
  }
  const money=(await db.query('select credits,(select count(*)::int from billing_history where user_id=$1 and operation_type=\'settle\') terminals from profiles where id=$1',[f.actorId])).rows[0];
  expect(money).toEqual({credits:97,terminals:1});
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[f.s.sessionId])).rows[0].n).toBe(2);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it.each(['before_dispatch','before_tool'] as const)('RUNTIME: concurrent replay %s cannot interrupt the live SDK owner',async mode=>{
 const f=await fixture(),context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Concurrent request',instructions:'Use permitted tools when needed',model:'runtime-m',maxOutputTokens:100,maxTurns:2,historyItems:20,network:'allow',tools:['search'],maxToolCalls:1};
 const billing={...f.billing,input:context,limits:{...f.billing.limits,costUsd:'0.06',credits:60,maxPreDeduct:60,maxCalls:3}};
 const e=await rpc('runtime_admit',{...f.admit,p_payload:context,p_billing:billing});
 let signalReady!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{signalReady=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 let posts=0;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(JSON.parse(raw).input);const n=++posts;
  if(mode==='before_tool'&&n===1){signalReady();await held;}
  const id='concurrent-'+e.executionId+'-'+n;
  const tool=n===1&&mode==='before_tool';
  const usage=input.tool?{toolResult:{body:'Local search evidence',sources:[{id:'isolated',version:'v1',status:'available'}]}}:
   {sdkResponse:{id,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:tool?{role:'assistant',content:null,tool_calls:[{id:'concurrent-search',type:'function',function:{name:'search',arguments:'{"query":"material"}'}}]}:{role:'assistant',content:'Original concurrent answer'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
 const endpoint='http://127.0.0.1:'+address.port,actor=async()=>f.actorId;
 const database={rpc:async(name:string,args:Record<string,unknown>)=>{
  const result=await admin.rpc(name,args);
  if(mode==='before_dispatch'&&name==='runtime_execution'&&args.p_action==='begin'&&result.data?.live){signalReady();await held;}
  return result;
 }};
 const original=runtimeExecutor({database,actor,endpoint}).execute(e.executionId);
 try{
  await ready;
  expect((await runtimeExecutor({database:admin,actor,endpoint}).execute(e.executionId)).state).toBe('pending');
  expect((await db.query('select state from runtime_executions where id=$1',[e.executionId])).rows[0].state).toBe('running');
  expect(posts).toBe(mode==='before_dispatch'?0:1);
  release();expect(await original).toEqual({state:'completed',body:'Original concurrent answer'});
  expect((await runtimeExecutor({database:admin,actor,endpoint}).execute(e.executionId)).state).toBe('completed');
  expect(posts).toBe(mode==='before_dispatch'?1:3);
  expect((await db.query('select count(*)::int n from bill2_runs where actor_id=$1',[f.actorId])).rows[0].n).toBe(1);
  expect((await db.query('select session_ref from bill2_runs where id=$1',[e.runId])).rows[0].session_ref).toBe(f.s.sessionId);
  const credits=mode==='before_dispatch'?97:91;
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits,ledger:credits});
  expect((await db.query('select count(*)::int n from runtime_session_history where execution_id=$1',[e.executionId])).rows[0].n).toBe(mode==='before_dispatch'?2:4);
 }finally{release();await original.catch(()=>{});await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it('RUNTIME: simultaneous authenticated prepare returns the first immutable run despite regenerated deadlines',async()=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id;await db.query('insert into profiles(id,email,credits) values($1,$2,100)',[actor,email]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,'opening:'+actor]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const login=await user.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:100,inputBytes:10000,historyItems:20};
 const service=runtimeAdmissionService(user,admin,policy),session=await service.start(randomUUID(),{kind:'positioning_draft'});
 let empty=0,bothReady!:()=>void,firstReady!:()=>void;const both=new Promise<void>(resolve=>{bothReady=resolve;}),first=new Promise<void>(resolve=>{firstReady=resolve;}),deadlines:string[]=[];
 const racing=Object.create(admin) as typeof admin;
 racing.rpc=(async(name:string,args:Record<string,unknown>)=>{
  if(name==='runtime_admit'){deadlines.push((args.p_billing as {limits:{deadline:string}}).limits.deadline);firstReady();}
  const result=await admin.rpc(name,args);
  if(name==='runtime_admission_replay'&&!result.error&&!result.data){
   const n=++empty;if(n===2)bothReady();await both;
   if(n===2){await first;await new Promise(resolve=>setTimeout(resolve,20));}
  }
  return result;
 }) as unknown as typeof admin.rpc;
 const request={sessionId:session.sessionId,requestId:randomUUID(),input:'Same public request',selection:{kind:'ordinary',modelId}};
 const admission=runtimeAdmissionService(user,racing,policy);
 const results=await Promise.all([admission.prepare(request),admission.prepare(request)]);
 expect(results[0]).toEqual(results[1]);expect(empty).toBe(2);expect(new Set(deadlines).size).toBe(2);
 await expect(admission.prepare({...request,input:'Different request'})).rejects.toThrow();
 const run=(await db.query('select id,request_id,session_ref from bill2_runs where actor_id=$1',[actor])).rows;
 expect(run).toEqual([{id:results[0].runId,request_id:request.requestId,session_ref:session.sessionId}]);
 expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:80,ledger:80});
});

it('RUNTIME: actual Auth admission resolves configured ordinary model and rejects anonymous/foreign/missing models',async()=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const id=created.data.user.id;await db.query('insert into profiles(id,email,credits) values($1,$2,100)',[id,email]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const login=await user.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:100,inputBytes:10000,historyItems:20};
 const service=runtimeAdmissionService(user,admin,policy),start=await service.start(randomUUID(),{kind:'positioning_draft'});
 const request={sessionId:start.sessionId,requestId:randomUUID(),input:'hello',selection:{kind:'ordinary',modelId}};
 const e=await service.prepare(request);expect(await service.prepare(request)).toEqual(e);
 await expect(service.prepare({...request,input:'different'})).rejects.toThrow('DENIED');
 const foreign=await fixture();await expect(service.prepare({...request,sessionId:foreign.s.sessionId})).rejects.toThrow('DENIED');
 const second=await service.start(randomUUID(),{kind:'positioning_draft'});
 await expect(service.prepare({...request,sessionId:second.sessionId,requestId:randomUUID(),selection:{kind:'ordinary',modelId:randomUUID()}})).rejects.toThrow('CAPABILITY_UNVERIFIED');
 const anonymous=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 for(const client of [anonymous,user]){
  const denied=await client.rpc('runtime_financial_recovery',{p_actor_id:id,p_execution_id:e.executionId,p_finish:true});
  expect(denied.error?.code).toBe('42501');expect(denied.data).toBeNull();
 }

 await expect(runtimeAdmissionService(anonymous,admin,policy).prepare(request)).rejects.toThrow('AUTH_REQUIRED');
 expect((await db.query('select credits from profiles where id=$1',[id])).rows[0].credits).toBe(80);
});

it.each(['allow','deny','require_latest','require_latest_no_search'] as const)('RUNTIME: official SDK search tool %s checks capability and keeps all costs in original run',async mode=>{
 const network=mode==='require_latest_no_search'?'require_latest':mode;
 const f=await fixture();
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Find current material',instructions:'Use search for current material',model:'runtime-m',maxOutputTokens:100,maxTurns:3,historyItems:20,network,tools:['search'],maxToolCalls:1};
 const billing={...f.billing,limits:{...f.billing.limits,costUsd:'0.06',credits:60,maxPreDeduct:60,maxCalls:3}};
 const e=await rpc('runtime_admit',{...f.admit,p_payload:context,p_billing:{...billing,input:context}});
 let requests=0,searchRequests=0;const observedInputs:Record<string,unknown>[]=[];
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(JSON.parse(text).input);requests++;observedInputs.push(input);
  const receipt={id:'tool-generation-'+e.executionId+'-'+requests,model:'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total'};
  let usage:unknown;
  if(input.tool){searchRequests++;usage={toolResult:{body:'Current isolated evidence',sources:[{id:'fixture-source',version:'v1',status:'available'}]}};}
  else{const first=requests===1&&mode!=='require_latest_no_search';
   usage={sdkResponse:{id:receipt.id,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:first?{role:'assistant',content:null,tool_calls:[{id:'original-search',type:'function',function:{name:'search',arguments:'{"query":"latest"}'}}]}:{role:'assistant',content:'Answer with isolated source'},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify({...receipt,usage}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('local fixture');
  const options={database:admin,actor:async()=>f.actorId,endpoint:'http://127.0.0.1:'+address.port};
  const first=await runtimeExecutor(options).execute(e.executionId);
  if(mode==='require_latest_no_search'){
   expect(first).toEqual({state:'cancelled',unavailable:'latest'});expect(requests).toBe(1);expect(searchRequests).toBe(0);
   const view=await rpc('runtime_view',{p_actor_id:f.actorId,p_session_id:f.s.sessionId});
   expect(view.executions[0].unavailableReason).toBe('latest_unavailable');expect(view.executions[0].body).toBeNull();expect(view.executions[0].contentAvailable).toBe(false);
   expect((await runtimeExecutor(options).execute(e.executionId)).state).toBe('cancelled');expect(requests).toBe(1);
   const next=await rpc('runtime_admit',{...f.admit,p_request_id:randomUUID()});
   expect(await new PostgresSession(admin,{actorId:f.actorId,sessionId:f.s.sessionId,executionId:next.executionId}).getItems()).toEqual([]);
   await runtimeExecutor(options).cancel(next.executionId);
   expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits:97,ledger:97});
   expect((await db.query('select count(*)::int n from runtime_session_history where execution_id=$1',[e.executionId])).rows[0].n).toBe(2);
  }else if(network!=='deny'){
   expect(first).toEqual({state:'completed',body:'Answer with isolated source'});expect(requests).toBe(3);expect(searchRequests).toBe(1);
   expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(91);
   expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[e.runId])).rows[0].n).toBe(3);
   expect((await db.query('select result from runtime_tool_calls where execution_id=$1',[e.executionId])).rows[0].result.sources[0].version).toBe('v1');
   await runtimeExecutor(options).execute(e.executionId);expect(requests).toBe(3);
   if(mode==='allow'){
    // Actual persisted SDK history ends in call/result/answer. A two-item
    // suffix would orphan the result; execute the next turn through SDK/HTTP
    // and verify only the independent answer survives the capacity selection.
    const original=await db.query('select item from runtime_session_history where execution_id=$1 order by revision',[e.executionId]);
    expect(original.rows.some(row=>row.item.type==='function_call')).toBe(true);
    expect(original.rows.some(row=>row.item.type==='function_call_result')).toBe(true);
    const next=await rpc('runtime_admit',{...f.admit,p_request_id:randomUUID(),p_payload:{...context,input:'Follow up',historyItems:2},p_billing:{...billing,input:{...context,input:'Follow up',historyItems:2}}});
    expect(await runtimeExecutor(options).execute(next.executionId)).toEqual({state:'completed',body:'Answer with isolated source'});
    expect(requests).toBe(4);expect(searchRequests).toBe(1);
    const messages=observedInputs.at(-1)!.messages as Array<Record<string,unknown>>;
    expect(messages.some(message=>message.role==='tool'||message.tool_calls)).toBe(false);
    expect(JSON.stringify(messages)).toContain('Follow up');expect(JSON.stringify(messages)).toContain('Answer with isolated source');
    expect((await db.query('select item from runtime_session_history where execution_id=$1 order by revision',[e.executionId])).rows).toEqual(original.rows);
    await runtimeExecutor(options).execute(next.executionId);expect(requests).toBe(4);
    expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits:88,ledger:88});
   }
  }else{
   expect(first.state).toBe('pending');expect(requests).toBe(1);expect(searchRequests).toBe(0);
   await runtimeExecutor(options).execute(e.executionId);expect(requests).toBe(1);
  }
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it('RUNTIME: ordinary, document Skill without workflow, and separate organizer use the same SDK/accounting host',async()=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id;await db.query("insert into profiles(id,email,credits,role) values($1,$2,500,'admin')",[actor,email]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const login=await user.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 const skillModel=randomUUID(),summaryModel=randomUUID(),moduleId=randomUUID(),pack=makePackage();
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Skill fixture','runtime-skill','fixture','true'),($2,'Summary fixture','runtime-summary','fixture','true')",[skillModel,summaryModel]);
 await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'runtime-doc-'+pack.id,actor]);
 await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Document Skill',$2,true,$3)",[moduleId,pack.id,skillModel]);
 await publishSkillPackage(admin,actor,pack);
 await db.query("insert into system_settings(key,value) values('v3_summary_model_id',to_jsonb($1::text)) on conflict(key) do update set value=excluded.value",[summaryModel]);
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:200,inputBytes:10000,historyItems:20};
 const service=runtimeAdmissionService(user,admin,policy),start=await service.start(randomUUID(),{kind:'positioning_draft'});
 const calls:Array<{model:string;input:unknown}>=[];
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(JSON.parse(raw).input);calls.push({model:input.model,input});
  const id='roles-'+randomUUID();res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:input.model,final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:{id,object:'chat.completion',created:1,model:input.model,choices:[{index:0,message:{role:'assistant',content:'Completed '+input.model},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
  const executor=runtimeExecutor({database:admin,actor:async()=>actor,endpoint:'http://127.0.0.1:'+address.port});
  const previousCapacity=(await db.query('select input_limit from ai_models where id=$1',[skillModel])).rows[0].input_limit;
  await db.query('update ai_models set input_limit=200 where id=$1',[skillModel]);
  await expect(service.prepare({sessionId:start.sessionId,requestId:randomUUID(),input:'Please work',selection:{kind:'skill',moduleId,revisionId:pack.revisionId}})).rejects.toThrow('RUNTIME_MODEL_CAPACITY');
  expect((await db.query('select count(*)::int n from runtime_executions where session_id=$1',[start.sessionId])).rows[0].n).toBe(0);
  expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(500);
  expect(calls).toHaveLength(0);
  await db.query('update ai_models set input_limit=$2 where id=$1',[skillModel,previousCapacity]);
  for(const selection of [{kind:'ordinary',modelId},{kind:'skill',moduleId,revisionId:pack.revisionId},{kind:'organizer'}]){
   const e=await service.prepare({sessionId:start.sessionId,requestId:randomUUID(),input:'Please work',selection});
   expect((await executor.execute(e.executionId)).state).toBe('completed');
  }
  expect(calls.map(c=>c.model)).toEqual(['runtime-m','runtime-skill','runtime-summary']);
  expect(JSON.stringify(calls[1].input)).toContain('METHOD_CANARY');expect(JSON.stringify(calls[0].input)).not.toContain('METHOD_CANARY');
  expect((await db.query('select count(*)::int n from runtime_executions where session_id=$1',[start.sessionId])).rows[0].n).toBe(3);
  expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(491);
  await expect(service.prepare({sessionId:start.sessionId,requestId:randomUUID(),input:'x',selection:{kind:'skill',moduleId,revisionId:pack.revisionId,modelId}})).rejects.toThrow();
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it('RUNTIME: work item Session validates parent/actor and stays separate from draft',async()=>{
 const f=await fixture(),moduleId=randomUUID(),skillId=randomUUID(),parent=randomUUID(),work=randomUUID();
 await db.query("insert into modules(id,title) values($1,'Work fixture')",[moduleId]);await db.query('insert into skills(id,skill_key) values($1,$2)',[skillId,'work-'+skillId]);
 await db.query('insert into artifact_projects(id,actor_id,module_id,skill_id) values($1,$2,$3,$4)',[parent,f.actorId,moduleId,skillId]);
 await db.query("insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id) values($1,$2,$3,$4,'script',$5)",[work,f.actorId,moduleId,skillId,parent]);
 const scope={kind:'work_item',projectId:parent,workItemId:work};
 const start=await rpc('runtime_start',{p_actor_id:f.actorId,p_request_id:randomUUID(),p_payload:{scope}});
 expect(start.sessionId).not.toBe(f.s.sessionId);
 await expect(rpc('runtime_start',{p_actor_id:f.actorId,p_request_id:randomUUID(),p_payload:{scope:{...scope,projectId:randomUUID()}}})).rejects.toThrow('DENIED');
 const e=await rpc('runtime_admit',{...f.admit,p_session_id:start.sessionId,p_billing:{...f.billing,scope}});
 await expect(new PostgresSession(admin,{actorId:f.actorId,sessionId:f.s.sessionId,executionId:e.executionId}).getItems()).rejects.toThrow('UNAVAILABLE');
 const session=new PostgresSession(admin,{actorId:f.actorId,sessionId:start.sessionId,executionId:e.executionId});
 await session.addItems([{role:'user',content:'Work only'}]);
 expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[f.s.sessionId])).rows[0].n).toBe(0);
});
it('RUNTIME: authenticated work item runs actual SDK and HTTP then restores only its original Session',async()=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id,moduleId=randomUUID(),skillId=randomUUID(),parent=randomUUID(),work=randomUUID();
 await db.query('insert into profiles(id,email,credits) values($1,$2,100)',[actor,email]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,'opening:'+actor]);
 await db.query("insert into modules(id,title) values($1,'Work HTTP fixture')",[moduleId]);
 await db.query('insert into skills(id,skill_key) values($1,$2)',[skillId,'work-http-'+skillId]);
 await db.query('insert into artifact_projects(id,actor_id,module_id,skill_id) values($1,$2,$3,$4)',[parent,actor,moduleId,skillId]);
 await db.query("insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id) values($1,$2,$3,$4,'script',$5)",[work,actor,moduleId,skillId,parent]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:200,inputBytes:20000,historyItems:30};
 const admission=runtimeAdmissionService(user,admin,policy),scope={kind:'work_item',projectId:parent,workItemId:work};
 await expect(admission.start(randomUUID(),scope)).rejects.toThrow('AUTH');
 const login=await user.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 const startId=randomUUID(),session=await admission.start(startId,scope);
 expect(await admission.start(startId,scope)).toEqual(session);
 await expect(admission.start(randomUUID(),{...scope,projectId:randomUUID()})).rejects.toThrow();
 const draft=await admission.start(randomUUID(),{kind:'positioning_draft'});
 const materialInput={sessionId:session.sessionId,requestId:randomUUID(),expectedRevision:0,brief:'Frozen work brief v1',material:'Current scope material v1'};
 const material=await admission.saveMaterial(materialInput);expect(await admission.saveMaterial(materialInput)).toEqual(material);
 const scopeContext=await rpc('runtime_session_context',{p_actor_id:actor,p_session_id:session.sessionId});
 const template=await fixture();
 const mismatched={...template.billing,scope,input:{text:'omitted private material'}};
 await expect(rpc('runtime_admit',{p_actor_id:actor,p_session_id:session.sessionId,p_request_id:randomUUID(),p_payload:{scopeMaterial:scopeContext.scopeMaterial},p_billing:mismatched})).rejects.toThrow('INPUT_BINDING_DENIED');
 expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100);

 await expect(admission.saveMaterial({...materialInput,brief:'conflicting replay'})).rejects.toThrow();
 await expect(admission.saveMaterial({...materialInput,requestId:randomUUID(),brief:'stale write'})).rejects.toThrow();
 const input={sessionId:session.sessionId,requestId:randomUUID(),input:'Work item only',selection:{kind:'ordinary',modelId}};
 const e=await admission.prepare(input);expect(await admission.prepare(input)).toEqual(e);
 await admission.saveMaterial({...materialInput,requestId:randomUUID(),expectedRevision:1,brief:'Later edited brief v2'});
 await expect(admission.prepare({...input,sessionId:draft.sessionId})).rejects.toThrow();
 let requests=0;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests++;
  expect(JSON.parse(JSON.parse(raw).input).messages.some((m:{content:unknown})=>JSON.stringify(m.content).includes('Work item only'))).toBe(true);
  expect(raw).toContain('Frozen work brief v1');expect(raw).not.toContain('Later edited brief v2');
  const id='work-http-'+e.executionId;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:{id,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:{role:'assistant',content:'Saved work item answer'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
  const executor=runtimeExecutor({database:admin,actor:async()=>{const auth=await user.auth.getUser();if(auth.error||!auth.data.user)throw new Error('AUTH');return auth.data.user.id;},endpoint:'http://127.0.0.1:'+address.port});
  expect(await executor.execute(e.executionId)).toEqual({state:'completed',body:'Saved work item answer'});
  await user.auth.signOut();await user.auth.signInWithPassword({email,password});
  expect(await executor.execute(e.executionId)).toEqual({state:'completed',body:'Saved work item answer'});expect(requests).toBe(1);
  const binding=(await db.query('select session_ref,request_id,payload from bill2_runs where id=$1',[e.runId])).rows[0];
  expect(binding.session_ref).toBe(session.sessionId);expect(binding.request_id).toBe(input.requestId);expect(binding.payload.scope).toEqual(scope);
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[session.sessionId])).rows[0].n).toBe(2);
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[draft.sessionId])).rows[0].n).toBe(0);
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:97,ledger:97});
  const foreign=await fixture();await expect(rpc('runtime_view',{p_actor_id:foreign.actorId,p_session_id:session.sessionId})).rejects.toThrow();
  await expect(rpc('runtime_material',{p_actor_id:foreign.actorId,p_session_id:session.sessionId,p_action:'revoke',p_expected_revision:1})).rejects.toThrow();
  await admission.revokeMaterial(session.sessionId,1);await admission.revokeMaterial(session.sessionId,1);
  expect((await db.query('select runtime_history_available($1) allowed',[e.executionId])).rows[0].allowed).toBe(false);
  expect(JSON.stringify(await rpc('runtime_view',{p_actor_id:actor,p_session_id:session.sessionId}))).not.toContain('Saved work item answer');
  expect((await db.query('select count(*)::int n from runtime_scope_material where session_id=$1',[session.sessionId])).rows[0].n).toBe(2);

  // Removing the parent relationship revokes content without erasing evidence.
  await db.query('update artifact_projects set source_project_id=NULL where id=$1',[work]);
  await expect(admission.prepare({...input,requestId:randomUUID()})).rejects.toThrow();
  await expect(executor.execute(e.executionId)).rejects.toThrow();expect(requests).toBe(1);
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[session.sessionId])).rows[0].n).toBe(2);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
it('RUNTIME: material revoke and actual dispatch serialize on the original version row',async()=>{
 const f=await fixture();
 await rpc('runtime_material',{p_actor_id:f.actorId,p_session_id:f.s.sessionId,p_action:'save',p_request_id:randomUUID(),p_expected_revision:0,p_payload:{brief:'private brief',material:'scope data',roundId:null}});
 const material=(await rpc('runtime_session_context',{p_actor_id:f.actorId,p_session_id:f.s.sessionId})).scopeMaterial;
 const context={version:'runtime.v1',scopeMaterial:material};
 const e=await rpc('runtime_admit',{...f.admit,p_payload:context,p_billing:{...f.billing,input:context}});
 const call={...f.billing.callPolicy[0],phase:'ordinary',requestHash:'a'.repeat(64)};
 const c=await rpc('bill2_claim',{p_actor_id:f.actorId,p_run_id:e.runId,p_sequence:1,p_payload:call});
 const dispatch=new pg.Client({connectionString}),revoke=new pg.Client({connectionString});await dispatch.connect();await revoke.connect();
 try{
  await dispatch.query('BEGIN');
  expect((await dispatch.query('select bill2_dispatch($1,$2,$3,$4) r',[f.actorId,e.runId,c.id,c.dispatchToken])).rows[0].r.dispatch).toBe(true);
  const pid=(await revoke.query('select pg_backend_pid() pid')).rows[0].pid;
  const revoked=revoke.query("select runtime_material($1,$2,'revoke',NULL,1) r",[f.actorId,f.s.sessionId]);
  let waiting=false;
  for(let n=0;n<100;n++){const row=(await db.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0];if(row?.wait_event_type==='Lock'){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(waiting).toBe(true);await dispatch.query('COMMIT');expect((await revoked).rows[0].r.revoked).toBe(true);
  await expect(rpc('bill2_dispatch',{p_actor_id:f.actorId,p_run_id:e.runId,p_call_id:c.id,p_token:c.dispatchToken})).rejects.toThrow('MATERIAL_UNAVAILABLE');
  expect((await db.query('select state,provider_id from bill2_calls where id=$1',[c.id])).rows[0]).toEqual({state:'dispatched',provider_id:null});
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits:80,ledger:80});
 }finally{await dispatch.query('ROLLBACK');await dispatch.end();await revoke.end();}
});
it('RUNTIME: real multiple-backend admission competition keeps one reservation and exact ledger balance',async()=>{
 const f=await fixture(),clients=Array.from({length:3},()=>new pg.Client({connectionString}));
 await Promise.all(clients.map(c=>c.connect()));
 try{
  const pids=await Promise.all(clients.map(async c=>(await c.query('select pg_backend_pid() p')).rows[0].p));expect(new Set(pids).size).toBe(3);
  const results=await Promise.all(clients.map(c=>c.query('select runtime_admit($1,$2,$3,$4,$5) r',[f.actorId,f.s.sessionId,f.admit.p_request_id,f.admit.p_payload,f.billing])));
  expect(new Set(results.map(r=>r.rows[0].r.executionId)).size).toBe(1);
  const money=(await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger,(select count(*)::int from bill2_runs where actor_id=$1) runs from profiles where id=$1',[f.actorId])).rows[0];
  expect(money).toEqual({credits:80,ledger:80,runs:1});
 }finally{await Promise.all(clients.map(c=>c.end()));}
});

it('RUNTIME: browser ordinary and document Skill survive refresh, actual process restart and fresh login',async()=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id;await db.query("insert into profiles(id,email,credits,nickname) values($1,$2,100,'Runtime tester')",[actor,email]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,'opening:'+actor]);
 const pack=makePackage(),moduleId=randomUUID();
 // A distinct public name makes the retained local sample identifiable to Owner.
 const {packageHash}=await import('../skills/loader');
 const entry=Buffer.from(pack.files[0].base64,'base64').toString().replace('name: synthetic-method','name: runtime-demo');
 pack.files[0].base64=Buffer.from(entry).toString('base64');pack.descriptor.directoryName='runtime-demo';
 pack.descriptor.files[0].bytes=Buffer.byteLength(entry);pack.descriptor.files[0].sha256=createHash('sha256').update(entry).digest('hex');
 pack.descriptor.packageHash=packageHash(pack.descriptor);
 await db.query("update profiles set role='admin' where id=$1",[actor]);
 await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'browser-doc-'+pack.id,actor]);
 await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Browser document Skill',$2,true,$3)",[moduleId,pack.id,modelId]);
 await publishSkillPackage(admin,actor,pack);
 // A second same-named package requires a task. Public names alone must not
 // make it runnable in this task-less preview selector.
 const taskPack=makePackage(),taskModule=randomUUID();
 const taskEntry=Buffer.from(taskPack.files[0].base64,'base64').toString().replace('name: synthetic-method','name: runtime-demo');
 taskPack.files[0].base64=Buffer.from(taskEntry).toString('base64');taskPack.descriptor.directoryName='runtime-demo';
 taskPack.descriptor.files[0].bytes=Buffer.byteLength(taskEntry);taskPack.descriptor.files[0].sha256=createHash('sha256').update(taskEntry).digest('hex');
 taskPack.descriptor.tasks={required:['SKILL.md']};taskPack.descriptor.packageHash=packageHash(taskPack.descriptor);
 await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[taskPack.id,'task-demo-'+taskPack.id,actor]);
 await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Requires task',$2,true,$3)",[taskModule,taskPack.id,modelId]);
 await publishSkillPackage(admin,actor,taskPack);
 await db.query("update profiles set role='user' where id=$1",[actor]);
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext();
 await context.route('**/*',route=>{const url=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(url.hostname)||['data:','blob:'].includes(url.protocol)?route.continue():route.abort();});
 const page=await context.newPage(),app=process.env.V3_LOCAL_APP!;
 try{
  // Disposable Next startup compiles both login and its first RPC route. This
  // is a bounded readiness observation, not another login or model request.
  const hydrated=page.waitForResponse(r=>r.url().includes('/api/trpc/settings.getSystemSettings')&&r.ok(),{timeout:60000});
  await page.goto(app+'/login?redirect=/runtime');await hydrated;
  await page.getByPlaceholder('name@example.com').fill(email);await page.getByPlaceholder('输入你的密码').fill(password);
  const choicesResponse=page.waitForResponse(r=>r.url().includes('/api/trpc/runtime.choices'));
  await page.getByRole('button',{name:'登录',exact:true}).last().click();await page.waitForURL(u=>u.pathname==='/runtime');
  expect((await choicesResponse).status()).toBe(200);
  await page.getByRole('button',{name:'新建定位草稿'}).click();await page.getByText('已保存独立工作记录，刷新后可继续。').waitFor();
  const url=page.url();expect(await page.getByLabel('对话方式').inputValue()).toBe(modelId);expect(await page.getByLabel('对话方式').locator('option').allTextContents()).toEqual(['普通对话','Skill 演示']);await page.getByLabel('消息',{exact:true}).fill('A persisted ordinary response');
  await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('Saved runtime answer 1',{exact:true}).waitFor({timeout:60000});
  const getCount=async()=>{const r=await fetch(process.env.V3_LOCAL_REST!+'/__runtime_count',{headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});return (await r.json()).calls;};
  expect(await getCount()).toBe(1);await page.reload();await page.getByText('Saved runtime answer 1',{exact:true}).waitFor();
  await page.getByLabel('对话方式').selectOption('skill:'+moduleId);
  await page.getByLabel('消息',{exact:true}).fill('Use the published document method');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('Saved runtime answer 2',{exact:true}).waitFor({timeout:60000});
  expect(await getCount()).toBe(2);
  expect(await page.locator('body').innerText()).not.toContain('METHOD_CANARY');
  // Close the old development page so its HMR reload cannot race recovery navigation.
  await page.close();
  const restarted=await fetch(process.env.V3_LOCAL_REST!+'/__restart_app',{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});expect(restarted.ok).toBe(true);
  await expect.poll(async()=>{try{return (await fetch(app+'/runtime')).status;}catch{return 0;}},{timeout:30000}).toBe(200);
  const restored=await context.newPage();await restored.goto(url);await restored.getByText('Saved runtime answer 1',{exact:true}).waitFor({timeout:60000});expect(await getCount()).toBe(2);
  await restored.getByText('Saved runtime answer 2',{exact:true}).waitFor();
  await context.close();
  const fresh=await browser.newContext();
  try{
   await fresh.route('**/*',route=>{const u=new URL(route.request().url());return ['127.0.0.1','localhost'].includes(u.hostname)||['data:','blob:'].includes(u.protocol)?route.continue():route.abort();});
   const relogin=await fresh.newPage();
   await relogin.goto(app+'/login?redirect='+encodeURIComponent(new URL(url).pathname+new URL(url).search));
   await relogin.getByPlaceholder('name@example.com').fill(email);await relogin.getByPlaceholder('输入你的密码').fill(password);
   await relogin.getByRole('button',{name:'登录',exact:true}).last().click();
   await relogin.getByText('Saved runtime answer 1',{exact:true}).waitFor({timeout:60000});
   await relogin.getByText('Saved runtime answer 2',{exact:true}).waitFor();expect(await getCount()).toBe(2);
   expect(await relogin.locator('body').innerText()).not.toContain('METHOD_CANARY');
  }finally{await fresh.close();}
  const money=(await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0];
  expect(money).toEqual({credits:94,ledger:94});
  const sessionId=new URL(url).searchParams.get('session');
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[sessionId])).rows[0].n).toBe(4);
  expect((await db.query('select count(*)::int n from runtime_executions where session_id=$1',[sessionId])).rows[0].n).toBe(2);
  const {writeFile}=await import('node:fs/promises');
  await writeFile(process.env.V3_WORKBENCH_OUTPUT!+'/runtime-acceptance.json',JSON.stringify({url,credentials:{email,password},actor,sessionId,modelId,moduleId,skillName:'runtime-demo',mode:'Disposable local Auth/PostgreSQL with synthetic loopback model; no real supplier or payment'},null,2),{mode:0o600});
 }finally{await context.close();await browser.close();}
},180000);

it.each(['none','profile','draft','cancel'])('RUNTIME: pending cost with %s revocation recovers finances without private content or POST replay',async revocation=>{
 const f=await fixture();
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'hello',instructions:'Fixture instruction',model:'runtime-m',maxOutputTokens:100,maxTurns:1,historyItems:20};
 const e=await rpc('runtime_admit',{...f.admit,p_payload:context,p_billing:{...f.billing,input:context}});let posts=0,lookups=0,finalCostAvailable=false;
 const providerId='pending-cost-'+e.executionId;
 const response={id:providerId,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:{role:'assistant',content:'Saved before cost'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}};
 const server=createServer(async(req,res)=>{
  for await(const _ of req){/* bounded local fixture */}
  const lookup=req.method==='GET';if(lookup){expect(req.url).toBe('/receipt/'+providerId);lookups++;}else posts++;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:providerId,model:'runtime-m',final:lookup&&finalCostAvailable,cost:lookup&&finalCostAvailable?'0.003':null,currency:'USD',coverage:'request_total',usage:{sdkResponse:response}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
  const options={database:admin,actor:async()=>f.actorId,endpoint:'http://127.0.0.1:'+address.port};
  const first=await runtimeExecutor(options).execute(e.executionId);
  expect(first).toEqual({body:'Saved before cost',state:'cost_pending'});
  expect(posts).toBe(1);expect(lookups).toBe(0);
  expect((await db.query('select credits from profiles where id=$1',[f.actorId])).rows[0].credits).toBe(80);
  if(revocation==='profile')await db.query("update profiles set status='disabled' where id=$1",[f.actorId]);
  if(revocation==='draft')await rpc('bill2_revoke_draft',{p_actor_id:f.actorId,p_draft_id:f.s.scope.draftId});
  if(revocation==='cancel'){
   expect((await runtimeExecutor(options).cancel(e.executionId)).state).toBe('cost_pending');
   expect((await db.query('select outcome from bill2_runs where id=$1',[e.runId])).rows[0].outcome).toBe('delivered');
  }
  if(revocation==='profile'||revocation==='draft'){
   await expect(runtimeExecutor(options).execute(e.executionId)).rejects.toThrow('UNAVAILABLE');
   await expect(new PostgresSession(admin,{actorId:f.actorId,sessionId:f.s.sessionId,executionId:e.executionId}).getItems()).rejects.toThrow('UNAVAILABLE');
   await expect(rpc('runtime_financial_recovery',{p_actor_id:randomUUID(),p_execution_id:e.executionId})).rejects.toThrow('DENIED');
  }
  const recover=async()=>{
   if(revocation==='none'||revocation==='cancel')return {state:(await runtimeExecutor(options).execute(e.executionId)).state};
   const financial=await runtimeExecutor(options).recoverFinancial(e.executionId);
   expect(Object.keys(financial).sort()).toEqual(['billing','executionId','runId','state']);
   expect(JSON.stringify(financial)).not.toContain('Saved before cost');expect(JSON.stringify(financial)).not.toContain('Fixture instruction');
   return {state:financial.state};
  };
  const original=(await db.query('select b.id,b.pre_deduct_id,c.id call_id,c.provider_id from bill2_runs b join bill2_calls c on c.run_id=b.id where b.id=$1',[e.runId])).rows;
  const unresolved=await recover();
  expect(unresolved).toEqual({state:'cost_pending'});
  expect(posts).toBe(1);expect(lookups).toBe(1);
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits:80,ledger:80});
  expect((await db.query('select active_execution from runtime_sessions where id=$1',[f.s.sessionId])).rows[0].active_execution).toBe(e.executionId);
  finalCostAvailable=true;
  const competing=await Promise.all([recover(),recover()]);
  expect(competing.some(r=>r.state==='completed')).toBe(true);
  expect(await recover()).toEqual({state:'completed'});
  if(revocation==='cancel')expect(await runtimeExecutor(options).execute(e.executionId)).toEqual({state:'completed',body:'Saved before cost'});
  expect(posts).toBe(1);expect(lookups).toBeGreaterThanOrEqual(2);expect(lookups).toBeLessThanOrEqual(3);
  expect((await db.query('select b.id,b.pre_deduct_id,c.id call_id,c.provider_id from bill2_runs b join bill2_calls c on c.run_id=b.id where b.id=$1',[e.runId])).rows).toEqual(original);
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits:97,ledger:97});
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[f.s.sessionId])).rows[0].n).toBe(2);
  expect((await db.query("select count(*)::int n from billing_history where user_id=$1 and operation_type='settle'",[f.actorId])).rows[0].n).toBe(1);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it('RUNTIME: lost dispatch commit response preserves unknown identity without network resend or refund',async()=>{
 const f=await fixture();
 const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'original unknown input',instructions:'Fixture instruction',model:'runtime-m',maxOutputTokens:100,maxTurns:1,historyItems:20};
 const e=await rpc('runtime_admit',{...f.admit,p_payload:context,p_billing:{...f.billing,input:context}});let requests=0,injected=false;
 const server=createServer(async(req,res)=>{for await(const _ of req){/* local only */}requests++;res.writeHead(500);res.end();});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
  const database={rpc:(name:string,args:Record<string,unknown>)=>{
   if(name==='bill2_dispatch'&&!injected){injected=true;return (async()=>{const committed=await admin.rpc(name,args);if(committed.error)throw committed.error;return {data:null,error:{message:'synthetic lost dispatch commit response'}};})();}
   return admin.rpc(name,args);
  }};
  const options={database,actor:async()=>f.actorId,endpoint:'http://127.0.0.1:'+address.port};
  expect(await runtimeExecutor(options).execute(e.executionId)).toEqual({state:'pending'});expect(injected).toBe(true);
  const snapshot=async()=>(await db.query('select b.id,b.pre_deduct_id,b.state,b.payload,c.id call_id,c.provider_id,c.dispatched_at,e.result,e.payload execution_input from bill2_runs b join bill2_calls c on c.run_id=b.id join runtime_executions e on e.billing_run_id=b.id where b.id=$1',[e.runId])).rows;
  const original=await snapshot();expect(original[0].dispatched_at).not.toBeNull();expect(original[0].provider_id).toBeNull();
  await Promise.all([runtimeExecutor(options).execute(e.executionId),runtimeExecutor(options).execute(e.executionId)]);
  expect(await snapshot()).toEqual(original);expect(requests).toBe(0);
  expect(original[0].execution_input.input).toBe('original unknown input');
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[f.actorId])).rows[0]).toEqual({credits:80,ledger:80});
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[f.s.sessionId])).rows[0].n).toBe(0);
  expect((await db.query("select count(*)::int n from billing_history where user_id=$1 and operation_type in ('settle','refund')",[f.actorId])).rows[0].n).toBe(0);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it('RUNTIME: real published source revocation excludes derived Session history without deleting originals',async()=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id;await db.query("insert into profiles(id,email,credits,role) values($1,$2,500,'admin')",[actor,email]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const login=await user.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 async function workflow(social:boolean){
  const pack=makePackage(),moduleId=randomUUID(),registration='runtime-source-'+randomUUID(),flow=makeWorkflow(social?6:1,social);
  await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,registration,actor]);
  await db.query('insert into modules(id,title,skill_id,active) values($1,$2,$3,true)',[moduleId,registration,pack.id]);
  await publishSkillPackage(admin,actor,pack);
  await db.query('insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,$6,true)',[registration,moduleId,pack.id,pack.revisionId,flow,registration]);
  if(social)await db.query('insert into artifact_accounts values($1,$2,$3,$4)',[actor,moduleId,pack.id,'synthetic:local-account']);
  return {registration};
 }
 const source=await workflow(true),target=await workflow(false),service=workbenchService(user,admin),reuse=artifactReuse(user,admin);
 const projectId=randomUUID(),roundId=randomUUID(),canary='REVOKED_SOURCE_'+randomUUID();
 await service.start({projectId,roundId,requestId:randomUUID(),registration:source.registration,account:'synthetic:local-account'});
 await service.execute({action:'userEvidence',projectId,roundId,requestId:randomUUID(),body:canary,observedAt:null,supersedes:null});
 let snapshot=await service.read(projectId,roundId);const evidenceId=snapshot.evidence[0].id;
 for(const step of snapshot.workflow.steps){
  await service.execute({action:'save',projectId,roundId,requestId:randomUUID(),stepId:step.id,body:canary+' '+step.title,evidenceIds:[evidenceId],expectedVersion:snapshot.steps[step.id].version});
  snapshot=await service.read(projectId,roundId);
  await service.execute({action:'confirm',projectId,roundId,requestId:randomUUID(),stepId:step.id,expectedVersion:snapshot.steps[step.id].version,expectedReviewVersion:snapshot.steps[step.id].reviewVersion});
  snapshot=await service.read(projectId,roundId);
 }
 await service.execute({action:'publish',projectId,roundId,requestId:randomUUID(),expectedSteps:Object.fromEntries(Object.entries(snapshot.steps).map(([k,v])=>[k,{version:v.version,reviewVersion:v.reviewVersion}]))});
 const report=await service.report(projectId,roundId),configId='runtime-ref-'+randomUUID(),work=randomUUID();
 await db.query('insert into artifact_reference_configs values($1,$2,$3,$4,$5,true)',[configId,source.registration,target.registration,JSON.stringify(['step-2']),20000]);
 await reuse.create({projectId:work,roundId:work,requestId:work,sourceVersionId:report.id!,configId,title:'Runtime source reference'});
 const linked=await reuse.source({projectId:work,roundId:work});expect(linked).not.toBeNull();
 const selected={projectId:work,roundId:work,sourceVersionId:linked!.sourceVersionId,hash:linked!.hash};
 expect(JSON.stringify(await rpc('runtime_source',{p_actor_id:actor,p_source:selected}))).toContain(canary);
 await expect(rpc('runtime_source',{p_actor_id:actor,p_source:{...selected,hash:'0'.repeat(64)}})).rejects.toThrow('STALE');
 const admission=runtimeAdmissionService(user,admin,{account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,maxOutputTokens:200,inputBytes:20000,historyItems:30});
 const session=await admission.start(randomUUID(),{kind:'positioning_draft'}),requests:unknown[]=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(JSON.parse(raw).input);requests.push(input);
  const id='source-'+randomUUID(),body=requests.length<4?canary+' derived '+requests.length:'Fresh context';
  const message=requests.length===1?{role:'assistant',content:null,tool_calls:[{id:'source-tool-'+id,type:'function',function:{name:'read_source',arguments:'{}'}}]}:{role:'assistant',content:body};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:{id,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message,finish_reason:requests.length===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
  const executor=runtimeExecutor({database:admin,actor:async()=>actor,endpoint:'http://127.0.0.1:'+address.port});
  const ids:string[]=[];
  for(let i=0;i<2;i++){
   const admitted=await admission.prepare({sessionId:session.sessionId,requestId:randomUUID(),input:'Use the permitted context',selection:{kind:'ordinary',modelId},sources:i===0?[selected]:[]});ids.push(admitted.executionId);
   expect((await executor.execute(admitted.executionId)).state).toBe('completed');
  }
  expect(JSON.stringify(requests[1])).toContain(canary);
  expect(JSON.stringify(requests[2])).toContain(canary);
  const tool=(await db.query("select result from runtime_tool_calls where execution_id=$1 and name='read_source'",[ids[0]])).rows;expect(tool).toHaveLength(1);expect(JSON.stringify(tool)).toContain(canary);
  // The work's explicitly bound round supplies default scope material through
  // the same authenticated admission and SDK, without a second source tool.
  const workSession=await admission.start(randomUUID(),{kind:'work_item',projectId,workItemId:work});
  const materialInput={sessionId:workSession.sessionId,requestId:randomUUID(),expectedRevision:0,brief:'Current work brief',material:'User work notes',roundId:work};
  await expect(admission.saveMaterial({...materialInput,roundId:roundId})).rejects.toThrow();
  await expect(admission.saveMaterial({...materialInput,sessionId:session.sessionId})).rejects.toThrow();
  const material=await admission.saveMaterial(materialInput);expect(material.revision).toBe(1);
  const workRun=await admission.prepare({sessionId:workSession.sessionId,requestId:randomUUID(),input:'Use current work material',selection:{kind:'ordinary',modelId}});
  const beforeEdit=await service.read(work,work),stepId=Object.keys(beforeEdit.steps)[0],edited='Later work edit '+randomUUID();
  await service.execute({action:'save',projectId:work,roundId:work,requestId:randomUUID(),stepId,body:edited,evidenceIds:beforeEdit.steps[stepId].evidenceIds,expectedVersion:beforeEdit.steps[stepId].version});
  await admission.saveMaterial({...materialInput,requestId:randomUUID(),expectedRevision:1});

  expect((await executor.execute(workRun.executionId)).state).toBe('completed');expect(requests).toHaveLength(4);
  expect(JSON.stringify(requests[3])).toContain(canary);expect(JSON.stringify(requests[3])).toContain('Current work brief');
  expect(JSON.stringify(requests[3])).not.toContain(edited);
  expect((await db.query('select session_ref from bill2_runs where id=$1',[workRun.runId])).rows[0].session_ref).toBe(workSession.sessionId);
  const editedRun=await admission.prepare({sessionId:workSession.sessionId,requestId:randomUUID(),input:'Use edited work material',selection:{kind:'ordinary',modelId}});
  expect((await executor.execute(editedRun.executionId)).state).toBe('completed');expect(requests).toHaveLength(5);expect(JSON.stringify(requests[4])).toContain(edited);
  expect((await executor.execute(workRun.executionId)).state).toBe('completed');expect(requests).toHaveLength(5);
  const raced=await admission.prepare({sessionId:session.sessionId,requestId:randomUUID(),input:'Use my existing history',selection:{kind:'ordinary',modelId},sources:[]});
  let reached!:()=>void,release!:()=>void,readPrivateHistory=false;
  const ready=new Promise<void>(resolve=>{reached=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const guarded={rpc:async(name:string,args:Record<string,unknown>)=>{
   if(name==='bill2_dispatch'){reached();await hold;}
   const result=await admin.rpc(name,args);
   if(name==='runtime_session_items'&&args.p_action==='read'&&JSON.stringify(result.data).includes(canary))readPrivateHistory=true;
   return result;
  }};
  const racing=runtimeExecutor({database:guarded,actor:async()=>actor,endpoint:'http://127.0.0.1:'+address.port}).execute(raced.executionId);
  await ready;expect(readPrivateHistory).toBe(true);
  await db.query('update artifact_reference_configs set enabled=false where id=$1',[configId]);
  release();expect((await racing).state).toBe('pending');expect(requests).toHaveLength(5);
  expect((await db.query('select state,provider_id from bill2_calls where run_id=$1',[raced.runId])).rows).toEqual([{state:'prepared',provider_id:null}]);
  expect((await executor.recoverFinancial(raced.executionId)).state).toBe('cancelled');expect(requests).toHaveLength(5);
  expect((await db.query('select count(*)::int n from runtime_session_history where execution_id=$1',[raced.executionId])).rows[0].n).toBe(0);
  for(const run of [workRun,editedRun])expect((await db.query('select runtime_history_available($1) allowed',[run.executionId])).rows[0].allowed).toBe(false);
  await expect(executor.execute(workRun.executionId)).rejects.toThrow();expect(requests).toHaveLength(5);

  await expect(rpc('runtime_source',{p_actor_id:actor,p_source:selected})).rejects.toThrow();
  for(const id of ids)expect((await db.query('select runtime_history_available($1) allowed',[id])).rows[0].allowed).toBe(false);
  const next=await admission.prepare({sessionId:session.sessionId,requestId:randomUUID(),input:'A new independent question',selection:{kind:'ordinary',modelId},sources:[]});
  // Admission froze no dependency on the disabled source. Re-enabling it
  // before SDK history read must not expand that original snapshot.
  await db.query('update artifact_reference_configs set enabled=true where id=$1',[configId]);
  expect((await executor.execute(next.executionId)).state).toBe('completed');expect(requests).toHaveLength(6);expect(JSON.stringify(requests[5])).not.toContain(canary);
  await db.query('update artifact_reference_configs set enabled=false where id=$1',[configId]);
  expect((await db.query('select runtime_history_available($1) allowed',[next.executionId])).rows[0].allowed).toBe(true);
  const view=await rpc('runtime_view',{p_actor_id:actor,p_session_id:session.sessionId});expect(JSON.stringify(view)).not.toContain(canary);
  const originals=(await db.query('select item from runtime_session_history where session_id=$1',[session.sessionId])).rows;
  expect(originals).toHaveLength(8);expect(JSON.stringify(originals)).toContain(canary);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
},120000);

it.each([{searchEnabled:false,stopAfterPrimary:false},{searchEnabled:true,stopAfterPrimary:false},{searchEnabled:false,stopAfterPrimary:true}])('RUNTIME: attached organizer search=$searchEnabled stopAfterPrimary=$stopAfterPrimary preserves original run',async({searchEnabled,stopAfterPrimary})=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id;await db.query('insert into profiles(id,email,credits) values($1,$2,100)',[actor,email]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,'opening:'+actor]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const login=await user.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 const summaryModel=randomUUID();await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Attached organizer','attached-summary','fixture','true')",[summaryModel]);
 await db.query("insert into system_settings(key,value) values('v3_summary_model_id',to_jsonb($1::text)) on conflict(key) do update set value=excluded.value",[summaryModel]);
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:searchEnabled?4:2,searchEnabled,maxOutputTokens:200,inputBytes:10000,historyItems:20};
 const admission=runtimeAdmissionService(user,admin,policy),session=await admission.start(randomUUID(),{kind:'positioning_draft'});
 const summaryCapacity=(await db.query('select input_limit from ai_models where id=$1',[summaryModel])).rows[0].input_limit;
 await db.query('update ai_models set input_limit=200 where id=$1',[summaryModel]);
 await expect(admission.prepare({sessionId:session.sessionId,requestId:randomUUID(),input:'Answer and organize',selection:{kind:'ordinary',modelId},organizeAfter:true})).rejects.toThrow('RUNTIME_MODEL_CAPACITY');
 expect((await db.query('select count(*)::int n from bill2_runs where actor_id=$1',[actor])).rows[0].n).toBe(0);
 expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100);
 await db.query('update ai_models set input_limit=$2 where id=$1',[summaryModel,summaryCapacity]);
 // Required search needs two model calls, one paid tool call and one organizer.
 const insufficient=runtimeAdmissionService(user,admin,{...policy,maxCalls:3,searchEnabled:true});
 await expect(insufficient.prepare({sessionId:session.sessionId,requestId:randomUUID(),input:'Latest answer and organize',selection:{kind:'ordinary',modelId},organizeAfter:true,network:'require_latest'})).rejects.toThrow('RUNTIME_CALL_BUDGET');
 expect((await db.query('select count(*)::int n from bill2_runs where actor_id=$1',[actor])).rows[0].n).toBe(0);
 expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(100);
 const e=await admission.prepare({sessionId:session.sessionId,requestId:randomUUID(),input:'Answer and organize',selection:{kind:'ordinary',modelId},organizeAfter:true});
 const requests:Array<{model?:string;messages:unknown[];tool?:string}>=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(JSON.parse(raw).input);requests.push(input);
  const id='attached-'+randomUUID(),body=input.model==='runtime-m'?'Primary result':'Organized primary result';
  const firstSearch=searchEnabled&&requests.length===1;
  const message=firstSearch?{role:'assistant',content:null,tool_calls:[{id:'attached-search-'+id,type:'function',function:{name:'search',arguments:'{"query":"latest"}'}}]}:{role:'assistant',content:body};
  const usage=input.tool?{toolResult:{body:'Isolated latest source',sources:[{id:'attached-source',version:'v1',status:'available'}]}}:{sdkResponse:{id,object:'chat.completion',created:1,model:input.model,choices:[{index:0,message,finish_reason:firstSearch?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:input.model??'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');let injected=false;
  const errors:Array<{name:string;message:string}>=[];
  const database={rpc:async(name:string,args:Record<string,unknown>)=>{
   if(!injected&&name==='runtime_execution'&&args.p_action===(stopAfterPrimary?'checkpoint_primary':'complete')){
    injected=true;
    if(stopAfterPrimary){const committed=await admin.rpc(name,args);if(committed.error)return committed;}
    return {data:null,error:{message:'synthetic lost checkpoint/result write'}};
   }
   const r=await admin.rpc(name,args);if(r.error)errors.push({name,message:r.error.message});return r;
  }};
  const options={database,actor:async()=>actor,endpoint:'http://127.0.0.1:'+address.port};
  expect(await runtimeExecutor(options).execute(e.executionId)).toEqual({state:'pending'});
  if(stopAfterPrimary){
   expect(injected).toBe(true);expect(requests.map(r=>r.model)).toEqual(['runtime-m']);
   expect(await runtimeExecutor(options).execute(e.executionId)).toEqual({state:'pending'});
   const stage=(await db.query('select primary_result,result from runtime_executions where id=$1',[e.executionId])).rows[0];
   expect(stage).toEqual({primary_result:{body:'Primary result',lastSequence:1},result:null});
   expect((await runtimeExecutor(options).cancel(e.executionId)).state).toBe('cancelled');
   expect((await runtimeExecutor(options).cancel(e.executionId)).state).toBe('cancelled');
   await expect(rpc('runtime_execution',{p_actor_id:actor,p_execution_id:e.executionId,p_action:'complete',p_result:{kind:'usable_result',body:'Primary result',summary:'Late summary'}})).rejects.toThrow();
   await expect(rpc('runtime_session_items',{p_actor_id:actor,p_session_id:session.sessionId,p_execution_id:e.executionId,p_action:'append',p_batch:1,p_items:[{role:'assistant',content:'Late summary'}]})).rejects.toThrow();
   const view=await rpc('runtime_view',{p_actor_id:actor,p_session_id:session.sessionId});
   expect(view.executions[0].primaryBody).toBe('Primary result');expect(view.executions[0].body).toBeNull();expect(view.executions[0].summary).toBeNull();
   expect(view.activeExecution).toBeNull();expect(requests).toHaveLength(1);
   expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[session.sessionId])).rows[0].n).toBe(2);
   expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:97,ledger:97});
   const next=await admission.prepare({sessionId:session.sessionId,requestId:randomUUID(),input:'Next work',selection:{kind:'ordinary',modelId}});
   await runtimeExecutor(options).cancel(e.executionId);
   expect((await rpc('runtime_view',{p_actor_id:actor,p_session_id:session.sessionId})).activeExecution).toBe(next.executionId);
   return;
  }
  expect({injected,requests:requests.map(r=>r.model??r.tool)}).toEqual({injected:true,requests:searchEnabled?['runtime-m','search','runtime-m','attached-summary']:['runtime-m','attached-summary']});
  const recovered=await runtimeExecutor(options).execute(e.executionId);
  expect({recovered,errors}).toEqual({recovered:{state:'completed',body:'Primary result',summary:'Organized primary result'},errors:[]});
  expect(requests.map(r=>r.model??r.tool)).toEqual(searchEnabled?['runtime-m','search','runtime-m','attached-summary']:['runtime-m','attached-summary']);expect(JSON.stringify(requests.at(-1)!.messages)).toContain('Primary result');
  const result=(await db.query('select result from runtime_executions where id=$1',[e.executionId])).rows[0].result;
  expect(result.summary).toBe('Organized primary result');
  const {createServerClient}=createRequire(new URL('../../../../../apps/web/package.json',import.meta.url))('@supabase/ssr');
  const cookies=new Map<string,string>();
  const browserClient=createServerClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:(items:Array<{name:string;value:string}>)=>items.forEach(c=>cookies.set(c.name,c.value))}});
  async function viewHttp(){const response=await fetch(process.env.V3_LOCAL_APP!+'/api/trpc/runtime.view?input='+encodeURIComponent(JSON.stringify({sessionId:session.sessionId})),{headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}});expect(response.status).toBe(200);return (await response.json()).result.data;}
  expect((await browserClient.auth.signInWithPassword({email,password})).error).toBeNull();
  const visible=await viewHttp();expect(visible.executions[0]).toMatchObject({body:'Primary result',summary:'Organized primary result',organizerComplete:true});
  expect(await viewHttp()).toEqual(visible); // refresh uses the persisted, authorized projection.
  await browserClient.auth.signOut();cookies.clear();expect((await browserClient.auth.signInWithPassword({email,password})).error).toBeNull();
  expect(await viewHttp()).toEqual(visible);
  expect(await runtimeExecutor(options).execute(e.executionId)).toEqual(recovered);
  await db.query("update ai_models set is_active='false' where id=$1",[summaryModel]);
  const hidden=await viewHttp();expect(hidden.executions[0]).toMatchObject({body:null,summary:null,contentAvailable:false});
  expect(JSON.stringify(hidden)).not.toContain('Organized primary result');
  await expect(runtimeExecutor(options).execute(e.executionId)).rejects.toThrow('UNAVAILABLE');
  expect((await db.query('select result from runtime_executions where id=$1',[e.executionId])).rows[0].result).toEqual(result);
  await db.query("update ai_models set is_active='true' where id=$1",[summaryModel]);
  expect(await viewHttp()).toEqual(visible);

  expect((await db.query('select count(*)::int n from bill2_runs where actor_id=$1',[actor])).rows[0].n).toBe(1);
  expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[e.runId])).rows[0].n).toBe(searchEnabled?4:2);
  expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[session.sessionId])).rows[0].n).toBe(searchEnabled?6:4);
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:searchEnabled?88:94,ledger:searchEnabled?88:94});
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it.each(['selected','none','checkpoint_loss','none_checkpoint','result_loss','invalid'])('RUNTIME: automatic public Skill matching %s shares one run and preserves control history',async mode=>{
 const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const actor=created.data.user.id;
 await db.query("insert into profiles(id,email,credits,role) values($1,$2,100,'admin')",[actor,email]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'adjustment','adjustment','opening','system',$2,0,100)",[actor,randomUUID()]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});expect((await user.auth.signInWithPassword({email,password})).error).toBeNull();
 const pack=makePackage(),moduleId=randomUUID(),skillModel=randomUUID();
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Auto Skill fixture',$2,'fixture','true')",[skillModel,'auto-'+skillModel]);
 await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'auto-'+pack.id,actor]);
 await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Automatic document Skill',$2,true,$3)",[moduleId,pack.id,skillModel]);
 await publishSkillPackage(admin,actor,pack);
 const admission=runtimeAdmissionService(user,admin,{account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,maxOutputTokens:200,inputBytes:30000,historyItems:30});
 const s=await admission.start(randomUUID(),{kind:'positioning_draft'});
 const oldCapacity=(await db.query('select input_limit from ai_models where id=$1',[modelId])).rows[0].input_limit;
 if(mode==='none_checkpoint'){
  await db.query('update ai_models set input_limit=10200 where id=$1',[modelId]);
  await db.query("update ai_models set model_id='runtime-m' where id=$1",[skillModel]);
 }
 const e=await admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'Use the appropriate method for this request',selection:{kind:'auto',modelId},network:'deny'});
 await db.query('update ai_models set input_limit=$2 where id=$1',[modelId,oldCapacity]);
 const payload=(await db.query('select payload from runtime_executions where id=$1',[e.executionId])).rows[0].payload;
 const chosen=payload.matching.candidates.find((c:any)=>c.moduleId===moduleId);expect(chosen).toBeTruthy();
 const requests:any[]=[];let injected=false;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(JSON.parse(raw).input);requests.push(input);
  const content=requests.length===1?JSON.stringify({key:mode.startsWith('none')?null:mode==='invalid'?'not-in-frozen-catalog':chosen.key}):'Auto matched answer';
  const id='auto-response-'+randomUUID();res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:input.model,final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:{id,object:'chat.completion',created:1,model:input.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const addr=server.address();if(!addr||typeof addr==='string')throw new Error('fixture');
  const database={rpc:async(name:string,args:Record<string,unknown>)=>{
   if(mode==='result_loss'&&!injected&&name==='runtime_execution'&&args.p_action==='complete'){injected=true;return {data:null,error:{message:'synthetic result write failure'}};}
   const r=await admin.rpc(name,args);if((mode==='checkpoint_loss'||mode==='none_checkpoint')&&!injected&&name==='runtime_execution'&&args.p_action==='checkpoint_match'&&!r.error){injected=true;return {data:null,error:{message:'synthetic checkpoint commit response loss'}};}return r;
  }};
  const executor=runtimeExecutor({database,actor:async()=>actor,endpoint:'http://127.0.0.1:'+addr.port,activateSkill:c=>activateRuntimeCandidate(user,admin,c)});
  let result=await executor.execute(e.executionId);
  if(mode==='result_loss'){expect(result.state).toBe('pending');expect(requests).toHaveLength(2);result=await executor.execute(e.executionId);}
  expect(JSON.stringify(requests[0])).not.toContain('METHOD_CANARY');expect(JSON.stringify(requests[0])).not.toContain(pack.revisionId);expect(JSON.stringify(requests[0])).not.toContain('packageHash');
  if(mode==='checkpoint_loss'||mode==='none_checkpoint'||mode==='invalid'){
   expect(result.state).toBe('pending');expect((await executor.execute(e.executionId)).state).toBe('pending');expect(requests).toHaveLength(1);
   if(mode==='none_checkpoint'){
    await db.query("update ai_models set is_active='false' where id=$1",[skillModel]);
    const frozen=(await db.query('select payload from bill2_runs where id=$1',[e.runId])).rows[0].payload;
    const unused=frozen.callPolicy.find((p:any)=>p.modelId===skillModel);expect(unused.inputLimit).toBeGreaterThan(frozen.callPolicy[0].inputLimit);
    const call={provider:unused.provider,account:unused.account,model:unused.model,protocol:unused.protocol,phase:'ordinary',requestHash:'a'.repeat(64),upperUsd:unused.upperUsd,inputLimit:unused.inputLimit,outputLimit:unused.outputLimit,automaticRetry:false,hiddenTools:false,lookupSupported:true};
    await expect(rpc('bill2_claim',{p_actor_id:actor,p_run_id:e.runId,p_sequence:2,p_payload:call})).rejects.toThrow('RUNTIME_MATCH_CALL_DENIED');
    await expect(rpc('bill2_prepare',{p_actor_id:actor,p_request_id:randomUUID(),p_payload:frozen})).rejects.toThrow('BILL2_CALL_POLICY_DENIED');
    expect((await db.query('select count(*)::int n from bill2_runs where actor_id=$1',[actor])).rows[0].n).toBe(1);
   }
   await executor.cancel(e.executionId);
   expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(97);
  }else{
   expect(result).toEqual({body:'Auto matched answer',state:'completed'});expect(requests).toHaveLength(2);
   expect(requests[1].model).toBe(mode==='none'?'runtime-m':'auto-'+skillModel);
   if(mode!=='none')expect(JSON.stringify(requests[1])).toContain('METHOD_CANARY');
   else expect(JSON.stringify(requests[1])).not.toContain('METHOD_CANARY');
   await executor.execute(e.executionId);expect(requests).toHaveLength(2);
   if(mode==='none'){
    await db.query("update ai_models set is_active='false' where id=$1",[skillModel]);
    const view=await rpc('runtime_view',{p_actor_id:actor,p_session_id:s.sessionId});
    expect(view.executions[0].contentAvailable).toBe(true);expect(view.executions[0].body).toBe('Auto matched answer');
    expect((await executor.execute(e.executionId)).state).toBe('completed');expect(requests).toHaveLength(2);
   }
   if(mode==='selected'){
    await db.query("update system_settings set value=to_jsonb($1::text) where key='v3_summary_model_id'",[skillModel]);
    await expect(admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'Organize',selection:{kind:'organizer'},network:'deny'})).rejects.toThrow('SUMMARY_MODEL_MUST_DIFFER');
    await db.query("update system_settings set value=to_jsonb($1::text) where key='v3_summary_model_id'",[modelId]);
    const organize=await admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'Organize',selection:{kind:'organizer'},network:'deny'});
    await executor.cancel(organize.executionId);
   }
   const next=await admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'Continue normally',selection:{kind:'ordinary',modelId},network:'deny'});
   const history=await new PostgresSession(admin,{actorId:actor,sessionId:s.sessionId,executionId:next.executionId}).getItems();
   expect(history).toHaveLength(2);expect(JSON.stringify(history)).not.toContain('candidate-');expect(JSON.stringify(history)).toContain('Auto matched answer');
   await executor.cancel(next.executionId);
   expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(94);
   if(mode==='selected'){
    await db.query('update modules set active=false where id=$1',[moduleId]);
    const view=await rpc('runtime_view',{p_actor_id:actor,p_session_id:s.sessionId});
    expect(view.executions.find((x:any)=>x.executionId===e.executionId).contentAvailable).toBe(false);
    expect(JSON.stringify(view)).not.toContain('Auto matched answer');
    const independent=await admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'After revocation',selection:{kind:'ordinary',modelId},network:'deny'});
    expect(await new PostgresSession(admin,{actorId:actor,sessionId:s.sessionId,executionId:independent.executionId}).getItems()).toEqual([]);
    await executor.cancel(independent.executionId);
    expect((await db.query('select count(*)::int n from runtime_session_history where execution_id=$1',[e.executionId])).rows[0].n).toBe(4);
   }
  }
  const rows=(await db.query('select internal_control,count(*)::int n from runtime_session_history where execution_id=$1 group by internal_control',[e.executionId])).rows;
  expect(rows.find(r=>r.internal_control)?.n).toBe(2);
  expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[e.runId])).rows[0].n).toBe(requests.length);
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:requests.length===2?94:97,ledger:requests.length===2?94:97});
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
},120000);

it('RUNTIME: actual HTTP disconnect keeps late output in original scope and killed process preserves unknown without resend',async()=>{
 const api=process.env.V3_LOCAL_REST!,app=process.env.V3_LOCAL_APP!,token=process.env.V3_LOCAL_CONTROL!;
 const {createRequire}=await import('node:module');
 const {createServerClient}=createRequire(new URL('../../../../../apps/web/package.json',import.meta.url))('@supabase/ssr');
 const cookies=new Map<string,string>();
 const client=createServerClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:(items:Array<{name:string;value:string}>)=>items.forEach(c=>cookies.set(c.name,c.value))}});
 const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const actor=created.data.user.id;
 await db.query('insert into profiles(id,email,credits) values($1,$2,100)',[actor,email]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'adjustment','adjustment','opening','system',$2,0,100)",[actor,randomUUID()]);
 expect((await client.auth.signInWithPassword({email,password})).error).toBeNull();
 async function control(path:string,method='POST'){const r=await fetch(api+path,{method,headers:{'x-local-control':token}});expect(r.status).toBe(200);return r;}
 async function count(){return (await (await control('/__runtime_count','GET')).json()).calls;}
 async function http(name:string,input:unknown,mutation=false,signal?:AbortSignal){
  const r=await fetch(app+'/api/trpc/'+name+(mutation?'':'?input='+encodeURIComponent(JSON.stringify(input))),{method:mutation?'POST':'GET',signal,headers:{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),'content-type':'application/json'},...(mutation?{body:JSON.stringify(input)}:{})});
  const body=await r.json();expect(r.status,JSON.stringify(body)).toBe(200);return body.result.data;
 }
 const initialCount=await count();
 const first=await http('runtime.start',{requestId:randomUUID(),scope:{kind:'positioning_draft'}},true);
 const prepared=await http('runtime.prepare',{sessionId:first.sessionId,requestId:randomUUID(),input:'Keep late response in first scope',selection:{kind:'ordinary',modelId},network:'deny'},true);
 await control('/__runtime_hold');
 const disconnect=new AbortController();const pending=http('runtime.execute',{executionId:prepared.executionId},true,disconnect.signal).then(()=>false,()=>true);
 await expect.poll(count,{timeout:15000}).toBe(initialCount+1);disconnect.abort();expect(await pending).toBe(true);
 const second=await http('runtime.start',{requestId:randomUUID(),scope:{kind:'positioning_draft'}},true);expect(second.sessionId).not.toBe(first.sessionId);
 await control('/__runtime_release');
 await expect.poll(async()=> (await db.query('select state from runtime_executions where id=$1',[prepared.executionId])).rows[0].state,{timeout:15000}).toBe('completed');
 const firstView=await http('runtime.view',{sessionId:first.sessionId}),secondView=await http('runtime.view',{sessionId:second.sessionId});
 expect(firstView.executions[0].body).toBe('Saved runtime answer '+(initialCount+1));expect(secondView.executions).toEqual([]);
 expect((await http('runtime.execute',{executionId:prepared.executionId},true)).state).toBe('completed');expect(await count()).toBe(initialCount+1);
 const interrupted=await http('runtime.prepare',{sessionId:second.sessionId,requestId:randomUUID(),input:'Unknown if process is killed',selection:{kind:'ordinary',modelId},network:'deny'},true);
 const original=(await db.query('select r.id,r.pre_deduct_id,r.session_ref,e.request_id,e.history_revision from bill2_runs r join runtime_executions e on e.billing_run_id=r.id where e.id=$1',[interrupted.executionId])).rows[0];
 await control('/__runtime_hold');
 const death=http('runtime.execute',{executionId:interrupted.executionId},true).then(()=>false,()=>true);
 await expect.poll(count,{timeout:15000}).toBe(initialCount+2);
 const before=(await (await control('/__runtime_process','GET')).json()).pid;
 await control('/__restart_app');expect(await death).toBe(true);
 const after=(await (await control('/__runtime_process','GET')).json()).pid;expect(after).not.toBe(before);
 await control('/__runtime_release');
 cookies.clear();expect((await client.auth.signInWithPassword({email,password})).error).toBeNull();
 await expect.poll(async()=>{try{return (await fetch(app+'/login',{signal:AbortSignal.timeout(3000)})).status;}catch{return 0;}},{timeout:60000}).toBe(200);
 const restored=await http('runtime.view',{sessionId:second.sessionId});expect(restored.executions[0].executionId).toBe(interrupted.executionId);expect(restored.executions[0].body).toBeNull();
 for(let i=0;i<2;i++)expect((await http('runtime.execute',{executionId:interrupted.executionId},true)).state).toBe('pending');
 expect((await http('runtime.cancel',{executionId:interrupted.executionId},true)).state).toBe('cost_pending');
 expect((await http('runtime.execute',{executionId:interrupted.executionId},true)).state).toBe('cost_pending');
 expect(await count()).toBe(initialCount+2);
 expect((await db.query('select r.id,r.pre_deduct_id,r.session_ref,e.request_id,e.history_revision from bill2_runs r join runtime_executions e on e.billing_run_id=r.id where e.id=$1',[interrupted.executionId])).rows[0]).toEqual(original);
 expect((await db.query('select state,provider_id from bill2_calls where run_id=$1',[interrupted.runId])).rows).toEqual([{state:'dispatched',provider_id:null}]);
 expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[second.sessionId])).rows[0].n).toBe(0);
 expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:37,ledger:37});
 expect((await db.query('select count(*)::int n from runtime_session_history where session_id=$1',[first.sessionId])).rows[0].n).toBe(2);
},180000);
it('RUNTIME: work ownership and selected Skills stay separate with bounded actual history dependencies',async()=>{
 const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id;
 await db.query("insert into profiles(id,email,credits,role) values($1,$2,500,'admin')",[actor,email]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,500,'addition','grant','opening_grant','system',$2,0,500)",[actor,'opening:'+actor]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 expect((await user.auth.signInWithPassword({email,password})).error).toBeNull();
 const packs=[] as Array<{moduleId:string;pack:ReturnType<typeof makePackage>}>;
 for(let i=0;i<2;i++){
  const pack=makePackage(),moduleId=randomUUID();
  await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'work-window-'+pack.id,actor]);
  await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Work selected Skill',$2,true,$3)",[moduleId,pack.id,modelId]);
  await publishSkillPackage(admin,actor,pack);packs.push({pack,moduleId});
 }
 await db.query("update profiles set role='user' where id=$1",[actor]);
 const [a,b]=packs,parent=randomUUID(),work=randomUUID();
 await db.query('insert into artifact_projects(id,actor_id,module_id,skill_id) values($1,$2,$3,$4)',[parent,actor,a.moduleId,a.pack.id]);
 await db.query("insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id) values($1,$2,$3,$4,'script',$5)",[work,actor,a.moduleId,a.pack.id,parent]);
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:2,maxOutputTokens:200,inputBytes:10000,historyItems:2};
 const admission=runtimeAdmissionService(user,admin,policy),session=await admission.start(randomUUID(),{kind:'work_item',projectId:parent,workItemId:work});
 const input={sessionId:session.sessionId,input:'Use selected method',network:'deny',selection:{kind:'skill',moduleId:b.moduleId,revisionId:b.pack.revisionId}};
 await expect(admission.prepare({...input,requestId:randomUUID(),selection:{...input.selection,revisionId:a.pack.revisionId}})).rejects.toThrow();
 await expect(admission.start(randomUUID(),{kind:'work_item',projectId:randomUUID(),workItemId:work})).rejects.toThrow();
 const requests:unknown[]=[],ids:string[]=[];let nextMatch:string|null=null;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const request=JSON.parse(JSON.parse(raw).input);requests.push(request);
  const id='bounded-'+randomUUID(),content=nextMatch?JSON.stringify({key:nextMatch}):'Window answer '+requests.length;nextMatch=null;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:request.model,final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:{id,object:'chat.completion',created:1,model:request.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
  const executor=runtimeExecutor({database:admin,actor:async()=>actor,endpoint:'http://127.0.0.1:'+address.port,activateSkill:c=>activateRuntimeCandidate(user,admin,c)});
  for(const chosen of [a,b]){
   const e=await admission.prepare({...input,requestId:randomUUID(),selection:{kind:'skill',moduleId:chosen.moduleId,revisionId:chosen.pack.revisionId}});ids.push(e.executionId);
   expect((await executor.execute(e.executionId)).state).toBe('completed');
   expect((await db.query('select payload from bill2_runs where id=$1',[e.runId])).rows[0].payload.moduleId).toBe(chosen.moduleId);
  }
  expect(requests).toHaveLength(2);expect(JSON.stringify(requests[1])).toContain('METHOD_CANARY');
  await user.auth.signOut();expect((await user.auth.signInWithPassword({email,password})).error).toBeNull();
  expect((await executor.execute(ids[1])).state).toBe('completed');expect(requests).toHaveLength(2);
  const auto=await admission.prepare({...input,requestId:randomUUID(),selection:{kind:'auto',modelId}});ids.push(auto.executionId);
  const frozen=(await db.query('select payload from runtime_executions where id=$1',[auto.executionId])).rows[0].payload;
  nextMatch=frozen.matching.candidates.find((c:{moduleId:string})=>c.moduleId===b.moduleId).key;
  expect((await executor.execute(auto.executionId)).state).toBe('completed');expect(requests).toHaveLength(4);
  expect((await executor.execute(auto.executionId)).state).toBe('completed');expect(requests).toHaveLength(4);
  for(let i=0;i<20;i++){
   const e=await admission.prepare({...input,input:'Window turn '+i,requestId:randomUUID(),selection:{kind:'ordinary',modelId}});ids.push(e.executionId);
   expect((await executor.execute(e.executionId)).state).toBe('completed');
  }
  const edges=(await db.query('select count(*)::int n from runtime_history_dependencies where execution_id=ANY($1::uuid[])',[ids])).rows[0].n;
  expect(edges).toBeLessThanOrEqual(ids.length-1); // one prior execution in each two-item window, not N(N-1)/2.
  const zero=runtimeAdmissionService(user,admin,{...policy,historyItems:0});
  const independent=await zero.prepare({...input,input:'No old history',requestId:randomUUID(),selection:{kind:'ordinary',modelId}});
  expect((await executor.execute(independent.executionId)).state).toBe('completed');
  expect((await db.query('select count(*)::int n from runtime_history_dependencies where execution_id=$1',[independent.executionId])).rows[0].n).toBe(0);
  expect(JSON.stringify(requests.at(-1))).not.toContain('Window answer');
  await db.query('update modules set active=false where id=$1',[b.moduleId]);
  for(const id of [ids[1],auto.executionId,ids.at(-1)])expect((await db.query('select runtime_history_available($1) allowed',[id])).rows[0].allowed).toBe(false);
  expect((await db.query('select runtime_history_available($1) allowed',[independent.executionId])).rows[0].allowed).toBe(true);
  await expect(admission.prepare({...input,requestId:randomUUID()})).rejects.toThrow();
  expect((await db.query('select module_id,skill_id,source_project_id from artifact_projects where id=$1',[work])).rows[0]).toEqual({module_id:a.moduleId,skill_id:a.pack.id,source_project_id:parent});
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:425,ledger:425});
  expect(requests).toHaveLength(25);
  expect((await db.query("select count(*)::int n from billing_history where user_id=$1 and operation_type='settle'",[actor])).rows[0].n).toBe(24);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
},120000);
it('RUNTIME: historical revision admission and another Session dispatch never invert the profile lock',async()=>{
 const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!',created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const actor=created.data.user.id;
 await db.query("insert into profiles(id,email,credits,role) values($1,$2,100,'admin')",[actor,email]);await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,randomUUID()]);
 const pack=makePackage(),moduleId=randomUUID();await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'lock-'+pack.id,actor]);await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Lock Skill',$2,true,$3)",[moduleId,pack.id,modelId]);await publishSkillPackage(admin,actor,pack);await db.query("update profiles set role='user' where id=$1",[actor]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});expect((await user.auth.signInWithPassword({email,password})).error).toBeNull();
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:100,inputBytes:10000,historyItems:2};const admission=runtimeAdmissionService(user,admin,policy);
 const s=await admission.start(randomUUID(),{kind:'positioning_draft'}),other=await admission.start(randomUUID(),{kind:'positioning_draft'});
 const choice={kind:'skill',moduleId,revisionId:pack.revisionId},old=await admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'Original Skill history',selection:choice});
 let posts=0;const server=createServer(async(req,res)=>{for await(const _ of req){}posts++;const id='lock-'+randomUUID();res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:{id,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:{role:'assistant',content:'Keep this history'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}}}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const holder=new pg.Client({connectionString}),waiter=new pg.Client({connectionString});await Promise.all([holder.connect(),waiter.connect()]);
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');expect((await runtimeExecutor({database:admin,actor:async()=>actor,endpoint:'http://127.0.0.1:'+address.port}).execute(old.executionId)).state).toBe('completed');
  const pending=await admission.prepare({sessionId:other.sessionId,requestId:randomUUID(),input:'Concurrent Skill',selection:choice});
  const frozen=(await db.query('select payload from bill2_runs where id=$1',[pending.runId])).rows[0].payload;
  const call={...frozen.callPolicy[0],phase:'reply',requestHash:createHash('sha256').update('never resent').digest('hex')};delete call.modelId;
  await holder.query("BEGIN; SET LOCAL lock_timeout='5s'");await holder.query('select id from skill_revisions where id=$1 for update',[pack.revisionId]);const claim=(await holder.query('select bill2_claim($1,$2,1,$3) c',[actor,pending.runId,call])).rows[0].c;
  const holderPid=(await holder.query('select pg_backend_pid() p')).rows[0].p,waiterPid=(await waiter.query('select pg_backend_pid() p')).rows[0].p;
  expect(holderPid).not.toBe(waiterPid);await waiter.query("BEGIN; SET LOCAL lock_timeout='5s'");
  const context={version:'runtime.v1',sdkVersion:'0.18.0',role:'ordinary',input:'Continue original history',instructions:'Ordinary',model:'runtime-m',maxOutputTokens:100,maxTurns:1,historyItems:2};
  const billing={...frozen,scope:s.scope,input:context};delete billing.moduleId;delete billing.skillId;delete billing.revisionId;
  const admitting=waiter.query('select runtime_admit($1,$2,$3,$4,$5) e',[actor,s.sessionId,randomUUID(),context,billing]).then(async r=>{await waiter.query('COMMIT');return {value:r.rows[0].e,error:null};},async error=>{await waiter.query('ROLLBACK');return {value:null,error};});
  let blocked=false;for(let i=0;i<100;i++){const p=(await db.query('select pg_blocking_pids($1) p',[waiterPid])).rows[0].p;if(p.includes(holderPid)){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}expect(blocked).toBe(true);
  const dispatched=(await holder.query('select bill2_dispatch($1,$2,$3,$4) d',[actor,pending.runId,claim.id,claim.dispatchToken])).rows[0].d;expect(dispatched.dispatch).toBe(true);await holder.query('COMMIT');
  const admitted=await admitting;expect(admitted.error).toBeNull();expect(admitted.value).not.toBeNull();
  const history=(await db.query('select candidate_history from runtime_executions where id=$1',[admitted.value.executionId])).rows[0].candidate_history;
  expect(history).toHaveLength(2);expect(posts).toBe(1); // no synthetic network call for the separately claimed dispatch.
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:57,ledger:57});
 }finally{await Promise.allSettled([holder.query('ROLLBACK'),waiter.query('ROLLBACK')]);await Promise.all([holder.end(),waiter.end()]);await new Promise<void>(r=>server.close(()=>r()));}
},30000);
it('RUNTIME: database transaction errors cannot silently exclude authorized history',async()=>{
 const f=await fixture(),e=await rpc('runtime_admit',f.admit);
 const original=(await db.query("select pg_get_functiondef('runtime_context_allowed(uuid,jsonb)'::regprocedure) body")).rows[0].body;
 try{
  await db.query("CREATE OR REPLACE FUNCTION public.runtime_context_allowed(p_actor_id uuid,p_context jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'synthetic serialization failure' USING ERRCODE='40001';END $$");
  await expect(db.query('select runtime_history_available($1)',[e.executionId])).rejects.toMatchObject({code:'40001'});
 }finally{await db.query(original);}
 expect((await db.query('select runtime_history_available($1) allowed',[e.executionId])).rows[0].allowed).toBe(true);
});

it('RUNTIME: opposite Skill history dependencies allow concurrent claim and dispatch',async()=>{
 const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!',created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const actor=created.data.user.id;
 await db.query("insert into profiles(id,email,credits,role) values($1,$2,100,'admin')",[actor,email]);await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,randomUUID()]);
 const pack=makePackage(),moduleId=randomUUID();await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'lock-'+pack.id,actor]);await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Lock Skill',$2,true,$3)",[moduleId,pack.id,modelId]);await publishSkillPackage(admin,actor,pack);const packB=makePackage(),moduleB=randomUUID();await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[packB.id,'cross-'+packB.id,actor]);await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Cross Skill',$2,true,$3)",[moduleB,packB.id,modelId]);await publishSkillPackage(admin,actor,packB);await db.query("update profiles set role='user' where id=$1",[actor]);
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});expect((await user.auth.signInWithPassword({email,password})).error).toBeNull();
 const policy={account:'sandbox',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:1,maxOutputTokens:100,inputBytes:10000,historyItems:2};const admission=runtimeAdmissionService(user,admin,policy);
 const s=await admission.start(randomUUID(),{kind:'positioning_draft'}),other=await admission.start(randomUUID(),{kind:'positioning_draft'});
 const choice={kind:'skill',moduleId,revisionId:pack.revisionId},old=await admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'Original Skill history',selection:choice});
 const choiceB={kind:'skill',moduleId:moduleB,revisionId:packB.revisionId};const oldB=await admission.prepare({sessionId:other.sessionId,requestId:randomUUID(),input:'Original B history',selection:choiceB});
 let posts=0;const server=createServer(async(req,res)=>{for await(const _ of req){}posts++;const id='lock-'+randomUUID();res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:'runtime-m',final:true,cost:'0.003',currency:'USD',coverage:'request_total',usage:{sdkResponse:{id,object:'chat.completion',created:1,model:'runtime-m',choices:[{index:0,message:{role:'assistant',content:'Keep this history'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}}}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const clients=[new pg.Client({connectionString}),new pg.Client({connectionString})];await Promise.all(clients.map(c=>c.connect()));
 try{
  const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');const executor=runtimeExecutor({database:admin,actor:async()=>actor,endpoint:'http://127.0.0.1:'+address.port});
  for(const e of [old,oldB])expect((await executor.execute(e.executionId)).state).toBe('completed');
  const pending=[await admission.prepare({sessionId:s.sessionId,requestId:randomUUID(),input:'A history with B',selection:choiceB}),await admission.prepare({sessionId:other.sessionId,requestId:randomUUID(),input:'B history with A',selection:choice})];
  const frozen=[];const calls:Record<string,unknown>[]=[];
  for(let i=0;i<2;i++){
   const session=new PostgresSession(admin,{actorId:actor,sessionId:[s,other][i].sessionId,executionId:pending[i].executionId});expect(await session.getItems()).toHaveLength(2);await session.freezeHistory(2);
   expect((await db.query('select dependency_id id from runtime_history_dependencies where execution_id=$1',[pending[i].executionId])).rows).toEqual([{id:[old,oldB][i].executionId}]);
   frozen[i]=(await db.query('select payload from bill2_runs where id=$1',[pending[i].runId])).rows[0].payload;
   calls[i]={...frozen[i].callPolicy[0],phase:'reply',requestHash:createHash('sha256').update('cross-'+i).digest('hex')};delete calls[i].modelId;
  }
  for(let i=0;i<2;i++){
   await clients[i].query("BEGIN; SET LOCAL lock_timeout='5s'");
   // Real direct permission reads hold B and A respectively, then the normal
   // guarded claim rechecks the actual persisted opposite history dependencies.
   await clients[i].query('select runtime_direct_billing_allowed($1,$2,$3)',[actor,frozen[i],pending[i].runId]);
  }
  console.log('RUNTIME_CROSS_LOCK_READY',JSON.stringify({sessions:2,oppositeDependencies:true}));
  const outcomes=await Promise.all(clients.map(async(c,i)=>{
   try{
    const claim=(await c.query('select bill2_claim($1,$2,1,$3) c',[actor,pending[i].runId,calls[i]])).rows[0].c;
    const dispatched=(await c.query('select bill2_dispatch($1,$2,$3,$4) d',[actor,pending[i].runId,claim.id,claim.dispatchToken])).rows[0].d;
    await c.query('COMMIT');return {error:null,dispatched};
   }catch(error){await c.query('ROLLBACK');return {error,dispatched:null};}
  }));
  console.log('RUNTIME_CROSS_LOCK_OUTCOME',JSON.stringify(outcomes.map(o=>({code:(o.error as {code?:string}|null)?.code??null,dispatch:o.dispatched?.dispatch??false}))));
  expect(outcomes.map(o=>o.error)).toEqual([null,null]);expect(outcomes.map(o=>o.dispatched?.dispatch)).toEqual([true,true]);
  expect(posts).toBe(2); // Permission/claim/dispatch RPCs do not send another HTTP call.
  expect((await db.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:54,ledger:54});
  expect((await admin.rpc('revoke_skill_revision',{p_revision_id:pack.revisionId,p_actor_id:actor})).error).not.toBeNull();
  expect((await user.rpc('revoke_skill_revision',{p_revision_id:pack.revisionId,p_actor_id:actor})).error).not.toBeNull();
  expect((await db.query("select has_function_privilege('service_role','revoke_skill_revision(uuid,uuid)','execute') service,has_function_privilege('authenticated','revoke_skill_revision(uuid,uuid)','execute') browser")).rows[0]).toEqual({service:true,browser:false});
  await db.query("update profiles set role='admin' where id=$1",[actor]);
  const pids=await Promise.all(clients.map(async c=>(await c.query('select pg_backend_pid() p')).rows[0].p));
  const waitForBlock=async(waiter:number,holder:number)=>{for(let i=0;i<100;i++){if((await db.query('select pg_blocking_pids($1) p',[waiter])).rows[0].p.includes(holder))return true;await new Promise(r=>setTimeout(r,20));}return false;};
  await clients[0].query("BEGIN; SET LOCAL lock_timeout='5s'");await clients[0].query('select runtime_billing_allowed($1,$2,$3)',[actor,frozen[0],pending[0].runId]);
  await clients[1].query("BEGIN; SET LOCAL lock_timeout='5s'");
  const revoking=clients[1].query('select revoke_skill_revision($1,$2)',[pack.revisionId,actor]).then(async()=>{await clients[1].query('COMMIT');return null;},async error=>{await clients[1].query('ROLLBACK');return error;});
  expect(await waitForBlock(pids[1],pids[0])).toBe(true);await clients[0].query('COMMIT');expect(await revoking).toBeNull();
  await expect(db.query('select runtime_billing_allowed($1,$2,$3)',[actor,frozen[0],pending[0].runId])).rejects.toThrow();
  // Reverse winner: the real revoke RPC itself holds the lock before a late reader.
  await clients[1].query("BEGIN; SET LOCAL lock_timeout='5s'");await clients[1].query('select revoke_skill_revision($1,$2)',[packB.revisionId,actor]);
  await clients[0].query("BEGIN; SET LOCAL lock_timeout='5s'");
  const late=clients[0].query('select runtime_direct_billing_allowed($1,$2,$3)',[actor,frozen[0],pending[0].runId]).then(()=>null,error=>error);
  expect(await waitForBlock(pids[0],pids[1])).toBe(true);await clients[1].query('COMMIT');expect(await late).not.toBeNull();await clients[0].query('ROLLBACK');
  expect(posts).toBe(2);expect((await db.query('select credits from profiles where id=$1',[actor])).rows[0].credits).toBe(54);

 }finally{await Promise.allSettled(clients.map(c=>c.query('ROLLBACK')));await Promise.all(clients.map(c=>c.end()));await new Promise<void>(r=>server.close(()=>r()));}
},30000);
