/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { authoritativeBilling, type FrozenRun, type FrozenCall } from './service';
import { fixtureEvidence, localFixtureAdapter } from './fixtureAdapter';
import { makePackage, makeWorkflow } from '../__tests__/fixtures/artifacts';
import { publishSkillPackage } from '../skills/publication';
import { buildBillingEngineV15ReadinessAudit } from '../billingReconciliation';
const connectionString=process.env.V3_LOCAL_DB!;
if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable')) throw new Error('isolated runner required');
const db=new pg.Client({connectionString});
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const modelId=randomUUID();const events:unknown[]=[];
const admin=createClient(process.env.V3_LOCAL_REST!,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
let providerCount=0,lookupCount=0,raw='';let endpoint='';
const server=createServer(async(req,res)=>{if(req.url?.startsWith('/receipt/'))lookupCount++;else providerCount++;for await(const _ of req){/* local fixture request */}res.setHeader('content-type','application/json');res.end(raw);});
async function sqlRpc(name:string,args:unknown[],client=db) { const result=await client.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args);return result.rows[0].result; }
async function user(credits=100) {const id=randomUUID();await db.query('insert into profiles(id,credits) values($1,$2)',[id,credits]);
 await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,$2::int,'addition','grant','opening_grant','system',$3,0,$2::int)",[id,credits,'opening_grant:'+id]);return id;}
