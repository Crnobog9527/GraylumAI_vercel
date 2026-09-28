/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {databaseSkillSource,userVisibleModules,type UserVisibleModule} from './databaseSource';
import {activateSkill,clearSkillResourceCache,discoverSkills,identityOf,packageHash,sha256} from './loader';

const moduleId='00000000-0000-4000-8000-0000000000a1',skillId='00000000-0000-4000-8000-0000000000b1',revisionId='00000000-0000-4000-8000-0000000000c1';
const entry='---\nname: demo\ndescription: Demo.\n---\nBody\n';
const manifest=(()=>{const p={packageId:skillId,revisionId,directoryName:'demo',packageHash:'',tasks:{},requiredCapabilities:[],
 files:[{path:'SKILL.md',bytes:Buffer.byteLength(entry),sha256:sha256(entry),mediaType:'text/markdown' as const,requires:[]}]};p.packageHash=packageHash(p);return p;})();
/** Synthetic clients: RLS visibility of the module and the service RPC verdict are switchable. */
function clients(){
 const state={visible:true,serviceAllowed:true};
 const moduleReads=vi.fn(async()=>state.visible?{data:{id:moduleId,active:true},error:null}:{data:null,error:{code:'PGRST116'}});
 const listReads=vi.fn(async()=>({data:state.visible?[{id:moduleId,active:true}]:[],error:null}));
 const chain={select:()=>chain,eq:()=>chain,order:()=>chain,limit:listReads,single:moduleReads};
 const user={auth:{getUser:async()=>({data:{user:{id:'actor',email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null})},from:vi.fn(()=>chain)} as unknown as SupabaseClient;
 const rpc=vi.fn(async(_name:string,args:{p_path:string|null})=>{
  if(!state.serviceAllowed)return {data:null,error:{message:'Skill unavailable'}};
  return {data:args.p_path===null?manifest:args.p_path===''?true:Buffer.from(entry).toString('base64'),error:null};
 });
 return {state,user,admin:{rpc} as unknown as SupabaseClient,moduleReads,listReads,rpc};
}

it('reads public module admission once per request-local source and checks every service call',async()=>{
 const c=clients(),source=databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId});
 const [descriptor]=await source.list();
 expect(await source.state(descriptor)).toBe('enabled');
 await source.read({...descriptor,path:'SKILL.md'},100);
 expect(c.moduleReads).toHaveBeenCalledTimes(1);expect(c.rpc).toHaveBeenCalledTimes(3);
 // A new request builds a new source and admits the module again.
 await databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId}).list();
 expect(c.moduleReads).toHaveBeenCalledTimes(2);
});

it('repeats a listing from the same immutable descriptor without another service call',async()=>{
 const c=clients(),source=databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId});
 const [first]=await source.list(),[second]=await source.list();
 expect(second).toEqual(first);expect(second).not.toBe(first);expect(c.rpc).toHaveBeenCalledTimes(1);
});

it('never reuses a denied module admission and denies a revoked revision on the next check',async()=>{
 const c=clients();c.state.visible=false;
 const source=databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId});
 await expect(source.list()).rejects.toMatchObject({code:'UNAVAILABLE'});
 c.state.visible=true;const [descriptor]=await source.list();
 expect(c.moduleReads).toHaveBeenCalledTimes(2);
 c.state.serviceAllowed=false;
 expect(await source.state(descriptor)).toBe('denied');
 await expect(source.read({...descriptor,path:'SKILL.md'},100)).rejects.toMatchObject({code:'UNAVAILABLE'});
});

it('accepts only a row from the same request\'s user-scoped read, checked again at run time',async()=>{
 const c=clients(),visible=await userVisibleModules(c.user,{limit:64});
 if(visible.error)throw new Error('fixture');
 await databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId,userVisibleModule:visible.data[0]}).list();
 expect(c.moduleReads).not.toHaveBeenCalled();expect(c.listReads).toHaveBeenCalledTimes(1);expect(c.rpc).toHaveBeenCalledTimes(1);
 // A row the user-scoped read did not return is never produced.
 c.state.visible=false;expect((await userVisibleModules(c.user,{limit:64})).data).toEqual([]);c.state.visible=true;
 // Forged rows (only reachable by casting) still fail closed.
 const forged=(row:object)=>row as unknown as UserVisibleModule;
 for(const row of [{id:moduleId,active:false},{id:'00000000-0000-4000-8000-0000000000a2',active:true},{id:moduleId,active:'true'}])
  expect(()=>databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId,userVisibleModule:forged(row)})).toThrow('UNAVAILABLE');
 // The service RPC still independently denies a module that became inactive.
 c.state.serviceAllowed=false;
 await expect(databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId,userVisibleModule:visible.data[0]}).list())
  .rejects.toMatchObject({code:'UNAVAILABLE'});
});

it('rejects a service-role or hand-built module row at compile time',()=>{
 const c=clients();
 const serviceRoleRow={id:moduleId,active:true as const,skill_id:skillId,model_id:'model'};
 // Web typecheck (CI "Lint & Type Check") compiles this file; an unused expectation fails it.
 // @ts-expect-error A service-role row is not a UserVisibleModule.
 const build=()=>databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId,userVisibleModule:serviceRoleRow});
 expect(typeof build).toBe('function');
});

it('reuses a listing only where the loader checks state immediately after it',async()=>{
 for(const reach of ['activate','discover'] as const){
  clearSkillResourceCache();
  const c=clients(),source=databaseSkillSource({userClient:c.user,privateClient:c.admin,moduleId,skillId,revisionId});
  const [descriptor]=await source.list();
  // Revoked between the checked first listing and the loader's reuse of it.
  c.state.serviceAllowed=false;
  if(reach==='activate')await expect(activateSkill(source,identityOf(descriptor),{maxContextBytes:10000})).rejects.toMatchObject({code:'UNAVAILABLE'});
  else expect(await discoverSkills(source)).toEqual([]);
  expect(c.rpc).toHaveBeenCalledTimes(2);
 }
});
