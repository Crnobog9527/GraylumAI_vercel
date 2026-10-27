/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {createRuntimeBudget} from './budget';
import {clearCatalogCache,withCatalogRequest} from './catalogCache';
import {clearSkillCatalogCache} from './skillCatalog';
import {clearSkillResourceCache} from '../skills/loader';
import {publishSkillPackage} from '../skills/publication';
import {makePackage} from '../__tests__/fixtures/artifacts';
import {ensurePositioningProfilePlans} from '../__tests__/fixtures/positioningProfilePlans';
import {runtimeRouter} from '../../routers/runtime';
import {createTRPCContext} from '../../trpc';
const connectionString=process.env.V3_LOCAL_DB!;
if(!connectionString?.startsWith('postgres://postgres@127.0.0.1:')||!connectionString.endsWith('/v3_disposable'))
 throw new Error('isolated runner required');
const db=new pg.Client({connectionString});
const admin=createClient(process.env.V3_LOCAL_REST!,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
beforeAll(async()=>{await db.connect();await ensurePositioningProfilePlans(db);});
afterAll(()=>db.end());
const SWITCH="insert into system_settings(key,value) values('runtime_rw_v2',$1::jsonb) on conflict(key) do update set value=excluded.value";
const versions=async()=>Object.fromEntries((await db.query('select name,version::int v from catalog_versions')).rows.map(r=>[r.name,r.v]));
// The catalog reads this PR moves into the process cache, and the per-request version read that replaces them.
const CATALOG=['rest/system_settings','rest/ai_models','rest/skills','rest/modules','rpc/read_skill_package','rpc/catalog_versions_snapshot'];

it('RUNTIME: DB-RW PR-B catalog versions move on real changes only and are readable by the service role only',async()=>{
 const before=await versions();
 // An unchanged UPDATE and an ON CONFLICT DO NOTHING change no row: no version moves (the capacity marker cron does this).
 await db.query("insert into system_settings(key,value) values('catalog_versions_probe','1') on conflict(key) do update set value=excluded.value");
 const probe=await versions();
 expect(probe.settings).toBe(before.settings+1);
 await db.query("update system_settings set value=value where key='catalog_versions_probe'");
 await db.query("insert into system_settings(key,value) values('catalog_versions_probe','2') on conflict(key) do nothing");
 expect(await versions()).toEqual(probe);
 const model=randomUUID();
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Catalog probe','catalog-probe','fixture','true')",[model]);
 await db.query("update ai_models set max_tokens=2000 where id=$1",[model]);
 expect(await versions()).toEqual({...probe,models:probe.models+2});
 await db.query("delete from system_settings where key='catalog_versions_probe'");
 expect((await versions()).settings).toBe(probe.settings+1);
 // The snapshot is the service role's; a signed-in user and the anonymous key are refused.
 const snapshot=await admin.rpc('catalog_versions_snapshot',{});
 expect(snapshot.error).toBeNull();
 expect(snapshot.data).toMatchObject({enabled:false,settings:expect.any(Number),models:expect.any(Number),skills:expect.any(Number)});
 const anon=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 expect((await anon.rpc('catalog_versions_snapshot',{})).error).toBeTruthy();
 expect((await anon.from('catalog_versions').select('name')).data??[]).toEqual([]);
});

it('RUNTIME: DB-RW PR-B a warm free-chat and Skill admission read the catalogs once per request, and a change reaches the next request',async()=>{
 const password='Local-'+randomUUID()+'!',email=randomUUID()+'@example.test';
 const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;
 const actor=created.data.user.id;await db.query("insert into profiles(id,email,credits,role,nickname) values($1,$2,100000,'admin','Fixture')",[actor,email]);
 // Every prepare below holds credits for an execution that is never run.
 const user=createClient(process.env.V3_LOCAL_REST!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false}});
 const login=await user.auth.signInWithPassword({email,password});if(login.error)throw login.error;
 const headers=()=>new Headers({Authorization:'Bearer '+login.data.session!.access_token});
 const chatModel=randomUUID(),skillModel=randomUUID(),moduleId=randomUUID(),pack=makePackage();
 await db.query("insert into ai_models(id,name,model_id,provider,is_active) values($1,'Catalog chat','catalog-chat','fixture','true'),($2,'Catalog Skill','catalog-skill','fixture','true')",[chatModel,skillModel]);
 await db.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,'catalog-cache-'+pack.id,actor]);
 await db.query("insert into modules(id,title,skill_id,active,model_id) values($1,'Catalog Skill',$2,true,$3)",[moduleId,pack.id,skillModel]);
 await publishSkillPackage(admin,actor,pack);
 type Caller=ReturnType<typeof runtimeRouter.createCaller>;
 // One budget and one catalog scope per call, as the route gives one HTTP invocation.
 async function measured<T>(call:(caller:Caller)=>Promise<T>){
  const budget=createRuntimeBudget();
  const result=await withCatalogRequest(()=>budget.timing.run(async()=>call(runtimeRouter.createCaller(await createTRPCContext({headers:headers(),runtimeBudget:budget})))));
  const labels=budget.timing.summary().labels;
  return {result,catalog:Object.fromEntries(CATALOG.map(name=>[name,labels[name]?.rt??0])),
   total:Object.values(labels).reduce((sum,l)=>sum+l.rt,0)};
 }
 const newSession=async()=>((await measured(c=>c.start({requestId:randomUUID(),scope:{kind:'positioning_draft'}}))).result as {sessionId:string}).sessionId;
 const chat=async()=>{const id=await newSession();return measured(c=>c.prepare({sessionId:id,requestId:randomUUID(),input:'Please work',selection:{kind:'ordinary',modelId:chatModel},network:'deny'}));};
 const skill=async()=>{const id=await newSession();return measured(c=>c.prepare({sessionId:id,requestId:randomUUID(),input:'Please work',selection:{kind:'skill',moduleId,revisionId:pack.revisionId},network:'deny'}));};
 // Each measurement is the second of two identical requests, so the existing process caches (Skill files, the user's
 // Skill list) are warm in both rows and only this PR's cache differs.
 const warm=async()=>{await chat();const c=await chat();await skill();const s=await skill();return {chat:c,skill:s};};
 try{
  clearCatalogCache();clearSkillCatalogCache();clearSkillResourceCache();
  await db.query("delete from system_settings where key='runtime_rw_v2'");
  const off=await warm();
  await db.query(SWITCH,[JSON.stringify({catalogCache:true})]);
  clearCatalogCache();
  const on=await warm();
  console.log('DB-RW PR-B catalog reads per warm admission',JSON.stringify({off:{chat:off.chat.catalog,skill:off.skill.catalog,totals:[off.chat.total,off.skill.total]},
   on:{chat:on.chat.catalog,skill:on.skill.catalog,totals:[on.chat.total,on.skill.total]}}));
  // Off: exactly the reads before this PR, and no version read.
  expect(off.chat.catalog).toEqual({'rest/system_settings':1,'rest/ai_models':1,'rest/skills':1,'rest/modules':0,'rpc/read_skill_package':0,'rpc/catalog_versions_snapshot':0});
  expect(off.skill.catalog).toEqual({'rest/system_settings':1,'rest/ai_models':1,'rest/skills':0,'rest/modules':2,'rpc/read_skill_package':1,'rpc/catalog_versions_snapshot':0});
  // On: one version read replaces the settings, model and Skill-version reads. The user-scoped module read and the
  // package check stay per request (they check this user, not the catalog).
  expect(on.chat.catalog).toEqual({'rest/system_settings':0,'rest/ai_models':0,'rest/skills':0,'rest/modules':0,'rpc/read_skill_package':0,'rpc/catalog_versions_snapshot':1});
  expect(on.skill.catalog).toEqual({'rest/system_settings':0,'rest/ai_models':0,'rest/skills':0,'rest/modules':1,'rpc/read_skill_package':1,'rpc/catalog_versions_snapshot':1});
  expect(on.chat.total).toBe(off.chat.total-2);
  expect(on.skill.total).toBe(off.skill.total-2);

  // A changed setting reaches the very next request: it reads the settings again, then is warm again.
  await db.query("insert into system_settings(key,value) values('model_identity_guard',$1::jsonb) on conflict(key) do update set value=excluded.value",[JSON.stringify({enabled:true})]);
  expect((await chat()).catalog['rest/system_settings']).toBe(1);
  expect((await chat()).catalog['rest/system_settings']).toBe(0);
  await db.query("delete from system_settings where key='model_identity_guard'");
  // A deactivated model or module is refused in the very next request, as without the cache.
  await db.query("update ai_models set is_active='false' where id=$1",[chatModel]);
  await expect(chat()).rejects.toThrow();
  await db.query("update ai_models set is_active='true' where id=$1",[chatModel]);
  expect((await chat()).catalog['rest/ai_models']).toBe(1);
  await db.query('update modules set active=false where id=$1',[moduleId]);
  try{await expect(skill()).rejects.toThrow();}finally{await db.query('update modules set active=true where id=$1',[moduleId]);}
  await skill();
  // A revoked revision is refused at once too (the per-request package check, and the Skill version moved).
  await db.query('select revoke_skill_revision($1,$2)',[pack.revisionId,actor]);
  await expect(skill()).rejects.toThrow();
  // Off again: back to the old reads from the next request on.
  await db.query(SWITCH,[JSON.stringify({catalogCache:false})]);
  expect((await chat()).catalog).toMatchObject({'rest/system_settings':1,'rest/ai_models':1,'rpc/catalog_versions_snapshot':1});
  expect((await chat()).catalog).toMatchObject({'rest/system_settings':1,'rest/ai_models':1,'rpc/catalog_versions_snapshot':0});
 }finally{
  await db.query("delete from system_settings where key='runtime_rw_v2'");
  clearCatalogCache();
 }
});