async function fixture(credits=100) {const actor=await user(credits);const draft=await sqlRpc('bill2_create_draft',[actor]);const request=randomUUID();
 const payload:FrozenRun={contractVersion:'bill2.v1',mode:'isolated',scope:{kind:'positioning_draft',draftId:draft},operation:'question',modelId,sourceHash:hash('source'),input:{text:'private canary'},
 callPolicy:[{modelId,provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',upperUsd:'0.08',inputLimit:1000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true}],
 rules:{version:'v1',quoteVersion:'fixture-v1',creditsPerUsd:'1000',multiplier:'1',fx:{}},limits:{costUsd:'0.02',credits:20,maxPreDeduct:20,maxCalls:4,deadline:new Date(Date.now()+3600000).toISOString()}};
 const prepare=(p=payload,req=request,client=db)=>sqlRpc('bill2_prepare',[actor,req,p],client);
 return {actor,request,draft,payload,prepare};}
function frozenCall(sequence=1,upperUsd='0.01'):FrozenCall {return {provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',phase:'reply'+sequence,requestHash:hash('hello'),upperUsd,inputLimit:1000,outputLimit:1000,automaticRetry:false,hiddenTools:false,lookupSupported:true};}
async function call(actor:string,run:string,sequence=1,upper='0.01') {const c=await sqlRpc('bill2_claim',[actor,run,sequence,frozenCall(sequence,upper)]);expect((await sqlRpc('bill2_dispatch',[actor,run,c.id,c.dispatchToken])).dispatch).toBe(true);return c.id as string;}
async function receipt(actor:string,run:string,callId:string,cost:string|null='0.007',extra:Record<string,unknown>={}) {const e={provider:'fixture',account:'sandbox',model:'m',protocol:'fixture-cost-v1',providerId:'generation-'+callId,source:'response',sourceHash:hash(callId),observedAt:new Date().toISOString(),coverage:'request_total',final:cost!==null,cost,currency:'USD',...extra};return sqlRpc('bill2_record',[actor,run,callId,e]);}
const result=(outcome='delivered')=>({kind:outcome==='delivered'?'usable_result':'confirmed_delivery_failure',evidenceRef:'private-result',evidenceHash:hash('result'),body:'PRIVATE_CANARY'});
async function close(actor:string,run:string,outcome='delivered') {return sqlRpc('bill2_close',[actor,run,outcome,result(outcome)]);}
async function snapshot(actor:string) {const rows=await db.query(`select p.credits,(select coalesce(sum(amount),0)::int from credit_transactions where user_id=p.id) ledger,
 (select coalesce(sum(-amount),0)::int from credit_transactions where user_id=p.id and counts_as_spend) spend,
 (select count(*)::int from billing_history where user_id=p.id and operation_type in ('settle','refund','abort_settle')) terminals,
 (select count(*)::int from token_stats where user_id=p.id) usage,
 (select count(*)::int from ai_usage_logs where user_id=p.id) usageLogs,
 (select coalesce(sum(consumed_amount),0)::int from subscription_credit_grants where user_id=p.id) sourceConsumed,
 (select count(*)::int from credit_transactions where user_id=p.id) rows from profiles p where p.id=$1`,[actor]);return rows.rows[0];}
async function conservation(actor:string) {const s=await snapshot(actor);expect(s.credits).toBe(s.ledger);expect(s.credits).toBeGreaterThanOrEqual(0);return s;}
beforeAll(async()=>{await db.connect();await db.query("insert into ai_models(id,model_id,name,provider,is_active) values($1,'m','Fixture','fixture','true')",[modelId]);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));endpoint='http://127.0.0.1:'+ (server.address() as {port:number}).port;});
afterAll(async()=>{writeFileSync(resolve(process.env.V3_WORKBENCH_OUTPUT!,'bill2-concurrency.json'),JSON.stringify(events,null,2));await db.end();await new Promise<void>(r=>server.close(()=>r()));});
it('BILL2: prepares both persisted scope kinds; cross-user, wrong parent and missing session fail closed',async()=>{
 const f=await fixture();const run=await f.prepare();expect(await conservation(f.actor)).toMatchObject({credits:80,spend:0});
 expect(await f.prepare()).toEqual(run);await expect(f.prepare({...f.payload,input:{changed:true}})).rejects.toThrow('REQUEST_CONFLICT');
 await expect(sqlRpc('bill2_prepare',[await user(),randomUUID(),f.payload])).rejects.toThrow('SCOPE_DENIED');
 await expect(f.prepare({...f.payload,sessionRef:randomUUID()} as unknown as FrozenRun,randomUUID())).rejects.toThrow('CONTRACT');
 const module=randomUUID(),skill=randomUUID(),parent=randomUUID(),item=randomUUID();
 await db.query("insert into modules(id,title) values($1,'Fixture');",[module]);await db.query("insert into skills(id,skill_key) values($1,$2)",[skill,'bill2-'+skill]);
 await db.query("insert into artifact_projects(id,actor_id,module_id,skill_id) values($1,$2,$3,$4)",[parent,f.actor,module,skill]);
 await db.query("insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id) values($1,$2,$3,$4,'script',$5)",[item,f.actor,module,skill,parent]);
 const work={...f.payload,operation:'work' as const,scope:{kind:'work_item' as const,projectId:parent,workItemId:item}};
 expect((await f.prepare(work,randomUUID())).scope).toEqual(work.scope);
 await expect(f.prepare({...work,scope:{...work.scope,projectId:randomUUID()}},randomUUID())).rejects.toThrow('SCOPE_DENIED');
 await sqlRpc('bill2_revoke_draft',[f.actor,f.draft]);await expect(sqlRpc('bill2_claim',[f.actor,run.id,1,frozenCall()])).rejects.toThrow('DENIED');
 await expect(sqlRpc('bill2_private_input',[f.actor,run.id])).rejects.toThrow('DENIED');
 expect(JSON.stringify(await sqlRpc('bill2_read',[f.actor,run.id]))).not.toContain('private canary');
});
it.each(['rules','input','modelId','limits'])('BILL2: missing %s rejects admission without provider or reservation',async field=>{
 const f=await fixture(),bad={...f.payload} as Record<string,unknown>;delete bad[field];const before=providerCount;
 await expect(sqlRpc('bill2_prepare',[f.actor,f.request,bad])).rejects.toThrow();expect(await snapshot(f.actor)).toMatchObject({credits:100,rows:1});expect(providerCount).toBe(before);
});
it('BILL2: normal prepare/unknown/settled snapshots conserve balance and aggregate once',async()=>{
 const f=await fixture();f.payload.rules.multiplier='1.5';f.payload.limits.costUsd='0.01';const r=await f.prepare();const ids=[];
 for(let i=1;i<=3;i++){const id=await call(f.actor,r.id,i,'0.003');ids.push(id);await receipt(f.actor,r.id,id,'0.0001');}
 await expect(sqlRpc('bill2_finalize',[f.actor,r.id])).rejects.toThrow('SET_OPEN');await close(f.actor,r.id);
 expect(await sqlRpc('bill2_finalize',[f.actor,r.id])).toMatchObject({state:'settled',chargedCredits:1});
 expect(await conservation(f.actor)).toMatchObject({credits:99,spend:1,terminals:1,usage:1,rows:4});
 const before=await snapshot(f.actor);await sqlRpc('bill2_finalize',[f.actor,r.id]);await sqlRpc('bill2_cancel',[f.actor,r.id]);expect(await snapshot(f.actor)).toEqual(before);
 const ledger=(await db.query('select amount,balance_before::int,balance_after::int from credit_transactions where bill2_run_id=$1 order by case reason_code when \'bill2_reserve\' then 1 when \'bill2_release\' then 2 else 3 end',[r.id])).rows;
 expect(ledger).toEqual([{amount:-20,balance_before:100,balance_after:80},{amount:20,balance_before:80,balance_after:100},{amount:-1,balance_before:100,balance_after:99}]);
});
it.each(['settle','refund','abort_settle'])('BILL2: old atomic_%s cannot terminalize new identity',async kind=>{
 const f=await fixture(),r=await f.prepare();const pre=r.preDeductId;
 const args=kind==='settle'?[f.actor,pre,1,{},null]:kind==='refund'?[f.actor,pre,'old']:[f.actor,pre,1,{},'m','old'];
 await expect(sqlRpc('atomic_'+kind,args)).rejects.toThrow('LEGACY_FINALIZER_DENIED');expect(await conservation(f.actor)).toMatchObject({credits:80,terminals:0});
});
it('BILL2: old requests still use unchanged allocation primitives beside new holds',async()=>{
 const f=await fixture(),r=await f.prepare();const pre=(await db.query('select * from atomic_pre_deduct($1,10,$2,$3)',[f.actor,'legacy',randomUUID()])).rows[0];
 expect((await db.query('select * from atomic_settle($1,$2,4)',[f.actor,pre.pre_deduct_id])).rows[0]).toMatchObject({actual_credits:4,balance_after:76});
 await sqlRpc('bill2_cancel',[f.actor,r.id]);expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).state).toBe('refunded');
 expect((await snapshot(f.actor)).credits).toBe(96); // legacy caller still owns its own spend projection, not BILL2.
});
it('BILL2: unknown and null cost never imply zero or refund; cancellation waits for evidence',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,null);
 await sqlRpc('bill2_cancel',[f.actor,r.id]);expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).state).toBe('cost_pending');expect(await conservation(f.actor)).toMatchObject({credits:80,terminals:0});
 await receipt(f.actor,r.id,id,'0.007');expect(await sqlRpc('bill2_finalize',[f.actor,r.id])).toMatchObject({state:'settled',chargedCredits:7,outcome:'cancelled'});expect((await conservation(f.actor)).credits).toBe(93);
});
it('BILL2: confirmed no-delivery failure refunds user while late supplier costs remain evidence only',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await close(f.actor,r.id,'confirmed_failure');expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).state).toBe('refunded');
 await receipt(f.actor,r.id,id,'0.007');expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).state).toBe('refunded');expect(await conservation(f.actor)).toMatchObject({credits:100,spend:0,terminals:1,usage:0});
});
it('BILL2: conflict observations persist before/after terminal state; no last-write-wins',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,'0.007');await receipt(f.actor,r.id,id,'0.008');await close(f.actor,r.id);
 expect(await sqlRpc('bill2_finalize',[f.actor,r.id])).toMatchObject({conflict:true,chargedCredits:null});expect((await db.query('select count(*)::int n from bill2_receipts where call_id=$1',[id])).rows[0].n).toBe(2);
 expect((await conservation(f.actor)).credits).toBe(80);
 const g=await fixture(),s=await g.prepare(),cid=await call(g.actor,s.id);await receipt(g.actor,s.id,cid);await close(g.actor,s.id);await sqlRpc('bill2_finalize',[g.actor,s.id]);
 await receipt(g.actor,s.id,cid,'0.009');expect(await sqlRpc('bill2_finalize',[g.actor,s.id])).toMatchObject({state:'settled',conflict:true,chargedCredits:7});expect((await conservation(g.actor)).credits).toBe(93);
});
it('BILL2: same provider generation cannot be assigned across runs; original and rejected observations retained',async()=>{
 const a=await fixture(),b=await fixture(),ra=await a.prepare(),rb=await b.prepare(),ca=await call(a.actor,ra.id),cb=await call(b.actor,rb.id),shared='shared-'+randomUUID();
 await receipt(a.actor,ra.id,ca,'0.007',{providerId:shared});expect(await receipt(b.actor,rb.id,cb,'0.007',{providerId:shared})).toMatchObject({conflict:true});
 expect((await db.query('select count(*)::int n from bill2_provider_ids where provider_id=$1',[shared])).rows[0].n).toBe(1);
});
it('BILL2: final zero, FX conversion and Fusion included totals use precise nonoverlapping costs',async()=>{
 for(const [cost,currency,details,want] of [['0','USD',[],0],['0.005','EUR',[],10],['0.007','USD',[{cost:'0.003',currency:'USD'},{cost:'0.003',currency:'USD'}],7]] as const){
 const f=await fixture();f.payload.rules.fx={EUR:{version:'rate-v1',usdPerUnit:'2'}};const r=await f.prepare(),id=await call(f.actor,r.id,1,'0.02');
 await receipt(f.actor,r.id,id,cost,{currency,includedDetails:details});await close(f.actor,r.id);expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).chargedCredits).toBe(want);await conservation(f.actor);}
});
it.each([{currency:'EUR'},{cost:null},{coverage:'included_detail'}])('BILL2: incomplete coverage %j cannot settle',async extra=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,'0.007',extra);await close(f.actor,r.id);expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).chargedCredits).toBeNull();
});
it('BILL2: over-budget actual cost and contradictory included components quarantine instead of clipping',async()=>{
 for(const e of [{cost:'0.03'},{includedDetails:[{cost:'0.01',currency:'USD'}]}]){const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);expect(await receipt(f.actor,r.id,id,'0.007',e)).toMatchObject({conflict:true});await close(f.actor,r.id);expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).chargedCredits).toBeNull();await conservation(f.actor);}
});

