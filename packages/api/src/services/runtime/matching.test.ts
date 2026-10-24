/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,beforeEach} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {discoverRuntimeCandidates} from './matching';
import {clearSkillResourceCache,packageHash,sha256} from '../skills/loader';

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
   const c=catalog.find(x=>x.model===f.id)!;
   return {data:{id:c.model,model_id:'provider/'+c.name,provider:'fixture',is_active:String(c.modelActive),max_tokens:1000,input_limit:32000},error:null};
  }),
  rpc:async(_name:string,args:{p_module_id:string;p_path:string|null;p_paths?:string[]})=>{
   const c=catalog.find(x=>x.module===args.p_module_id)!;
   if(!c.serviceAllowed)return {data:null,error:{message:'Skill unavailable'}};
   // A batch read (p_paths, 0347) returns the listed files in the same checked call.
   if(args.p_paths)return {data:{files:Object.fromEntries(args.p_paths.map(path=>[path,Buffer.from(fileOf(c,path)).toString('base64')]))},error:null};
   return {data:args.p_path===null?manifest(c):args.p_path===''?true:Buffer.from(fileOf(c,args.p_path)).toString('base64'),error:null};
  },
 } as unknown as SupabaseClient;
 return {user,admin};
}
beforeEach(()=>clearSkillResourceCache());

// AC-0c moved the descriptor listing before discovery. The same fixture yields
// the same candidates, in the same order, as the previous implementation.
// CONTENT-CONVERSATION-DRIVEN A3a: a legacy task package (refused at activation, after the paid match) and the guided
// positioning Skill (started only from the positioning entry) are never offered to the matcher.
it('discovers the same candidates in the same order, skipping unavailable models and packages',async()=>{
 const {user,admin}=clients();
 const candidates=await discoverRuntimeCandidates(user,admin,{inputBytes:32000,maxOutputTokens:1000});
 expect(candidates.map(c=>[c.key,c.moduleId,c.name,c.requiresTask,c.model])).toEqual([
  ['candidate-0',id(1),'skill-alpha',false,'provider/skill-alpha'],
  ['candidate-1',id(5),'skill-epsilon',false,'provider/skill-epsilon'],
 ]);
 for(const c of candidates){
  const f=catalog.find(x=>x.module===c.moduleId)!;
  expect(c).toMatchObject({skillId:f.skill,packageId:f.skill,revisionId:f.revision,packageHash:manifest(f).packageHash,modelId:f.model,
   description:`Public description of ${f.name}.`,outputLimit:1000});
 }
 // A second discovery in a new request, now with a warm resource cache, is identical.
 expect(await discoverRuntimeCandidates(user,admin,{inputBytes:32000,maxOutputTokens:1000})).toEqual(candidates);
});

// POSITIONING-GATE: a user without a confirmed positioning is never matched to a social media Skill.
it('excludes social media Skills (and rows without the flag) only when asked',async()=>{
 const flagged=clients({[id(1)]:true});
 expect((await discoverRuntimeCandidates(flagged.user,flagged.admin,{inputBytes:32000,maxOutputTokens:1000,excludeSocial:true})).map(c=>c.moduleId))
  .toEqual([id(5)]);
 clearSkillResourceCache();
 const unflagged=clients({[id(5)]:undefined});
 expect((await discoverRuntimeCandidates(unflagged.user,unflagged.admin,{inputBytes:32000,maxOutputTokens:1000,excludeSocial:true})).map(c=>c.moduleId))
  .toEqual([id(1)]);
 clearSkillResourceCache();
 expect((await discoverRuntimeCandidates(flagged.user,flagged.admin,{inputBytes:32000,maxOutputTokens:1000})).map(c=>c.moduleId))
  .toEqual([id(1),id(5)]);
});
