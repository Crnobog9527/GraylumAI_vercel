/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it,expect } from 'vitest';
import { randomUUID,createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { makePackage,makeWorkflow } from '../__tests__/fixtures/artifacts';
import { publishSkillPackage } from '../skills/publication';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
const api=process.env.V3_LOCAL_REST!,app=process.env.V3_LOCAL_APP!,legacy=process.env.V3_LEGACY_ROOT!;
if(!api?.startsWith('http://127.0.0.1:')||!legacy?.includes('graylum-bill2-legacy-')||!process.env.V3_LOCAL_DB?.endsWith('/v3_disposable'))throw new Error('isolated Runtime rollback required');
it('RUNTIME UPGRADE: revision-bearing legacy work identity survives 0105 to 0106 without payload repair',async()=>{
 const sql=new pg.Client({connectionString:process.env.V3_LOCAL_DB});await sql.connect();
 const admin=createClient(api,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
 const {authoritativeBilling}=await import(/* @vite-ignore */ legacy+'/packages/api/src/services/bill2/service.ts');
 const {localFixtureAdapter}=await import(/* @vite-ignore */ legacy+'/packages/api/src/services/bill2/fixtureAdapter.ts');
 let posts=0,gets=0;
 const server=createServer(async(req,res)=>{for await(const _ of req){}if(req.url?.startsWith('/receipt/'))gets++;else posts++;
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'legacy-identity-'+(req.url?.startsWith('/receipt/')?req.url.split('/').at(-1)?.replace('legacy-identity-',''):posts),model:'identity-m',final:gets>0||posts>1,cost:gets>0||posts>1?'0.003':null,currency:'USD',coverage:'request_total'}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  await sql.query(readFileSync(new URL('../../../../db/migrations/0105_v3_bill2_authoritative_runs.sql',import.meta.url),'utf8'));
  await sql.query("NOTIFY pgrst, 'reload schema'");await new Promise(r=>setTimeout(r,500));
  const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!';
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const actor=created.data.user.id;
  await sql.query("insert into profiles(id,email,credits,role) values($1,$2,200,'admin')",[actor,email]);
  await sql.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,200,'addition','grant','opening_grant','system',$2,0,200)",[actor,randomUUID()]);
  const user=createClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});expect((await user.auth.signInWithPassword({email,password})).error).toBeNull();
  const pack=makePackage(),module=randomUUID(),model=randomUUID(),parent=randomUUID(),work=randomUUID(),account='identity-'+randomUUID();
  await sql.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Legacy identity','identity-m','fixture','true')",[model]);
  await sql.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'identity-'+pack.id,actor]);
  await sql.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Identity',$2,true,$3)",[module,pack.id,model]);await publishSkillPackage(admin,actor,pack);
  await sql.query("update profiles set role='user' where id=$1",[actor]);
  await sql.query('insert into artifact_accounts values($1,$2,$3,$4)',[actor,module,pack.id,account]);
  await sql.query('insert into artifact_projects(id,actor_id,module_id,skill_id,account) values($1,$2,$3,$4,$5)',[parent,actor,module,pack.id,account]);
  await sql.query("insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id) values($1,$2,$3,$4,'script',$5)",[work,actor,module,pack.id,parent]);
  const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
  const sourceRound=randomUUID(),targetRound=randomUUID(),evidence=randomUUID(),refEvidence=randomUUID(),version=randomUUID(),config='identity-'+randomUUID();
  const sf=makeWorkflow(6,true),tf=makeWorkflow(2),sourceFlow='src-'+randomUUID(),targetFlow='dst-'+randomUUID();
  for(const [id,flow] of [[sourceFlow,sf],[targetFlow,tf]])await sql.query("insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,'Identity reference',true)",[id,module,pack.id,pack.revisionId,flow]);
  for(const [id,project,flow] of [[sourceRound,parent,sf],[targetRound,work,tf]])await sql.query("insert into artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps) values($1,$2,$3,$4,$5,$6,$6,'published','{}')",[id,project,pack.revisionId,pack.descriptor.packageHash,flow,hash('workflow')]);
  for(const [id,project] of [[evidence,parent],[refEvidence,work]]){await sql.query("insert into artifact_evidence(id,project_id,kind,payload,content_hash) values($1,$2,'user','{}',$3)",[id,project,hash('source')]);await sql.query('insert into artifact_evidence_restrictions(evidence_id) values($1)',[id]);}
  await sql.query("insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) values($1,$2,$3,1,'{}',$4,$5)",[version,parent,sourceRound,hash('source'),JSON.stringify([evidence])]);
  await sql.query("insert into artifact_reference_configs values($1,$2,$3,'[\"step-0\"]',20000,true)",[config,sourceFlow,targetFlow]);await sql.query("insert into artifact_work_references values($1,$2,$3,$4,$5,'[\"step-0\"]',$6,$7,'{}')",[targetRound,work,refEvidence,version,config,hash('source'),randomUUID()]);
  const payload={contractVersion:'bill2.v1',mode:'isolated',scope:{kind:'work_item',projectId:parent,workItemId:work},operation:'work',revisionId:pack.revisionId,modelId:model,sourceHash:createHash('sha256').update('legacy work').digest('hex'),input:{text:'original private work'},
   callPolicy:[{modelId:model,provider:'fixture',account:'sandbox',model:'identity-m',protocol:'fixture-cost-v1',upperUsd:'0.02',inputLimit:10000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true}],
   rules:{version:'v1',quoteVersion:'v1',creditsPerUsd:'1000',multiplier:'1',fx:{}},limits:{costUsd:'0.02',credits:20,maxPreDeduct:20,maxCalls:1,deadline:new Date(Date.now()+3600000).toISOString()}};
  expect(payload).not.toHaveProperty('moduleId');expect(payload).not.toHaveProperty('skillId');
  const address=server.address();if(!address||typeof address==='string')throw new Error('local fixture');
  const observedAdmin={rpc:async(name:string,args:Record<string,unknown>)=>{const r=await admin.rpc(name,args);if(r.error)console.log('LEGACY_IDENTITY_RPC_ERROR',name,r.error.message);return r;}};
  const billing=authoritativeBilling({admin:observedAdmin,actor:async()=>{const r=await user.auth.getUser();if(r.error||!r.data.user)throw new Error('auth');return r.data.user.id;},adapter:localFixtureAdapter('http://127.0.0.1:'+address.port)});
  const body='original input',call={...payload.callPolicy[0],phase:'reply',requestHash:createHash('sha256').update(body).digest('hex')};delete (call as any).modelId;
  const requestIds=[randomUUID(),randomUUID(),randomUUID()];const runs:Array<{id:string}>=[];for(const id of requestIds)runs.push(await billing.prepareRun(id,payload));
  const held=await billing.claimCall(runs[1].id,1,call),sent=await billing.claimCall(runs[2].id,1,call);
  expect((await billing.dispatchOnce(sent.id,body)).dispatched).toBe(true);expect(posts).toBe(1);
  async function identities(){return (await sql.query('select id,request_id,pre_deduct_id,payload from bill2_runs where actor_id=$1 order by id',[actor])).rows;}
  const before=await identities();const dbOid=(await sql.query('select oid from pg_database where datname=current_database()')).rows[0].oid;
  expect((await sql.query("select to_regclass('runtime_executions') name")).rows[0].name).toBeNull();
  console.log('LEGACY_IDENTITY_0105_PASS',JSON.stringify({runs:runs.length,posts,omittedIdentity:true}));
  const upgraded=await fetch(api+'/__upgrade_bill2',{method:'POST',headers:{'x-local-control':process.env.V3_LOCAL_CONTROL!}});expect(upgraded.status).toBe(200);await new Promise(r=>setTimeout(r,500));
  expect(await identities()).toEqual(before);expect((await sql.query('select oid from pg_database where datname=current_database()')).rows[0].oid).toBe(dbOid);
  const probes=await Promise.allSettled([billing.readPrivateInput(runs[0].id),billing.claimCall(runs[0].id,1,call),billing.prepareRun(randomUUID(),{...payload,revisionId:randomUUID()})]);
  console.log('LEGACY_IDENTITY_0106_PROBES',JSON.stringify(probes.map(r=>r.status==='rejected'?String(r.reason):'fulfilled')));
  expect(probes[0].status).toBe('fulfilled');expect(probes[1].status).toBe('fulfilled');expect(probes[2].status).toBe('rejected');
  for(let i=0;i<runs.length;i++)expect((await billing.prepareRun(requestIds[i],payload)).id).toBe(runs[i].id);
  const first=(probes[1] as PromiseFulfilledResult<any>).value;expect((await billing.dispatchOnce(first.id,body)).dispatched).toBe(true);
  expect((await billing.dispatchOnce(held.id,body)).dispatched).toBe(true);expect((await billing.dispatchOnce(held.id,body)).dispatched).toBe(false);
  const fresh=await billing.prepareRun(randomUUID(),payload);const c=await billing.claimCall(fresh.id,1,call);expect((await billing.dispatchOnce(c.id,body)).dispatched).toBe(true);
  await billing.recoverRun(runs[2].id);expect(posts).toBe(4);expect(gets).toBe(1);
  const terminal={kind:'usable_result',body:'allowed result',evidenceRef:randomUUID(),evidenceHash:createHash('sha256').update('allowed result').digest('hex')};
  for(const r of [...runs,fresh]){await billing.closeRun(r.id,'delivered',terminal);expect((await billing.finalizeRun(r.id)).state).toBe('settled');expect((await billing.finalizeRun(r.id)).state).toBe('settled');}
  expect(posts).toBe(4);expect(gets).toBe(1);expect((await identities()).filter((r:any)=>runs.some(x=>x.id===r.id))).toEqual(before);
  // Only the trusted Runtime entry can establish Runtime semantics. Missing
  // selected identity is rejected there before a new reservation, even though
  // the original unbound BILL2 contract can infer it.
  const started=await admin.rpc('runtime_start',{p_actor_id:actor,p_request_id:randomUUID(),p_payload:{scope:payload.scope}});expect(started.error).toBeNull();
  const noIdentity=await admin.rpc('runtime_admit',{p_actor_id:actor,p_session_id:started.data.sessionId,p_request_id:randomUUID(),p_payload:payload.input,p_billing:payload});expect(noIdentity.error).not.toBeNull();
  expect((await sql.query('select count(*)::int n from bill2_runs where actor_id=$1',[actor])).rows[0].n).toBe(4);
  await sql.query("update ai_models set is_active='false' where id=$1",[model]);await expect(billing.prepareRun(randomUUID(),payload)).rejects.toThrow();await expect(billing.readPrivateInput(runs[0].id)).rejects.toThrow();await sql.query("update ai_models set is_active='true' where id=$1",[model]);
  await expect(billing.prepareRun(randomUUID(),{...payload,scope:{...payload.scope,projectId:randomUUID()}})).rejects.toThrow();
  const otherEmail=randomUUID()+'@example.test';const otherCreated=await admin.auth.admin.createUser({email:otherEmail,password,email_confirm:true});if(otherCreated.error)throw otherCreated.error;
  await sql.query('insert into profiles(id,email,credits) values($1,$2,0)',[otherCreated.data.user.id,otherEmail]);
  const otherUser=createClient(api,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});expect((await otherUser.auth.signInWithPassword({email:otherEmail,password})).error).toBeNull();
  const other=authoritativeBilling({admin,actor:async()=>{const r=await otherUser.auth.getUser();if(r.error||!r.data.user)throw new Error('auth');return r.data.user.id;},adapter:localFixtureAdapter('http://127.0.0.1:'+address.port)});
  await expect(other.prepareRun(randomUUID(),payload)).rejects.toThrow();await expect(other.readPrivateInput(runs[0].id)).rejects.toThrow();
  await sql.query('delete from artifact_accounts where actor_id=$1',[actor]);await expect(billing.prepareRun(randomUUID(),payload)).rejects.toThrow();await expect(billing.readPrivateInput(runs[0].id)).rejects.toThrow();await sql.query('insert into artifact_accounts values($1,$2,$3,$4)',[actor,module,pack.id,account]);
  await sql.query('update modules set active=false where id=$1',[module]);await expect(billing.prepareRun(randomUUID(),payload)).rejects.toThrow();await expect(billing.readPrivateInput(runs[0].id)).rejects.toThrow();await sql.query('update modules set active=true where id=$1',[module]);
  await sql.query("update profiles set role='admin' where id=$1",[actor]);
  const revoked=await admin.rpc('revoke_skill_revision',{p_revision_id:pack.revisionId,p_actor_id:actor});expect(revoked.error).toBeNull();
  await expect(billing.prepareRun(randomUUID(),payload)).rejects.toThrow();await expect(billing.readPrivateInput(runs[0].id)).rejects.toThrow();
  expect((await sql.query("select credits,(select sum(amount)::int from credit_transactions where user_id=$1) ledger,(select count(*)::int from billing_history where user_id=$1 and operation_type='settle') terminals from profiles where id=$1",[actor])).rows[0]).toEqual({credits:188,ledger:188,terminals:4});
  console.log('LEGACY_IDENTITY_0106_PASS',JSON.stringify({sameDatabase:true,originalIdentityAndPayload:true,posts,terminals:4}));
 }finally{await sql.end();await new Promise<void>(r=>server.close(()=>r()));}
},180000);
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