async function auditState() {
 const state=(await db.query(`select
 (select coalesce(jsonb_agg(jsonb_build_object('id',id,'credits',credits) order by id),'[]') from profiles) balances,
 (select coalesce(jsonb_agg(jsonb_build_object('id',id,'consumed',consumed_amount,'status',status) order by id),'[]') from subscription_credit_grants) grants,
 (select count(*)::int from billing_history) history_rows,
 (select count(*)::int from credit_transactions) ledger_rows,
 (select coalesce(sum(amount),0)::text from credit_transactions) ledger_sum,
 (select count(*)::int from token_stats) token_rows,
 (select count(*)::int from ai_usage_logs) usage_rows,
 (select count(*)::int from bill2_runs where state in ('settled','refunded')) terminal_runs`)).rows[0];
 return {...state,providerCount,lookupCount};
}
// Two independent backend processes overlap behind an observed database lock, not sequential Promise calls.
async function overlap(label:string,lockSql:string,lockArgs:unknown[],first:(c:pg.Client)=>Promise<unknown>,second:(c:pg.Client)=>Promise<unknown>) {
 const before=await auditState();const a=new pg.Client({connectionString}),b=new pg.Client({connectionString});await a.connect();await b.connect();
 try {await a.query('begin');await a.query("set local statement_timeout='5s'");await b.query("set statement_timeout='5s'");
 const pa=(await a.query('select pg_backend_pid() pid')).rows[0].pid,pb=(await b.query('select pg_backend_pid() pid')).rows[0].pid;expect(pa).not.toBe(pb);
 await a.query(lockSql,lockArgs);
 const pending=second(b).then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));
 let blocked=false;for(let i=0;i<100;i++){const state=(await db.query('select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1',[pb])).rows[0];
 if(state?.wait_event_type==='Lock'&&state.blockers.includes(pa)){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
 expect(blocked).toBe(true);const value=await first(a);await a.query('commit');const other=await pending;
 events.push({label,backendPids:[pa,pb],barrierObserved:blocked,secondSucceeded:other.ok,before,after:await auditState()});return {value,other};
 }finally{await a.query('rollback');await a.end();await b.end();}
}
it('BILL2: overlapping duplicate prepare and competing balances reserve exactly once',async()=>{
 const f=await fixture();const same=await overlap('prepare/prepare same identity','select pg_advisory_xact_lock(hashtextextended($1,105))',[f.actor+f.request],c=>f.prepare(f.payload,f.request,c),c=>f.prepare(f.payload,f.request,c));
 expect(same.other).toMatchObject({ok:true,value:same.value});expect(await conservation(f.actor)).toMatchObject({credits:80,rows:2});
 const g=await fixture();g.payload.limits={...g.payload.limits,credits:80,maxPreDeduct:80,costUsd:'0.08'};
 const competing=await overlap('prepare/prepare last balance','select id from profiles where id=$1 for update',[g.actor],c=>g.prepare(g.payload,g.request,c),c=>g.prepare(g.payload,randomUUID(),c));
 expect(competing.other.ok).toBe(false);expect(await conservation(g.actor)).toMatchObject({credits:20,rows:2});
});
it('BILL2: overlapping sequence claims cannot double allocate the remaining call budget',async()=>{
 const f=await fixture(),r=await f.prepare();const q=()=>[f.actor,r.id,1,frozenCall(1,'0.02')];
 const race=await overlap('claim/claim','select id from bill2_runs where id=$1 for update',[r.id],c=>sqlRpc('bill2_claim',q(),c),c=>sqlRpc('bill2_claim',q(),c));
 expect(race.other).toMatchObject({ok:true,value:{dispatchToken:null}});expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[r.id])).rows[0].n).toBe(1);
 await expect(sqlRpc('bill2_claim',[f.actor,r.id,2,frozenCall(2)])).rejects.toThrow('BUDGET');
});
it('BILL2: prepared token rotation wins over a concurrent stale dispatch; close wins over claim',async()=>{
 const f=await fixture(),r=await f.prepare(),q=frozenCall(),c=await sqlRpc('bill2_claim',[f.actor,r.id,1,q]);
 const race=await overlap('rotation/stale dispatch','select id from bill2_runs where id=$1 for update',[r.id],a=>sqlRpc('bill2_dispatch',[f.actor,r.id,c.id,null,true,q],a),b=>sqlRpc('bill2_dispatch',[f.actor,r.id,c.id,c.dispatchToken],b));
 expect(race.other).toMatchObject({ok:true,value:{dispatch:false}});
 const closeRace=await overlap('cancel/dispatch','select id from bill2_runs where id=$1 for update',[r.id],a=>sqlRpc('bill2_cancel',[f.actor,r.id],a),b=>sqlRpc('bill2_dispatch',[f.actor,r.id,c.id,(race.value as {dispatchToken:string}).dispatchToken],b));
 expect(closeRace.other).toMatchObject({ok:true,value:{dispatch:false}});await sqlRpc('bill2_finalize',[f.actor,r.id]);expect((await conservation(f.actor)).credits).toBe(100);
 const g=await fixture(),s=await g.prepare();const claimRace=await overlap('close/claim','select id from bill2_runs where id=$1 for update',[s.id],a=>sqlRpc('bill2_close',[g.actor,s.id,'unknown',null],a),b=>sqlRpc('bill2_claim',[g.actor,s.id,1,q],b));expect(claimRace.other.ok).toBe(false);
});
it.each(['finalize','cancel'])('BILL2: overlapping finalize/%s commits one terminal and one projection',async op=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id);await close(f.actor,r.id);
 const race=await overlap('finalize/'+op,'select id from bill2_runs where id=$1 for update',[r.id],c=>sqlRpc('bill2_finalize',[f.actor,r.id],c),c=>sqlRpc('bill2_'+op,[f.actor,r.id],c));
 expect(race.other).toMatchObject({ok:true,value:{state:'settled'}});expect(await conservation(f.actor)).toMatchObject({credits:93,rows:4,terminals:1,usage:1});
});
it('BILL2: overlapping refund/late receipt does not recharge a confirmed failure',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await close(f.actor,r.id,'confirmed_failure');
 const evidence=fixtureEvidence('{"id":"late-'+id+'","model":"m","final":true,"cost":0.007,"currency":"USD","coverage":"request_total"}',frozenCall(),'response');
 const race=await overlap('refund/late receipt','select id from bill2_runs where id=$1 for update',[r.id],c=>sqlRpc('bill2_finalize',[f.actor,r.id],c),c=>sqlRpc('bill2_record',[f.actor,r.id,id,evidence],c));
 expect(race.other).toMatchObject({ok:true,value:{state:'refunded'}});expect(await conservation(f.actor)).toMatchObject({credits:100,spend:0,terminals:1,usage:0});
});
it.each(['profiles','billing_history','credit_transactions','token_stats','ai_usage_logs','bill2_runs'])('BILL2: injected failure after %s write rolls back the entire terminal transaction',async table=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id);await close(f.actor,r.id);const before=await snapshot(f.actor),count=providerCount;
 const filter=table==='profiles'?`NEW.id='${f.actor}'`:table==='bill2_runs'?`NEW.id='${r.id}'`: `NEW.user_id='${f.actor}'`;
 await db.query(`create function bill2_test_fault() returns trigger language plpgsql as $$ begin if ${filter} then raise exception 'injected_terminal_fault'; end if;return NEW;end $$;
 create trigger bill2_test_fault after insert or update on ${table} for each row execute function bill2_test_fault()`);
 try{await expect(sqlRpc('bill2_finalize',[f.actor,r.id])).rejects.toThrow('injected_terminal_fault');expect(await snapshot(f.actor)).toEqual(before);events.push({faultAfterWrite:table,before,afterRollback:await snapshot(f.actor),providerCount});expect((await sqlRpc('bill2_read',[f.actor,r.id])).chargedCredits).toBeNull();}
 finally{await db.query(`drop trigger bill2_test_fault on ${table};drop function bill2_test_fault()`);}
 await sqlRpc('bill2_finalize',[f.actor,r.id]);await sqlRpc('bill2_finalize',[f.actor,r.id]);expect(await conservation(f.actor)).toMatchObject({credits:93,terminals:1,usage:1,rows:4});expect(providerCount).toBe(count);events.push({recoveredFault:table,afterRecovery:await snapshot(f.actor),providerCount});
});
it('BILL2: RPC privilege boundary denies anonymous, user and private legacy entrypoints',async()=>{
 for(const role of ['anon','authenticated','service_role']){const c=new pg.Client({connectionString});await c.connect();try{await c.query('set role '+role);
 await expect(c.query('select * from bill2_runs')).rejects.toThrow('permission denied');await expect(c.query('select public.bill2_legacy_refund($1,$2)',[randomUUID(),randomUUID()])).rejects.toThrow('permission denied');
 if(role!=='service_role')await expect(c.query('select public.bill2_create_draft($1)',[randomUUID()])).rejects.toThrow('permission denied');
 }finally{await c.end();}}
 const f=await fixture(),r=await f.prepare();await expect(sqlRpc('bill2_read',[await user(),r.id])).rejects.toThrow('DENIED');
 const service=authoritativeBilling({admin,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)});expect(await service.readRun(r.id)).toMatchObject({reservedCredits:20});
});
it('BILL2: real loopback HTTP dispatch has one committed token and one request; polling is read-only',async()=>{
 const f=await fixture(),s=authoritativeBilling({admin,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)}),r=await s.prepareRun(f.request,f.payload),c=await s.claimCall(r.id,1,frozenCall());
 raw='{"id":"http-'+c.id+'","model":"m","final":true,"cost":0.007,"currency":"USD","coverage":"request_total"}';const before=providerCount;
 await expect(s.dispatchOnce(c.id,'wrong')).rejects.toThrow('REQUEST_CONFLICT');await s.dispatchOnce(c.id,'hello');expect(await s.dispatchOnce(c.id,'hello')).toEqual({dispatched:false});expect(providerCount-before).toBe(1);
 const callsBefore=lookupCount;await s.readRun(r.id);await s.readRun(r.id);expect(lookupCount).toBe(callsBefore);await s.closeRun(r.id,'delivered',result());await s.finalizeRun(r.id);expect((await conservation(f.actor)).credits).toBe(93);
});
it('BILL2: lost dispatch commit response never sends HTTP or permits redispatch',async()=>{
 const f=await fixture();let lose=true;
 const uncertain={rpc:async(name:string,args:Record<string,unknown>)=>{const response=await admin.rpc(name,args);if(name==='bill2_dispatch'&&lose){lose=false;expect(response.error).toBeNull();return {data:null,error:new Error('lost commit response')};}return response;}};
 const s=authoritativeBilling({admin:uncertain,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)}),r=await s.prepareRun(f.request,f.payload),c=await s.claimCall(r.id,1,frozenCall()),before=providerCount;
 await expect(s.dispatchOnce(c.id,'hello')).rejects.toThrow('UNAVAILABLE');expect((await db.query('select state from bill2_calls where id=$1',[c.id])).rows[0].state).toBe('dispatched');
 expect(await s.dispatchOnce(c.id,'hello')).toEqual({dispatched:false});expect(await s.rotatePrepared(r.id,c.id,frozenCall())).toBe(false);await s.recoverRun(r.id);expect(providerCount).toBe(before);expect((await conservation(f.actor)).credits).toBe(80);
});
it('BILL2: recovery only uses a captured provider ID and is bounded to three requests',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id),s=authoritativeBilling({admin,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)});
 const before=lookupCount;await s.recoverRun(r.id);expect(lookupCount).toBe(before);await receipt(f.actor,r.id,id,null);
 raw='{"id":"generation-'+id+'","model":"m","final":false,"cost":null,"currency":"USD","coverage":"request_total"}';
 for(let i=0;i<5;i++)await s.recoverRun(r.id);expect(lookupCount-before).toBe(3);expect((await conservation(f.actor)).credits).toBe(80);
});
it('BILL2: existing readiness audit sees coherent new holds and terminal ledger rows',async()=>{
 for(const finish of [false,true]){const f=await fixture(),r=await f.prepare();if(finish){const id=await call(f.actor,r.id);await receipt(f.actor,r.id,id);await close(f.actor,r.id);await sqlRpc('bill2_finalize',[f.actor,r.id]);}
 const audit=buildBillingEngineV15ReadinessAudit({profiles:(await db.query('select * from profiles where id=$1',[f.actor])).rows,creditTransactions:(await db.query('select * from credit_transactions where user_id=$1',[f.actor])).rows,billingHistory:(await db.query('select * from billing_history where user_id=$1',[f.actor])).rows,paymentOrders:[],subscriptionCreditGrants:[],subscriptions:[]});
 expect(audit.findings.filter(x=>x.severity==='error').map(x=>x.code)).toEqual(finish?[]:['billing_reservation_unresolved']);}
});
it.each(['success','failure','abort'])('BILL2: direct legacy AI %s finalizer cannot consume a new pre-deduction',async kind=>{
 const f=await fixture(),r=await f.prepare();const args=kind==='failure'?[f.actor,'m','old',r.preDeductId]:[f.actor,randomUUID(),'user','response','m','0.001',1,r.preDeductId];
 await expect(sqlRpc('atomic_finalize_ai_'+kind,args)).rejects.toThrow('LEGACY_FINALIZER_DENIED');expect(await conservation(f.actor)).toMatchObject({credits:80,terminals:0,usage:0});
});
it('BILL2: frozen call policies reject alternate model and increased capacity before dispatch',async()=>{
 const f=await fixture(),r=await f.prepare();for(const patch of [{model:'another'},{provider:'other'},{account:'other'},{inputLimit:1001},{outputLimit:1001}])await expect(sqlRpc('bill2_claim',[f.actor,r.id,1,{...frozenCall(),...patch}])).rejects.toThrow('CONTRACT');
 expect((await db.query('select count(*)::int n from bill2_calls where run_id=$1',[r.id])).rows[0].n).toBe(0);
});
it('BILL2: draft revocation and dispatch are serialized on a real shared scope lock',async()=>{
 const f=await fixture(),r=await f.prepare(),c=await sqlRpc('bill2_claim',[f.actor,r.id,1,frozenCall()]);
 const race=await overlap('scope revoke/dispatch','select id from bill2_drafts where id=$1 for update',[f.draft],a=>sqlRpc('bill2_revoke_draft',[f.actor,f.draft],a),b=>sqlRpc('bill2_dispatch',[f.actor,r.id,c.id,c.dispatchToken],b));
 expect(race.other.ok).toBe(false);await sqlRpc('bill2_cancel',[f.actor,r.id]);await sqlRpc('bill2_finalize',[f.actor,r.id]);expect((await conservation(f.actor)).credits).toBe(100);
});
it('BILL2: final null cost is supplemented and numerically identical decimal forms are not conflicts',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,null,{final:true});await receipt(f.actor,r.id,id,'0.007');await receipt(f.actor,r.id,id,'0.0070');await close(f.actor,r.id);
 expect(await sqlRpc('bill2_finalize',[f.actor,r.id])).toMatchObject({state:'settled',conflict:false,chargedCredits:7});await conservation(f.actor);
});
it('BILL2: malformed monetary response retains its provider ID and raw evidence without charging',async()=>{
 const f=await fixture(),s=authoritativeBilling({admin,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)}),r=await s.prepareRun(f.request,f.payload),c=await s.claimCall(r.id,1,frozenCall());
 raw='{"id":"bad-'+c.id+'","model":"m","final":true,"cost":-1,"currency":"USD","coverage":"request_total"}';await s.dispatchOnce(c.id,'hello');
 const e=(await db.query('select payload from bill2_receipts where call_id=$1',[c.id])).rows[0].payload;expect(e).toMatchObject({providerId:'bad-'+c.id,rejectedReason:'invalid_protocol_receipt',rawBody:raw,cost:null});expect((await s.readRun(r.id)).conflict).toBe(true);expect((await conservation(f.actor)).credits).toBe(80);
});
it('BILL2: lookup identity mismatch persists a conflicting observation and cannot settle',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,null);const s=authoritativeBilling({admin,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)});
 raw='{"id":"wrong-'+id+'","model":"m","final":true,"cost":0.007,"currency":"USD","coverage":"request_total"}';expect((await s.recoverRun(r.id)).conflict).toBe(true);
 expect((await db.query('select count(*)::int n from bill2_receipts where call_id=$1',[id])).rows[0].n).toBe(2);expect((await conservation(f.actor)).credits).toBe(80);
});
it('BILL2: receipt database outage retains server-private evidence and recovery never redispatches',async()=>{
 const f=await fixture();let fail=true;const faulty={rpc:async(name:string,args:Record<string,unknown>)=>name==='bill2_record'&&fail?{data:null,error:{code:'unavailable'}}:admin.rpc(name,args)};
 const s=authoritativeBilling({admin:faulty,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)}),r=await s.prepareRun(f.request,f.payload),c=await s.claimCall(r.id,1,frozenCall());
 raw='{"id":"recover-'+c.id+'","model":"m","final":true,"cost":0.007,"currency":"USD","coverage":"request_total"}';const before=providerCount,out=await s.dispatchOnce(c.id,'hello');expect(out.pendingReceipt?.evidence).toMatchObject({providerId:'recover-'+c.id});fail=false;
 await s.recordReceipt(r.id,c.id,out.pendingReceipt!.evidence);await s.closeRun(r.id,'delivered',result());await s.finalizeRun(r.id);expect(providerCount-before).toBe(1);expect((await conservation(f.actor)).credits).toBe(93);
});
async function period(actor:string,credits=100) {
 const grant=randomUUID(),subscription='sub_'+randomUUID(),plan=randomUUID(),invoice='in_'+randomUUID(),start=new Date(Date.now()-86400000).toISOString(),end=new Date(Date.now()+86400000).toISOString();
 await db.query("insert into user_subscriptions(user_id,stripe_subscription_id,membership_plan_id,billing_cycle,current_period_start,current_period_end) values($1,$2,$3,'monthly',$4,$5)",[actor,subscription,plan,start,end]);
 await db.query("insert into subscription_credit_grants(id,user_id,stripe_subscription_id,membership_plan_id,billing_cycle,grant_type,grant_period_key,period_start,period_end,total_periods,stripe_invoice_id,credits_granted) values($1,$2,$3,$4,'monthly','monthly_invoice',$5,$6,$7,1,$8,$9)",[grant,actor,subscription,plan,'invoice:'+invoice,start,end,invoice,credits]);return {grant,subscription};
}
it.each(['normal','cross-period','reversed','terminated'])('BILL2: %s source allocation preserves original grant and actual restoration',async state=>{
 const f=await fixture(),g=await period(f.actor,12),r=await f.prepare(),id=await call(f.actor,r.id);expect((await db.query('select consumed_amount from subscription_credit_grants where id=$1',[g.grant])).rows[0].consumed_amount).toBe(12);
 if(state==='cross-period')await db.query("update user_subscriptions set current_period_start=now()+interval '1 day',current_period_end=now()+interval '31 days' where stripe_subscription_id=$1",[g.subscription]);
 if(state==='reversed')await db.query("update subscription_credit_grants set status='reversed' where id=$1",[g.grant]);
 if(state==='terminated')await db.query("update user_subscriptions set credit_release_terminated_at=now() where stripe_subscription_id=$1",[g.subscription]);
 await receipt(f.actor,r.id,id,'0.007');await close(f.actor,r.id);const terminal=await sqlRpc('bill2_finalize',[f.actor,r.id]),intercepted=['reversed','terminated'].includes(state);
 expect(terminal).toMatchObject({chargedCredits:7,actualRestoredCredits:intercepted?8:13});expect((await conservation(f.actor)).credits).toBe(intercepted?88:93);
 expect((await db.query('select consumed_amount from subscription_credit_grants where id=$1',[g.grant])).rows[0].consumed_amount).toBe(intercepted?12:7);
 const meta=(await db.query("select metadata from credit_transactions where bill2_run_id=$1 and reason_code='bill2_release'",[r.id])).rows[0].metadata;expect(meta).toMatchObject({chargedGrantId:g.grant,amountToPeriod:12,amountToOther:8,intercepted:intercepted?5:0});
});
it('BILL2: refunded source never resurrects subscription credits; quarantine blocks new admission',async()=>{
 const f=await fixture(),g=await period(f.actor,12),r=await f.prepare();await db.query("update subscription_credit_grants set status='reversed' where id=$1",[g.grant]);await sqlRpc('bill2_cancel',[f.actor,r.id]);expect((await sqlRpc('bill2_finalize',[f.actor,r.id])).actualRestoredCredits).toBe(8);expect((await conservation(f.actor)).credits).toBe(88);
 const q=await fixture(),h=await period(q.actor);await db.query("update subscription_credit_grants set accounting_state='review_required',period_end=now()-interval '1 hour' where id=$1",[h.grant]);await expect(q.prepare()).rejects.toThrow();expect((await snapshot(q.actor)).credits).toBe(100);
});
it('BILL2: concurrent subscription termination takes the legacy profile/grant order before settlement',async()=>{
 const f=await fixture(),g=await period(f.actor,12),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id);await close(f.actor,r.id);
 const race=await overlap('termination/finalize','select id from profiles where id=$1 for update',[f.actor],async a=>{await a.query('select id from subscription_credit_grants where id=$1 for update',[g.grant]);await a.query('update user_subscriptions set credit_release_terminated_at=now() where stripe_subscription_id=$1',[g.subscription]);return true;},b=>sqlRpc('bill2_finalize',[f.actor,r.id],b));
 expect(race.other).toMatchObject({ok:true,value:{state:'settled',chargedCredits:7,actualRestoredCredits:8}});expect(await conservation(f.actor)).toMatchObject({credits:88,terminals:1,usage:1});
});
it('BILL2: complete outcome versus failure and unknown versus recovery serialize without duplicate money',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id);
 const race=await overlap('settle/refund intent','select id from bill2_runs where id=$1 for update',[r.id],async a=>{await sqlRpc('bill2_close',[f.actor,r.id,'delivered',result()],a);return sqlRpc('bill2_finalize',[f.actor,r.id],a);},async b=>{await sqlRpc('bill2_close',[f.actor,r.id,'confirmed_failure',result('confirmed_failure')],b);return sqlRpc('bill2_finalize',[f.actor,r.id],b);});
 expect(race.other).toMatchObject({ok:true,value:{state:'settled',chargedCredits:7}});expect(await conservation(f.actor)).toMatchObject({credits:93,terminals:1,usage:1});
 const u=await fixture(),v=await u.prepare(),cid=await call(u.actor,v.id);await receipt(u.actor,v.id,cid,null);await sqlRpc('bill2_close',[u.actor,v.id,'unknown',null]);
 const e=fixtureEvidence('{"id":"generation-'+cid+'","model":"m","final":true,"cost":0.007,"currency":"USD","coverage":"request_total"}',frozenCall(),'lookup');
 const recover=await overlap('unknown/recover','select id from bill2_runs where id=$1 for update',[v.id],a=>sqlRpc('bill2_finalize',[u.actor,v.id],a),async b=>{await sqlRpc('bill2_record',[u.actor,v.id,cid,e],b);await sqlRpc('bill2_close',[u.actor,v.id,'delivered',result()],b);return sqlRpc('bill2_finalize',[u.actor,v.id],b);});expect(recover.other).toMatchObject({ok:true,value:{state:'settled'}});expect(await conservation(u.actor)).toMatchObject({credits:93,terminals:1,usage:1});
});
it('BILL2: revoked fixed Skill and disabled model block new execution but preserve financial recovery',async()=>{
 const f=await fixture(),owner=await user(),pack=makePackage(),module=randomUUID();await db.query("update profiles set role='admin' where id=$1",[owner]);
 await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'bill2-'+pack.id,owner]);await db.query("insert into modules(id,title,skill_id,active) values($1,'BILL2 package',$2,true)",[module,pack.id]);await publishSkillPackage(admin,owner,pack);
 f.payload={...f.payload,moduleId:module,skillId:pack.id,revisionId:pack.revisionId};const r=await f.prepare(f.payload),c=await sqlRpc('bill2_claim',[f.actor,r.id,1,frozenCall()]);
 const race=await overlap('revision revoke/dispatch','select id from skill_revisions where id=$1 for update',[pack.revisionId],a=>sqlRpc('revoke_skill_revision',[pack.revisionId,owner],a),b=>sqlRpc('bill2_dispatch',[f.actor,r.id,c.id,c.dispatchToken],b));expect(race.other.ok).toBe(false);
 await expect(f.prepare(f.payload,randomUUID())).rejects.toThrow();await sqlRpc('bill2_cancel',[f.actor,r.id]);await sqlRpc('bill2_finalize',[f.actor,r.id]);expect((await conservation(f.actor)).credits).toBe(100);
 const g=await fixture(),s=await g.prepare(),q=await sqlRpc('bill2_claim',[g.actor,s.id,1,frozenCall()]);await db.query("update ai_models set is_active='false' where id=$1",[modelId]);try{await expect(sqlRpc('bill2_dispatch',[g.actor,s.id,q.id,q.dispatchToken])).rejects.toThrow('POLICY_DENIED');}finally{await db.query("update ai_models set is_active='true' where id=$1",[modelId]);}
});
it('BILL2: verified local Auth identity uses the same server service; client cannot invoke privileged RPC',async()=>{
 const email=randomUUID()+'@example.test',password='Local-'+randomUUID()+'!',created=await admin.auth.admin.createUser({email,password,email_confirm:true});expect(created.error).toBeNull();const actor=created.data.user!.id;
 await db.query('insert into profiles(id,email,credits) values($1,$2,100)',[actor,email]);await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,100,'addition','grant','opening_grant','system',$2,0,100)",[actor,'opening_grant:'+actor]);
 const client=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});expect((await client.auth.signInWithPassword({email,password})).error).toBeNull();
 const s=authoritativeBilling({admin,actor:async()=>{const u=await client.auth.getUser();if(u.error||!u.data.user)throw new Error('unauthenticated');return u.data.user.id;},adapter:localFixtureAdapter(endpoint)});const draft=await s.createDraft();expect((await sqlRpc('bill2_read',[actor,(await s.prepareRun(randomUUID(),{...(await fixture()).payload,scope:{kind:'positioning_draft',draftId:draft}})).id])).reservedCredits).toBe(20);
 expect((await client.rpc('bill2_create_draft',{p_actor_id:actor})).error).not.toBeNull();expect((await client.from('bill2_receipts').select('*')).error).not.toBeNull();await client.auth.signOut();await expect(s.createDraft()).rejects.toThrow('unauthenticated');
});
it('BILL2: failed call insertion and lost claim response preserve one identity and permit only prepared rotation',async()=>{
 const f=await fixture(),r=await f.prepare();await db.query(`create function bill2_test_claim_fault() returns trigger language plpgsql as $$ begin raise exception 'claim_identity_fault';end $$;create trigger bill2_test_claim_fault after insert on bill2_calls for each row execute function bill2_test_claim_fault()`);
 const s=authoritativeBilling({admin,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)}),before=providerCount;
 try{await expect(s.claimCall(r.id,1,frozenCall())).rejects.toThrow('UNAVAILABLE');}finally{await db.query('drop trigger bill2_test_claim_fault on bill2_calls;drop function bill2_test_claim_fault()');}
 let saved:string|null=null;const lose={rpc:async(name:string,args:Record<string,unknown>)=>{const response=await admin.rpc(name,args);if(name==='bill2_claim'){saved=(response.data as {id:string}).id;return {data:null,error:{code:'lost'}};}return response;}};
 const restart=authoritativeBilling({admin:lose,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)});await expect(restart.claimCall(r.id,1,frozenCall())).rejects.toThrow('UNAVAILABLE');expect(providerCount).toBe(before);
 expect((await s.claimCall(r.id,1,frozenCall())).id).toBe(saved);expect(await s.dispatchOnce(saved!,'hello')).toEqual({dispatched:false});expect(await s.rotatePrepared(r.id,saved!,frozenCall())).toBe(true);
 raw='{"id":null,"model":"m","final":false,"cost":null,"currency":"USD","coverage":"request_total"}';await s.dispatchOnce(saved!,'hello');await s.recoverRun(r.id);expect(providerCount-before).toBe(1);expect((await s.readRun(r.id)).state).toBe('unknown');expect((await conservation(f.actor)).credits).toBe(80);
});
it('BILL2: immutable receipts and stable call set survive service recreation and code rollback to legacy callers',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,null);const evidence=(await db.query('select id from bill2_receipts where call_id=$1',[id])).rows[0].id;
 await expect(db.query('delete from bill2_receipts where id=$1',[evidence])).rejects.toThrow('IMMUTABLE');await expect(db.query("update bill2_receipts set payload='{}' where id=$1",[evidence])).rejects.toThrow('IMMUTABLE');
 // Legacy code still operates independent old IDs while these rows remain durable. No down migration occurs.
 const other=await user(),pre=(await db.query('select * from atomic_pre_deduct($1,10,$2,$3)',[other,'old code',randomUUID()])).rows[0];await db.query('select * from atomic_refund($1,$2)',[other,pre.pre_deduct_id]);
 const restarted=authoritativeBilling({admin,actor:async()=>f.actor,adapter:localFixtureAdapter(endpoint)});expect((await restarted.readPrivateInput(r.id)) as object).toMatchObject({input:f.payload.input});raw='{"id":"generation-'+id+'","model":"m","final":true,"cost":0.007,"currency":"USD","coverage":"request_total"}';await restarted.closeRun(r.id,'delivered',result());await restarted.recoverRun(r.id);expect(await conservation(f.actor)).toMatchObject({credits:93,terminals:1,usage:1});
});
it('BILL2: existing Skill prepare replay and dispatch share run-first lock order',async()=>{
 const f=await fixture(),owner=await user(),pack=makePackage(),module=randomUUID();await db.query("update profiles set role='admin' where id=$1",[owner]);await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'bill2-'+pack.id,owner]);await db.query("insert into modules(id,title,skill_id,active) values($1,'BILL2 concurrent package',$2,true)",[module,pack.id]);await publishSkillPackage(admin,owner,pack);
 const payload={...f.payload,moduleId:module,skillId:pack.id,revisionId:pack.revisionId},r=await f.prepare(payload),c=await sqlRpc('bill2_claim',[f.actor,r.id,1,frozenCall()]);
 const race=await overlap('dispatch/prepare replay revision','select id from bill2_runs where id=$1 for update',[r.id],a=>sqlRpc('bill2_dispatch',[f.actor,r.id,c.id,c.dispatchToken],a),b=>f.prepare(payload,f.request,b));expect(race.other).toMatchObject({ok:true,value:{state:'dispatched'}});expect(await conservation(f.actor)).toMatchObject({credits:80,rows:2});
});
it('BILL2: concurrent actor suspension prevents a later dispatch commit',async()=>{
 const f=await fixture(),r=await f.prepare(),c=await sqlRpc('bill2_claim',[f.actor,r.id,1,frozenCall()]);const race=await overlap('suspend/dispatch','select id from profiles where id=$1 for update',[f.actor],a=>a.query("update profiles set status='suspended' where id=$1",[f.actor]),b=>sqlRpc('bill2_dispatch',[f.actor,r.id,c.id,c.dispatchToken],b));expect(race.other.ok).toBe(false);expect((await db.query('select state from bill2_calls where id=$1',[c.id])).rows[0].state).toBe('prepared');
 await sqlRpc('bill2_cancel',[f.actor,r.id]);await sqlRpc('bill2_finalize',[f.actor,r.id]);expect((await conservation(f.actor)).credits).toBe(100);
});
async function socialWork() {
 const f=await fixture(),owner=await user(),pack=makePackage(),module=randomUUID(),parent=randomUUID(),item=randomUUID(),sourceRound=randomUUID(),targetRound=randomUUID(),evidence=randomUUID(),refEvidence=randomUUID(),version=randomUUID(),config='bill2-'+randomUUID(),account='test:'+randomUUID();
 await db.query("update profiles set role='admin' where id=$1",[owner]);await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'bill2-'+pack.id,owner]);await db.query("insert into modules(id,title,skill_id,active) values($1,'BILL2 social source',$2,true)",[module,pack.id]);await publishSkillPackage(admin,owner,pack);
 const sf=makeWorkflow(6,true),tf=makeWorkflow(2),sourceFlow='src-'+randomUUID(),targetFlow='dst-'+randomUUID();
 for(const [id,flow] of [[sourceFlow,sf],[targetFlow,tf]])await db.query("insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled) values($1,$2,$3,$4,$5,'BILL2 reference',true)",[id,module,pack.id,pack.revisionId,flow]);
 await db.query('insert into artifact_accounts values($1,$2,$3,$4)',[f.actor,module,pack.id,account]);await db.query('insert into artifact_projects(id,actor_id,module_id,skill_id,account) values($1,$2,$3,$4,$5)',[parent,f.actor,module,pack.id,account]);await db.query("insert into artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id) values($1,$2,$3,$4,'script',$5)",[item,f.actor,module,pack.id,parent]);
 for(const [id,project,flow] of [[sourceRound,parent,sf],[targetRound,item,tf]])await db.query("insert into artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps) values($1,$2,$3,$4,$5,$6,$6,'published','{}')",[id,project,pack.revisionId,pack.descriptor.packageHash,flow,hash('workflow')]);
 for(const [id,project] of [[evidence,parent],[refEvidence,item]]){await db.query("insert into artifact_evidence(id,project_id,kind,payload,content_hash) values($1,$2,'user','{}',$3)",[id,project,hash('source')]);await db.query('insert into artifact_evidence_restrictions(evidence_id) values($1)',[id]);}
 await db.query("insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) values($1,$2,$3,1,'{}',$4,$5)",[version,parent,sourceRound,hash('source'),JSON.stringify([evidence])]);
 await db.query("insert into artifact_reference_configs values($1,$2,$3,'[\"step-0\"]',20000,true)",[config,sourceFlow,targetFlow]);await db.query("insert into artifact_work_references values($1,$2,$3,$4,$5,'[\"step-0\"]',$6,$7,'{}')",[targetRound,item,refEvidence,version,config,hash('source'),randomUUID()]);
 const payload={...f.payload,operation:'work' as const,scope:{kind:'work_item' as const,projectId:parent,workItemId:item}},run=await f.prepare(payload),c=await sqlRpc('bill2_claim',[f.actor,run.id,1,frozenCall()]);return {f,parent,item,module,skill:pack.id,sourceRound,evidence,config,account,run,c};
}
it.each(['source','config','account'])('BILL2: live social %s revocation blocks a concurrent dispatch without new money',async kind=>{
 const t=await socialWork();const lock=kind==='source'?'select id from artifact_projects where id=$1 for update':kind==='config'?'select id from artifact_reference_configs where id=$1 for update':'select actor_id from artifact_accounts where actor_id=$1 for update';const key=kind==='source'?t.parent:kind==='config'?t.config:t.f.actor;
 const race=await overlap('social '+kind+'/dispatch',lock,[key],async a=>{
 if(kind==='source')return sqlRpc('artifact_transition',[t.f.actor,t.module,t.skill,'restrictEvidence',t.parent,t.sourceRound,randomUUID(),{evidenceId:t.evidence,deleted:true,expiresAt:null}],a);
 if(kind==='config')return a.query('update artifact_reference_configs set enabled=false where id=$1',[t.config]);return a.query('delete from artifact_accounts where actor_id=$1',[t.f.actor]);
 },b=>sqlRpc('bill2_dispatch',[t.f.actor,t.run.id,t.c.id,t.c.dispatchToken],b));expect(race.other.ok).toBe(false);await sqlRpc('bill2_cancel',[t.f.actor,t.run.id]);await sqlRpc('bill2_finalize',[t.f.actor,t.run.id]);expect((await conservation(t.f.actor)).credits).toBe(100);
});
it('BILL2: maximum real INT balance permits wider intermediate release snapshots without overflow',async()=>{
 const f=await fixture(2147483647),r=await f.prepare(),id=await call(f.actor,r.id);await db.query('update profiles set credits=credits+7 where id=$1',[f.actor]);await db.query("insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,idempotency_key,balance_before,balance_after) values($1,7,'addition','grant','test_grant','system',$2,2147483627,2147483634)",[f.actor,randomUUID()]);await receipt(f.actor,r.id,id);await close(f.actor,r.id);await sqlRpc('bill2_finalize',[f.actor,r.id]);
 expect((await conservation(f.actor)).credits).toBe(2147483647);expect((await db.query("select balance_after::text from credit_transactions where bill2_run_id=$1 and reason_code='bill2_release'",[r.id])).rows[0].balance_after).toBe('2147483654');
});
it('BILL2: canonical usage aggregates only reported integer counters and preserves unknown fields',async()=>{
 const f=await fixture(),r=await f.prepare();for(let i=1;i<=2;i++){const id=await call(f.actor,r.id,i);await receipt(f.actor,r.id,id,'0.001',{usage:{inputTokens:'10',outputTokens:'3',cachedTokens:'0',webSearchCount:'1'}});}await close(f.actor,r.id);await sqlRpc('bill2_finalize',[f.actor,r.id]);
 expect((await db.query('select input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count from token_stats where bill2_run_id=$1',[r.id])).rows[0]).toEqual({input_tokens:20,output_tokens:6,cached_tokens:0,cache_creation_tokens:null,web_search_count:2});
});
it.each([true,false])('BILL2: separate included detail conflicts with parent total in either order, total first=%s',async totalFirst=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);const total=()=>receipt(f.actor,r.id,id,'0.007');const detail=()=>receipt(f.actor,r.id,id,'0.010',{coverage:'included_detail',detailId:'child-1'});
 if(totalFirst){await total();await detail();}else{await detail();await total();}await close(f.actor,r.id);expect(await sqlRpc('bill2_finalize',[f.actor,r.id])).toMatchObject({conflict:true,chargedCredits:null});expect((await conservation(f.actor)).credits).toBe(80);
});
it('BILL2: stable separate details deduplicate, sum distinctly and never add to inline details',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,'0.003',{coverage:'included_detail',detailId:'child-1'});await receipt(f.actor,r.id,id,'0.0030',{coverage:'included_detail',detailId:'child-1'});await receipt(f.actor,r.id,id,'0.003',{coverage:'included_detail',detailId:'child-2'});
 await receipt(f.actor,r.id,id,'0.007',{includedDetails:[{cost:'0.003',currency:'USD'},{cost:'0.003',currency:'USD'}]});await close(f.actor,r.id);expect(await sqlRpc('bill2_finalize',[f.actor,r.id])).toMatchObject({chargedCredits:7,conflict:false});
 const g=await fixture(),s=await g.prepare(),cid=await call(g.actor,s.id);await receipt(g.actor,s.id,cid,'0.004',{coverage:'included_detail',detailId:'a'});await receipt(g.actor,s.id,cid,'0.004',{coverage:'included_detail',detailId:'b'});await receipt(g.actor,s.id,cid,'0.007');await close(g.actor,s.id);expect((await sqlRpc('bill2_finalize',[g.actor,s.id])).conflict).toBe(true);
});

it.each(['suspended','deleted'])('BILL2: concurrent actor %s prevents a new reservation',async state=>{
 const f=await fixture();const before=await snapshot(f.actor);const race=await overlap('actor '+state+'/prepare','select id from profiles where id=$1 for update',[f.actor],a=>a.query(state==='suspended'?"update profiles set status='suspended' where id=$1":"update profiles set is_deleted='true' where id=$1",[f.actor]),b=>f.prepare(f.payload,f.request,b));
 expect(race.other.ok).toBe(false);expect(await snapshot(f.actor)).toEqual(before);expect((await db.query('select count(*)::int n from bill2_runs where actor_id=$1',[f.actor])).rows[0].n).toBe(0);
});
it('BILL2: final detail cannot regress to preliminary evidence',async()=>{
 const f=await fixture(),r=await f.prepare(),id=await call(f.actor,r.id);await receipt(f.actor,r.id,id,'0.003',{coverage:'included_detail',detailId:'a'});expect(await receipt(f.actor,r.id,id,'0.002',{coverage:'included_detail',detailId:'a',final:false})).toMatchObject({conflict:true});expect((await conservation(f.actor)).credits).toBe(80);
});
