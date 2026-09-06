import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {databaseResearchStore} from '../research/store';
import {sorsaReplay} from './fixtures/sorsaServer';
import {sorsaContract,SORSA_PROFILE as P,SORSA_TWEETS as T} from '../research/sorsaContract';
import {sampleProfile,sampleTweets} from './fixtures/sorsaResponses';
const url=process.env.V3_LOCAL_REST!;
if(!url?.startsWith('http://127.0.0.1:')||!process.env.V3_LOCAL_DB?.endsWith('/v3_disposable'))throw new Error('explicit disposable environment required');
const sql=new pg.Client({connectionString:process.env.V3_LOCAL_DB});
const admin=createClient(url,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const ordinary=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
const actor=randomUUID(),other=randomUUID();
const store=()=>databaseResearchStore(admin,actor);
const input=(capability='sorsa.profile')=>({planId:randomUUID(),operationId:randomUUID(),capability,params:{username:'sample_lab'}});
const executions=(f:Awaited<ReturnType<typeof sorsaReplay>>)=>f.events.filter(x=>x.startsWith('execute:'));
async function saved(plan:string){return (await sql.query('select p.budget_units::text,p.reserved_units::text,p.cancelled,o.state,o.result from research_plans p left join research_operations o on o.plan_id=p.id where p.id=$1',[plan])).rows;}
beforeAll(async()=>{await sql.connect();await sql.query("insert into profiles(id,email,role) values($1,'sorsa-actor@example.test','user'),($2,'sorsa-other@example.test','user')",[actor,other]);});
afterAll(async()=>{await sql.end();});

describe('observed Sorsa replay → actual SDK → Graylum adapter → PostgREST → disposable PostgreSQL',()=>{
 it.each([[P,'sorsa.profile','json'],[T,'sorsa.tweets','sse']] as const)('saves and recovers %s with unknown actual cost across adapter/store instances',async(name,capability,mode)=>{
  const i=input(capability),f=await sorsaReplay(store(),mode);
  const a=await f.connect();let expected;
  try{
   expect(await a.discover('synthetic sample')).toEqual(['sorsa.profile','sorsa.tweets']);
   await a.createPlan(i.planId,2,[i]);
   const spy=vi.spyOn(console,'log');
   const result=await a.execute(i);expect(spy).not.toHaveBeenCalled();spy.mockRestore();
   expect(result.state).toBe('succeeded');expected=result.result;
   const projected=sorsaContract.result(name===P?sampleProfile:sampleTweets,{canonicalName:name,params:i.params});
   expect(expected?.objects).toEqual(projected.objects);expect(expected?.pagination).toEqual(projected.pagination);
   expect(expected?.cost).toEqual({unit:'agentkey-credit',quoted:1,actual:null,status:'unknown'});
   expect(expected?.fixture).toBe(true);expect(expected?.canonicalTool).toBe(name);
   expect((await saved(i.planId))[0]).toMatchObject({state:'succeeded',budget_units:'2000000',reserved_units:'1000000',cancelled:false,result:expected});
   expect((await a.execute(i)).recovered).toBe(true);expect(executions(f)).toHaveLength(1);
  }finally{await a.close();await f.stop();}
  const g=await sorsaReplay(store(),mode),b=await g.connect();
  try{
   await b.discover('sample');const recovered=await b.execute(i);expect(recovered).toMatchObject({state:'succeeded',recovered:true,result:expected});
   expect(executions(g)).toHaveLength(0);expect(g.events).not.toContain('describe');
   await expect(b.execute({...i,params:{username:'another_lab'}})).rejects.toThrow('OPERATION_CONFLICT');
   console.log('observed contract SQL recovery',JSON.stringify({tool:name,state:recovered.state,reservedUnits:(await saved(i.planId))[0].reserved_units,actual:null,executeCalls:1,recoveryExecuteCalls:0,pagination:recovered.result?.pagination}));
  }finally{await b.close();await g.stop();}
 });
 it.each(['name','implicit','unknown','schema','price','budget','invalid-identity','cancel','authorize','disabled-actor'])('rejects %s before execution with real SQL admission',async mode=>{
  const f=await sorsaReplay(store()),a=await f.connect(),i=input();
  try{
   await a.discover('sample');
   if(mode==='invalid-identity'){
    await expect(a.createPlan(i.planId,2,[{...i,params:{}}])).rejects.toThrow();
    expect(await saved(i.planId)).toHaveLength(0);return;
   }
   await a.createPlan(i.planId,mode==='budget'?0.5:2,[i]);
   if(mode==='name')f.setDescription(d=>({...d,execute_as:{name:T,params:{}}}));
   if(mode==='implicit')f.setDescription(d=>({...d,execute_as:{name:P,params:{username:'other'}}}));
   if(mode==='unknown')f.setDescription(d=>({...d,execute_as:{name:P,params:{},route:'other'}}));
   if(mode==='schema')f.setDescription(d=>({...d,params:{type:'string'}}));
   if(mode==='price')f.setDescription(d=>({...d,cost:{credits_per_call:2}}));
   if(mode==='cancel')await a.cancel(i.planId);
   if(mode==='authorize')f.authorize.mockRejectedValue(new Error('denied'));
   if(mode==='disabled-actor')await sql.query("update profiles set status='disabled' where id=$1",[actor]);
   await expect(a.execute(i)).rejects.toThrow();
   expect((await saved(i.planId))[0].reserved_units).toBe('0');
  }finally{expect(executions(f)).toHaveLength(0);await sql.query("update profiles set status='active' where id=$1",[actor]);await a.close();await f.stop();}
 });
 it.each(['wrong-type','identity','missing-id','disconnect'])('keeps %s results unknown, retains reservation and never reexecutes',async mode=>{
  const f=await sorsaReplay(store()),a=await f.connect(),i=input();
  try{
   await a.discover('sample');await a.createPlan(i.planId,2,[i]);
   if(mode==='wrong-type')f.setResult(()=>sampleTweets);
   if(mode==='identity')f.setResult(()=>({...sampleProfile,data:{...sampleProfile.data,username:'another_lab'}}));
   if(mode==='missing-id')f.setResult(()=>({...sampleProfile,data:{username:'sample_lab'}}));
   if(mode==='disconnect')f.disconnect();
   const result=await a.execute(i);expect(result.state).toBe('unknown');expect(result.result?.objects).toEqual([]);
   expect((await saved(i.planId))[0]).toMatchObject({state:'unknown',reserved_units:'1000000',cancelled:true});
   expect((await a.execute(i)).recovered).toBe(true);expect(executions(f)).toHaveLength(1);
  }finally{await a.close().catch(()=>{});await f.stop();}
 });
 it('retains dispatched SQL state on a real database save failure without a second execution',async()=>{
  const f=await sorsaReplay(store()),a=await f.connect(),i=input();
  await sql.query("create function public.sorsa_save_fault() returns trigger language plpgsql as $$ begin if NEW.state='succeeded' and NEW.plan_id::text=TG_ARGV[0] then raise exception 'synthetic save fault'; end if; return NEW; end $$");
  await sql.query(`create trigger sorsa_save_fault before update on research_operations for each row execute function public.sorsa_save_fault('${i.planId}')`);
  try{
   await a.discover('sample');await a.createPlan(i.planId,2,[i]);await expect(a.execute(i)).rejects.toThrow('RESEARCH_STATE_UNAVAILABLE');
   expect((await saved(i.planId))[0]).toMatchObject({state:'dispatched',reserved_units:'1000000',result:null});
   expect((await a.execute(i)).state).toBe('dispatched');expect(executions(f)).toHaveLength(1);
  }finally{await sql.query('drop trigger sorsa_save_fault on research_operations');await sql.query('drop function public.sorsa_save_fault()');await a.close();await f.stop();}
 });
 it('projects away private payload fields before saving or returning',async()=>{
  const f=await sorsaReplay(store()),a=await f.connect(),i=input();
  f.setResult(()=>({...sampleProfile,private_manifest:'PRIVATE_CANARY',api_key:'KEY_CANARY',data:{...sampleProfile.data,private_skill:'PRIVATE_CANARY'}}));
  try{await a.discover('sample');await a.createPlan(i.planId,1,[i]);const result=await a.execute(i);
   expect(JSON.stringify(result)).not.toMatch(/CANARY|private_manifest|api_key|private_skill|took_ms/);
   expect(JSON.stringify(await saved(i.planId))).not.toContain('CANARY');
  }finally{await a.close();await f.stop();}
 });
 it('enforces cross-user and ordinary-role denial via actual PostgREST, including recovery',async()=>{
  const f=await sorsaReplay(store()),a=await f.connect(),i=input();
  try{await a.discover('sample');await a.createPlan(i.planId,1,[i]);await a.execute(i);
   await expect(databaseResearchStore(admin,other).get(i.planId,i.operationId)).rejects.toThrow();
   await expect(databaseResearchStore(admin,other).cancel(i.planId)).rejects.toThrow();
   await expect(databaseResearchStore(ordinary,actor).get(i.planId,i.operationId)).rejects.toThrow();
   const read=await ordinary.from('research_operations').select('*');expect(read.error).not.toBeNull();
   const g=await sorsaReplay(databaseResearchStore(admin,other)),b=await g.connect();
   try{await b.discover('sample');await expect(b.execute(i)).rejects.toThrow();expect(executions(g)).toHaveLength(0);}finally{await b.close();await g.stop();}
  }finally{await a.close();await f.stop();}
 });
 it('dispatches a duplicate operation at most once across actual adapters and stores',async()=>{
  const f=await sorsaReplay(store()),g=await sorsaReplay(store());
  const a=await f.connect(),b=await g.connect(),i=input();
  try{
   await Promise.all([a.discover('sample'),b.discover('sample')]);await a.createPlan(i.planId,1,[i]);
   await Promise.allSettled([a.execute(i),b.execute(i)]);
   expect(executions(f).length+executions(g).length).toBe(1);
   expect((await saved(i.planId))[0]).toMatchObject({state:'succeeded',reserved_units:'1000000'});
   expect((await b.execute(i)).recovered).toBe(true);expect(executions(f).length+executions(g).length).toBe(1);
  }finally{await a.close();await b.close();await f.stop();await g.stop();}
 });
 it('keeps the cross-instance atomic budget and dispatch CAS in SQL',async()=>{
  const plan=randomUUID(),ops=[randomUUID(),randomUUID()],s=store();
  await s.create(plan,1000000,ops.map(operationId=>({operationId,identityHash:'a'.repeat(64),maxQuoteUnits:1000000})));
  const claims=await Promise.allSettled(ops.map(o=>store().reserve(plan,o,'a'.repeat(64),1000000)));
  expect(claims.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const index=claims.findIndex(x=>x.status==='fulfilled'),claim=(claims[index] as PromiseFulfilledResult<{token:string}>).value;
  const dispatch=await Promise.all([store().dispatch(plan,ops[index],claim.token),store().dispatch(plan,ops[index],claim.token)]);
  expect(dispatch.filter(Boolean)).toHaveLength(1);
  expect((await saved(plan))[0].reserved_units).toBe('1000000');
  console.log('atomic SQL budget/CAS',JSON.stringify({reservations:1,dispatches:1,reservedUnits:'1000000'}));
 });
});
