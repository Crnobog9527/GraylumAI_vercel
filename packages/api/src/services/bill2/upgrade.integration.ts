/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { authoritativeBilling, type FrozenRun } from './service';
import { localFixtureAdapter } from './fixtureAdapter';
const legacy=process.env.V3_LEGACY_ROOT!,ref=process.env.V3_LEGACY_REF!,api=process.env.V3_LOCAL_REST!,app=process.env.V3_LOCAL_APP!;
if(!legacy?.includes('graylum-bill2-legacy-')||!process.env.V3_LOCAL_DB?.endsWith('/v3_disposable')||!api?.startsWith('http://127.0.0.1:'))throw new Error('isolated exact old runtime required');
it('UPGRADE: exact old application survives 0105 and a real code rollback preserves new unresolved identities',async()=>{
 const sql=new pg.Client({connectionString:process.env.V3_LOCAL_DB});await sql.connect();
 const admin=createClient(api,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});let calls=0,raw='';
 const provider=createServer(async(req,res)=>{for await(const _ of req){/* drain */}if(!req.url?.startsWith('/receipt/'))calls++;res.end(raw);});await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
 const hash=(v:string)=>createHash('sha256').update(v).digest('hex');const observations:unknown[]=[];
 async function control(path:string){const response=await fetch(api+path,{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});expect(response.status).toBe(200);}
 async function ready(){for(let i=0;i<240;i++){try{if((await fetch(app+'/login')).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error('legacy app readiness');}
 try{
  // Dynamic import resolves the exact archived implementation and its own dependency tree.
  const {BillingService}=await import(/* @vite-ignore */ legacy+'/packages/api/src/services/billing.ts');
  const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!';const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const actor=created.data.user.id;
  await sql.query("insert into profiles(id,email,credits) values($1,$2,10000)",[actor,email]);await sql.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key) values($1,10000,'adjustment','adjustment','opening','system',$2)",[actor,randomUUID()]);
  const client=createClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});const login=await client.auth.signInWithPassword({email,password});if(login.error)throw login.error;const token=login.data.session!.access_token;
  const model=randomUUID(),modelName='openai/gpt-4o-mini-2024-07-18';await sql.query("insert into ai_models(id,model_id,name,provider,api_key,api_endpoint,max_tokens,input_limit,token_counting_supported,tokenizer_family,input_token_cost,output_token_cost,is_active) values($1,$2,'Upgrade fixture','openai','LOCAL_SYNTHETIC_KEY','https://openrouter.ai/api/v1',4096,128000,'true','openai',150000,600000,'true')",[model,modelName]);
  await sql.query("insert into system_settings(key,value) values('primary_model_id',$1),('assistant_model_id',$1),('enable_free_tier','false') on conflict(key) do update set value=excluded.value",[JSON.stringify(model)]);
  const billing=new BillingService({supabase:admin,userId:actor});const usage={inputTokens:800,outputTokens:30,cacheReadTokens:0,cacheCreationTokens:0};
  async function request(mode:string){const response=await fetch(app+'/api/ai/stream',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),modelId:model,message:'CHAT_CASE_'+mode+'_'+randomUUID().replaceAll('-','')})});const body=await response.text();return {status:response.status,body};}
  async function snapshot(label:string){const state=(await sql.query(`select (select oid from pg_database where datname=current_database()) db_oid,
   (select credits from profiles where id=$1) credits,(select count(*)::int from billing_history where user_id=$1) history,
   (select count(*)::int from credit_transactions where user_id=$1) ledger,(select count(*)::int from token_stats where user_id=$1) tokens`,[actor])).rows[0];observations.push({label,ref,state,calls});return state;}
  await ready();expect((await request('OK')).body).toContain('"type":"complete"');
  const inFlight=await billing.preDeduct(20,{requestId:randomUUID()}),failFlight=await billing.preDeduct(12,{requestId:randomUUID()}),abortFlight=await billing.preDeduct(15,{requestId:randomUUID()});
  const before=await snapshot('old-code-before-0105');expect((await sql.query("select to_regclass('bill2_runs') name")).rows[0].name).toBeNull();
  await control('/__upgrade_bill2');await new Promise(r=>setTimeout(r,500));
  const conversation=randomUUID();await sql.query("insert into conversations(id,user_id,title) values($1,$2,'Old in-flight')",[conversation,actor]);
  const success={conversationId:conversation,userMessage:'old input',assistantMessage:'old result',modelUsed:modelName,usage,costUsd:0.001,credits:7,preDeductId:inFlight.preDeductId,requestId:randomUUID()};
  await billing.finalizeAISuccess(success);const once=await snapshot('legacy-success');await expect(billing.finalizeAISuccess(success)).rejects.toThrow();expect(await snapshot('legacy-duplicate-success-denied')).toEqual(once);
  await billing.finalizeAIFailure({modelUsed:modelName,reason:'confirmed fixture failure',preDeductId:failFlight.preDeductId,requestId:randomUUID()});
  await billing.settleAbort(abortFlight.preDeductId,{inputTokens:800,outputTokens:30},modelName);const aborted=await snapshot('legacy-abort');await expect(billing.settleAbort(abortFlight.preDeductId,{inputTokens:800,outputTokens:30},modelName)).rejects.toThrow();expect(await snapshot('legacy-duplicate-abort-denied')).toEqual(aborted);
  const upgraded=await snapshot('old-code-new-schema');expect(upgraded.db_oid).toBe(before.db_oid);
  for(const pre of [inFlight,failFlight,abortFlight])expect((await sql.query("select count(*)::int n from billing_history where metadata->>'preDeductId'=$1 and operation_type in ('settle','refund','abort_settle')",[pre.preDeductId])).rows[0].n).toBe(1);
  expect((await request('OK')).body).toContain('"type":"complete"');expect((await request('REFUSED')).body).toContain('"type":"error"');
  await control('/__runtime_candidate');await ready();
  const fixtureModel=randomUUID();await sql.query("insert into ai_models(id,model_id,name,provider,is_active,input_token_cost,output_token_cost) values($1,'m','BILL2 fixture','fixture','true',0,0)",[fixtureModel]);
  const adapter=localFixtureAdapter('http://127.0.0.1:'+(provider.address() as {port:number}).port),service=authoritativeBilling({admin,actor:async()=>actor,adapter});const draft=await service.createDraft();
  const payload:FrozenRun={contractVersion:'bill2.v1',mode:'isolated',scope:{kind:'positioning_draft',draftId:draft},operation:'question',modelId:fixtureModel,input:{private:'RETAIN_ACROSS_ROLLBACK'},sourceHash:hash('input'),rules:{version:'v1',quoteVersion:'v1',creditsPerUsd:'1000',multiplier:'1',fx:{}},limits:{costUsd:'0.02',credits:20,maxPreDeduct:20,maxCalls:2,deadline:new Date(Date.now()+3600000).toISOString()},callPolicy:[{modelId:fixtureModel,provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',upperUsd:'0.01',inputLimit:1000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true}]};
  const prepared=await service.prepareRun(randomUUID(),payload),run=await service.prepareRun(randomUUID(),payload),call=await service.claimCall(run.id,1,{provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',requestHash:hash('hello'),upperUsd:'0.01',inputLimit:1000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true,phase:'reply'});
  raw=JSON.stringify({id:'rollback-'+call.id,model:'m',final:false,cost:null,currency:'USD',coverage:'request_total'});await service.dispatchOnce(call.id,'hello');await service.closeRun(run.id,'unknown');
  async function retained(){return (await sql.query('select r.*, (select jsonb_agg(c order by c.sequence) from bill2_calls c where c.run_id=r.id) calls,(select jsonb_agg(e order by e.id) from bill2_receipts e join bill2_calls c on e.call_id=c.id where c.run_id=r.id) receipts from bill2_runs r where actor_id=$1 order by id',[actor])).rows;}
  const paid=await service.prepareRun(randomUUID(),payload),paidCall=await service.claimCall(paid.id,1,{provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',requestHash:hash('hello'),upperUsd:'0.01',inputLimit:1000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true,phase:'reply'});
  raw=JSON.stringify({id:'paid-'+paidCall.id,model:'m',final:true,cost:0.003,currency:'USD',coverage:'request_total'});await service.dispatchOnce(paidCall.id,'hello');await service.closeRun(paid.id,'delivered',{kind:'usable_result',evidenceRef:'paid',evidenceHash:hash('paid')});await service.finalizeRun(paid.id);
  const saved=await retained(),preRollback=await snapshot('candidate-unresolved-before-rollback');
  await control('/__runtime_legacy');await ready();expect((await request('OK')).body).toContain('"type":"complete"');
  const refund=await billing.preDeduct(10,{requestId:randomUUID()});await billing.refund(refund.preDeductId,'confirmed unsent fixture');
  expect(await retained()).toEqual(saved);expect(calls).toBe(2);expect((await snapshot('old-code-after-rollback')).db_oid).toBe(preRollback.db_oid);
  await expect(billing.refund(run.preDeductId,'must deny BILL2')).rejects.toThrow();expect(await retained()).toEqual(saved);
  const {createServerClient}=createRequire(new URL('../../../../../apps/web/package.json',import.meta.url))('@supabase/ssr');const cookies=new Map<string,string>();
  const sessionClient=createServerClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:(items:Array<{name:string;value:string}>)=>items.forEach(c=>cookies.set(c.name,c.value))}});
  const cookieLogin=await sessionClient.auth.signInWithPassword({email,password});expect(cookieLogin.error).toBeNull();
  async function query(name:string,input:unknown){const response=await fetch(app+'/api/trpc/credits.'+name+'?input='+encodeURIComponent(JSON.stringify(input)),{headers:{Cookie:[...cookies].map(([name,value])=>name+'='+value).join('; ')}});const body=await response.json();expect(response.status,JSON.stringify(body)).toBe(200);return body.result.data;}
  const page=await query('getCreditTransactions',{limit:100});const expected=(await sql.query('select * from credit_transactions where user_id=$1',[actor])).rows;
  expect(page.items.map((r:any)=>r.id).sort()).toEqual(expected.map(r=>r.id).sort());expect(JSON.stringify(page)).not.toContain('RETAIN_ACROSS_ROLLBACK');
  expect(page.items.filter((r:any)=>r.bill2_run_id===run.id).every((r:any)=>r.counts_as_spend===false)).toBe(true);
  expect(page.items.filter((r:any)=>r.bill2_run_id===paid.id&&r.counts_as_spend)).toMatchObject([{amount:-3}]);
  const ids:string[]=[];let cursor;for(let n=0;n<100;n++){const p=await query('getCreditTransactions',{limit:1,...(cursor?{cursor}:{})});ids.push(...p.items.map((r:any)=>r.id));if(!p.hasNextPage)break;cursor=p.nextCursor;}
  expect(ids.sort()).toEqual(expected.map(r=>r.id).sort());
  const summary=await query('getCreditsSummary',{period:'all'});expect(summary.totalSpent).toBe(expected.filter(r=>r.counts_as_spend).reduce((n,r)=>n-r.amount,0));
  // Admin read requires 0103's actual diagnostic grants, restored after the narrower old-finalizer checks.
  await control('/__finance_read_context');await new Promise(r=>setTimeout(r,500));
  async function finance(expectedStatus:number){const response=await fetch(app+'/api/trpc/admin.getFinanceStats',{headers:{Cookie:[...cookies].map(([name,value])=>name+'='+value).join('; ')}});const body=await response.json();expect(response.status,JSON.stringify(body)).toBe(expectedStatus);return body;}
  await finance(403); // A normal account must not gain cross-account finance access.
  await sql.query("update profiles set role='admin' where id=$1",[actor]);
  const unknownUsage=()=>sql.query("select cached_tokens,total_cost_usd from token_stats where bill2_run_id=$1",[paid.id]);
  // Untouched old source must demonstrably fail before the supported two-line rollback patch.
  const rawOld=await finance(500);expect(rawOld.error.data.code).toBe('INTERNAL_SERVER_ERROR');observations.push({label:'unpatched-old-finance-reader',status:500});
  await control('/__legacy_ledger_reader_compat');await ready();const ledgerOnly=await finance(500);expect(ledgerOnly.error.data.code).toBe('INTERNAL_SERVER_ERROR');observations.push({label:'ledger-compatible-old-reader-still-rejects-null-cache',status:500});
  await control('/__legacy_reader_compat');await ready();
  const oldFinance=(await finance(200)).result.data;expect(oldFinance.financeOverview.creditsConsumed).toBe(expected.filter(r=>r.counts_as_spend).reduce((n,r)=>n-r.amount,0));
  const usageBefore=await unknownUsage();expect(usageBefore.rows).toHaveLength(1);expect(usageBefore.rows[0].cached_tokens).toBeNull();expect(Number(usageBefore.rows[0].total_cost_usd)).toBe(0.003);
  expect(await retained()).toEqual(saved);expect(calls).toBe(2);expect((await request('OK')).body).toContain('"type":"complete"');
  const patchedRefund=await billing.preDeduct(10,{requestId:randomUUID()});await billing.refund(patchedRefund.preDeductId,'confirmed unsent after reader patch');expect(await retained()).toEqual(saved);
  observations.push({label:'supported-old-ref-plus-reader-patch-finance',status:200});
  await control('/__runtime_candidate');await ready();
  const finalSpent=(await sql.query('select sum(-amount)::int n from credit_transactions where user_id=$1 and counts_as_spend',[actor])).rows[0].n;expect((await finance(200)).result.data.financeOverview.creditsConsumed).toBe(finalSpent);
  expect((await unknownUsage()).rows).toEqual(usageBefore.rows);
  expect(await service.readPrivateInput(run.id)).toMatchObject({input:payload.input});raw=JSON.stringify({id:'rollback-'+call.id,model:'m',final:true,cost:0.007,currency:'USD',coverage:'request_total'});await service.closeRun(run.id,'delivered',{kind:'usable_result',evidenceRef:'restored',evidenceHash:hash('result'),body:'retained result'});await service.recoverRun(run.id);await service.recoverRun(run.id);expect((await service.readRun(run.id)).chargedCredits).toBe(7);expect((await service.readRun(prepared.id)).state).toBe('prepared');expect(calls).toBe(2);await snapshot('same-identity-recovered-after-forward-return');
  writeFileSync(resolve(process.env.V3_WORKBENCH_OUTPUT!,'upgrade-compatibility.json'),JSON.stringify({ref,inFlight:inFlight.preDeductId,newRun:run.id,newCall:call.id,observations},null,2));
 }finally{await sql.end();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));}
},360000);
