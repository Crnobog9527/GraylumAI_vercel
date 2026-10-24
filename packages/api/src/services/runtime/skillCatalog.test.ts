/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,beforeEach,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {clearSkillCatalogCache,discoverSkillCatalog,serializedResultBytes} from './skillCatalog';
import {clearSkillResourceCache,packageHash,sha256} from '../skills/loader';

const skillState={status:'published',version:1};
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
type Fixture={module:string;skill:string;revision:string;model:string;name:string;tasks:boolean;modelActive:boolean;serviceAllowed:boolean;workflow?:string};
const guidedWorkflow='kind: document\nsteps:\n  - title: 了解你\n    resources: [SKILL.md]\n    information:\n      - {id: who, title: 目标用户, required: true, profileKey: audience}\n';
const workGuide='kind: document\nsteps:\n  - title: 写口播稿\n    resources: [SKILL.md]\n';
// Ordered by module id, as the catalog query orders them.
const catalog:Fixture[]=[
 {module:id(1),skill:id(11),revision:id(21),model:id(31),name:'skill-alpha',tasks:false,modelActive:true,serviceAllowed:true},
 {module:id(2),skill:id(12),revision:id(22),model:id(32),name:'skill-beta',tasks:true,modelActive:true,serviceAllowed:true},
 {module:id(3),skill:id(13),revision:id(23),model:id(33),name:'skill-gamma',tasks:false,modelActive:false,serviceAllowed:true},
 {module:id(4),skill:id(14),revision:id(24),model:id(34),name:'skill-delta',tasks:false,modelActive:true,serviceAllowed:false},
 {module:id(5),skill:id(15),revision:id(25),model:id(35),name:'skill-epsilon',tasks:false,modelActive:true,serviceAllowed:true,workflow:workGuide},
 {module:id(6),skill:id(16),revision:id(26),model:id(36),name:'skill-positioning',tasks:false,modelActive:true,serviceAllowed:true,workflow:guidedWorkflow},
];
const entry=(f:Fixture)=>`---\nname: ${f.name}\ndescription: Public description of ${f.name}.\n---\nBody\n`;
const fileOf=(f:Fixture,path:string)=>path==='workflow.yaml'?f.workflow!:entry(f);
function manifest(f:Fixture){
 const text=entry(f);
 const tasks:Record<string,string[]>=f.tasks?{draft:['SKILL.md']}:{};
 const files=[{path:'SKILL.md',bytes:Buffer.byteLength(text),sha256:sha256(text),mediaType:'text/markdown' as const,requires:[] as string[]},
  ...(f.workflow?[{path:'workflow.yaml',bytes:Buffer.byteLength(f.workflow),sha256:sha256(f.workflow),mediaType:'text/yaml' as const,requires:[] as string[]}]:[])];
 const p={packageId:f.skill,revisionId:f.revision,directoryName:f.name,packageHash:'',tasks,requiredCapabilities:[] as string[],files};
 p.packageHash=packageHash(p);return p;
}
/** Minimal PostgREST-shaped builder: records filters, resolves at the terminal call. */
function tables(resolve:(table:string,filters:Record<string,unknown>)=>{data:unknown;error:unknown}){
 return (table:string)=>{
  const filters:Record<string,unknown>={};
  const done=()=>Promise.resolve(resolve(table,filters));
  const builder={
   select:()=>builder,order:()=>builder,
   eq:(key:string,value:unknown)=>{filters[key]=value;return builder;},
   in:(key:string,value:unknown)=>{filters[key]=value;return builder;},
   limit:()=>done(),single:()=>done(),
   then:(ok:(v:unknown)=>unknown,fail:(e:unknown)=>unknown)=>done().then(ok,fail),
  };
  return builder;
 };
}
function clients(social:Record<string,boolean|undefined>={}){
 const user={
  auth:{getUser:async()=>({data:{user:{id:'actor',email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null})},
  from:tables((_table,f)=>f.id?{data:catalog.some(c=>c.module===f.id)?{id:f.id,active:true}:null,error:null}
   :{data:catalog.map(c=>({id:c.module,active:true})),error:null}),
 } as unknown as SupabaseClient;
 const admin={
  from:tables((table,f)=>{
   if(table==='modules')return {data:catalog.filter(c=>(f.id as string[]).includes(c.module)).map(c=>({id:c.module,skill_id:c.skill,model_id:c.model,
    social_media_related:c.module in social?social[c.module]:false})),error:null};
   // CONTENT-CONVERSATION-DRIVEN: the published version of each Skill, which a cached catalog is checked against.
   if(table==='skills')return {data:(f.id as string[]).map(skill=>({id:skill,status:skillState.status,published_version:skillState.version})),error:null};
   const c=catalog.find(x=>x.model===f.id)!;
   return {data:{id:c.model,model_id:'provider/'+c.name,provider:'fixture',is_active:String(c.modelActive),max_tokens:1000,input_limit:32000},error:null};
  }),
  rpc:async(_name:string,args:{p_module_id:string;p_path:string|null;p_paths?:string[]})=>{
   const c=catalog.find(x=>x.module===args.p_module_id)!;
   if(!c.serviceAllowed)return {data:null,error:{message:'Skill unavailable'}};
   // A batch read (p_paths, 0358) returns the listed files in the same checked call.
   if(args.p_paths)return {data:{files:Object.fromEntries(args.p_paths.map(path=>[path,Buffer.from(fileOf(c,path)).toString('base64')]))},error:null};
   return {data:args.p_path===null?manifest(c):args.p_path===''?true:Buffer.from(fileOf(c,args.p_path)).toString('base64'),error:null};
  },
 } as unknown as SupabaseClient;
 return {user,admin};
}
beforeEach(()=>{clearSkillResourceCache();clearSkillCatalogCache();skillState.status='published';skillState.version=1;});

// CONTENT-CONVERSATION-DRIVEN: the catalog never reads a model binding; it lists what the dialogue model may load.
it('lists loadable Skills without reading any model, skipping task packages, positioning and unavailable packages',async()=>{
 const {user,admin}=clients();
 const catalog=await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false});
 // gamma's model is inactive and delta's model row exists too: neither matters any more; delta's package is unavailable.
 expect(catalog.map(c=>[c.name,c.moduleId])).toEqual([['skill-alpha',id(1)],['skill-gamma',id(3)],['skill-epsilon',id(5)]]);
 for(const c of catalog){
  expect(c.description).toBe(`Public description of ${c.name}.`);
  expect(c.resultBytes).toBeGreaterThan(0);
  expect(c).not.toHaveProperty('modelId');
 }
});
it('drops social media Skills without a confirmed positioning and Skills too large to load',async()=>{
 const {user,admin}=clients({[id(1)]:true});
 expect((await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:true})).map(c=>c.moduleId)).toEqual([id(3),id(5)]);
 clearSkillResourceCache();
 expect(await discoverSkillCatalog(user,admin,{maxResultBytes:50,excludeSocial:false})).toEqual([]);
});

