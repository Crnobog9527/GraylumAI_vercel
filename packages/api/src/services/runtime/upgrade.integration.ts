/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
const api=process.env.V3_LOCAL_REST!,app=process.env.V3_LOCAL_APP!,legacy=process.env.V3_LEGACY_ROOT!;
if(!api?.startsWith('http://127.0.0.1:')||!legacy?.includes('graylum-bill2-legacy-')||!process.env.V3_LOCAL_DB?.endsWith('/v3_disposable'))throw new Error('isolated Runtime rollback required');
it('RUNTIME UPGRADE: actual old application process retains pending Session and candidate HTTP recovers once',async()=>{
 const sql=new pg.Client({connectionString:process.env.V3_LOCAL_DB});await sql.connect();
 const admin=createClient(api,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
 async function control(path:string){const r=await fetch(api+path,{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});expect(r.status).toBe(200);}
 async function ready(){for(let i=0;i<120;i++){try{if((await fetch(app+'/login',{signal:AbortSignal.timeout(2000)})).ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error('application not ready');}
 const {createServerClient}=createRequire(new URL('../../../../../apps/web/package.json',import.meta.url))('@supabase/ssr');
 const cookies=new Map<string,string>();
 const client=createServerClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:(items:Array<{name:string;value:string}>)=>items.forEach(c=>cookies.set(c.name,c.value))}});
 async function http(name:string,input:unknown,mutation=false){
  const r=await fetch(app+'/api/trpc/'+name+(mutation?'':'?input='+encodeURIComponent(JSON.stringify(input))),{method:mutation?'POST':'GET',headers:{Cookie:[...cookies].map(([name,value])=>name+'='+value).join('; '),'content-type':'application/json'},...(mutation?{body:JSON.stringify(input)}:{})});
  const body=await r.json();expect(r.status,JSON.stringify(body)).toBe(200);return body.result.data;
 }
 async function processState(){const r=await fetch(api+'/__runtime_process',{headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});expect(r.status).toBe(200);return r.json();}
 async function count(){const r=await fetch(api+'/__runtime_count',{headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});expect(r.status).toBe(200);return (await r.json()).calls;}
 try{
  await ready();await control('/__upgrade_bill2');await control('/__runtime_candidate');await ready();
  const candidateProcess=await processState();expect(candidateProcess.root).not.toBe(legacy);
  const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!';
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const actor=created.data.user.id;
  await sql.query('insert into profiles(id,email,credits) values($1,$2,100)',[actor,email]);
  await sql.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'adjustment','adjustment','opening','system',$2,0,100)",[actor,randomUUID()]);
  const modelId=randomUUID();await sql.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Runtime rollback','rollback-m','fixture','true')",[modelId]);
  expect((await client.auth.signInWithPassword({email,password})).error).toBeNull();
  const s=await http('runtime.start',{requestId:randomUUID(),scope:{kind:'positioning_draft'}},true);
  const e=await http('runtime.prepare',{sessionId:s.sessionId,requestId:randomUUID(),input:'Persist through code rollback',selection:{kind:'ordinary',modelId},network:'deny'},true);
  expect(await http('runtime.execute',{executionId:e.executionId},true)).toEqual({body:'Saved runtime answer 1',state:'cost_pending'});
  async function snapshot(){return (await sql.query(`select
   (select oid from pg_database where datname=current_database()) database_oid,
   (select row_to_json(e) from runtime_executions e where id=$1) execution,
   (select row_to_json(b) from bill2_runs b where id=$2) run,
   (select jsonb_agg(to_jsonb(c) order by sequence) from bill2_calls c where run_id=$2) calls,
   (select jsonb_agg(to_jsonb(h) order by revision) from runtime_session_history h where session_id=$3) history,
   (select jsonb_agg(to_jsonb(r) order by created_at,id) from bill2_receipts r where call_id in (select id from bill2_calls where run_id=$2)) receipts`,[e.executionId,e.runId,s.sessionId])).rows[0];}
  const original=await snapshot();expect(await count()).toBe(1);
  await control('/__runtime_legacy');await ready();
  const oldProcess=await processState();expect(oldProcess.root).toBe(legacy);expect(oldProcess.pid).not.toBe(candidateProcess.pid);
  const ledger=await http('credits.getCreditTransactions',{limit:100});expect(ledger.items.length).toBe(2);
  expect(JSON.stringify(ledger)).not.toContain('Saved runtime answer');
  const {BillingService}=await import(/* @vite-ignore */ legacy+'/packages/api/src/services/billing.ts');
  const billing=new BillingService({supabase:admin,userId:actor});
  const pre=(await sql.query('select pre_deduct_id from bill2_runs where id=$1',[e.runId])).rows[0].pre_deduct_id;
  await expect(billing.refund(pre,'must reject Runtime identity')).rejects.toThrow();
  expect(await snapshot()).toEqual(original);expect(await count()).toBe(1);
  await control('/__runtime_candidate');await ready();
  const restoredProcess=await processState();expect(restoredProcess.root).toBe(candidateProcess.root);expect(restoredProcess.pid).not.toBe(oldProcess.pid);
  cookies.clear();expect((await client.auth.signInWithPassword({email,password})).error).toBeNull();
  const view=await http('runtime.view',{sessionId:s.sessionId});expect(view.executions[0].body).toBe('Saved runtime answer 1');
  await control('/__runtime_final');
  const results=await Promise.all([http('runtime.execute',{executionId:e.executionId},true),http('runtime.execute',{executionId:e.executionId},true)]);
  expect(results.every(r=>r.state==='completed'&&r.body==='Saved runtime answer 1')).toBe(true);
  expect(await count()).toBe(1);
  const after=await snapshot();expect(after.database_oid).toBe(original.database_oid);expect(after.history).toEqual(original.history);
  expect(after.calls.map((c:any)=>[c.id,c.run_id,c.provider_id])).toEqual(original.calls.map((c:any)=>[c.id,c.run_id,c.provider_id]));
  expect((await sql.query('select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger from profiles where id=$1',[actor])).rows[0]).toEqual({credits:97,ledger:97});
  expect((await sql.query("select count(*)::int n from billing_history where user_id=$1 and operation_type='settle'",[actor])).rows[0].n).toBe(1);
 }finally{await sql.end();}
},300000);