// The catalog costs about ten round trips per Skill, so it is kept briefly per user; a hit costs none and never crosses users.
it('serves a user\'s catalog from a short cache without reading again, and never across users or settings',async()=>{
 const {user,admin}=clients();
 const reads=()=>(admin.rpc as unknown as {mock?:{calls:unknown[]}}).mock?.calls.length??0;
 const spy=vi.spyOn(admin as unknown as {rpc:()=>unknown},'rpc');
 const first=await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false,actorId:'a',now:1000});
 const cost=spy.mock.calls.length;
 expect(cost).toBeGreaterThan(0);
 const again=await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false,actorId:'a',now:1000+4*60*1000});
 expect(spy.mock.calls.length).toBe(cost);
 expect(again).toEqual(first);
 // The cache hands out copies, so a caller cannot change what the next reply sees.
 again.pop();
 expect(await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false,actorId:'a',now:1000+4*60*1000})).toEqual(first);
 // Another user, another gate setting and another size limit are other entries; after the TTL it reads again.
 await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false,actorId:'b',now:2000});
 expect(spy.mock.calls.length).toBeGreaterThan(cost);
 const afterOther=spy.mock.calls.length;
 await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:true,actorId:'a',now:2000});
 expect(spy.mock.calls.length).toBeGreaterThan(afterOther);
 const afterGate=spy.mock.calls.length;
 await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false,actorId:'a',now:1000+5*60*1000+1});
 expect(spy.mock.calls.length).toBeGreaterThan(afterGate);
 expect(reads()).toBe(spy.mock.calls.length);
});
it('does not cache without an actor',async()=>{
 const {user,admin}=clients();
 const spy=vi.spyOn(admin as unknown as {rpc:()=>unknown},'rpc');
 await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false});
 const cost=spy.mock.calls.length;
 clearSkillResourceCache();
 await discoverSkillCatalog(user,admin,{maxResultBytes:20000,excludeSocial:false});
 expect(spy.mock.calls.length).toBe(cost*2);
});

// A republished Skill takes effect on the next turn (CONTENT_SKILL_RULES 4.3): the cache is used only while every listed
// Skill is still on the version it was listed with, checked with one read.
it('rebuilds a cached catalog when a listed Skill was republished or unpublished, and a hit costs one read',async()=>{
 const {user,admin}=clients();
 const spy=vi.spyOn(admin as unknown as {rpc:()=>unknown},'rpc');
 const from=vi.spyOn(admin as unknown as {from:(table:string)=>unknown},'from');
 const limits={maxResultBytes:20000,excludeSocial:false,actorId:'a'};
 const first=await discoverSkillCatalog(user,admin,{...limits,now:1000});
 expect(first.length).toBeGreaterThan(0);
 const packageReads=spy.mock.calls.length,tableReads=from.mock.calls.length;
 await discoverSkillCatalog(user,admin,{...limits,now:2000});
 expect(spy.mock.calls.length).toBe(packageReads);
 expect(from.mock.calls.length).toBe(tableReads+1);
 skillState.version=2;
 await discoverSkillCatalog(user,admin,{...limits,now:3000});
 expect(spy.mock.calls.length).toBeGreaterThan(packageReads);
 const rebuilt=spy.mock.calls.length;
 await discoverSkillCatalog(user,admin,{...limits,now:4000});
 expect(spy.mock.calls.length).toBe(rebuilt);
 skillState.status='archived';
 await discoverSkillCatalog(user,admin,{...limits,now:5000});
 expect(spy.mock.calls.length).toBeGreaterThan(rebuilt);
});

// The tool returns the result as a JSON string that the SDK serializes again into the next request.
it('measures a load as the doubly serialized result, so quotes and backslashes count twice',()=>{
 const plain={instructions:'abcdefgh'},quoted={instructions:'"\\"\\"\\"\\"'};
 expect(serializedResultBytes(plain)).toBeGreaterThan(Buffer.byteLength(JSON.stringify(plain)));
 expect(serializedResultBytes(quoted)-serializedResultBytes(plain)).toBeGreaterThan(
  Buffer.byteLength(JSON.stringify(quoted))-Buffer.byteLength(JSON.stringify(plain)));
});
