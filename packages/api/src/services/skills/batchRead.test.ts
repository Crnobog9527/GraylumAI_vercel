/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeEach,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {databaseSkillSource} from './databaseSource';
import {activateSkill,clearSkillResourceCache,discoverSkills,frozenDescriptor,identityOf,packageHash,readSkillResource,sha256} from './loader';

/*
 * DB-PERF PR-4: a database Skill load makes one checked batch read (read_skill_package with p_paths, 0347) instead of a
 * check before, a check and read per uncached file, and a check after. Cached files are not read again, but the check
 * is still made on every load, so a revoked or unpublished Skill is refused at once even when every file is cached.
 */
const moduleId='00000000-0000-4000-8000-0000000000a1',skillId='00000000-0000-4000-8000-0000000000b1';
const revision=(n:number)=>'00000000-0000-4000-8000-0000000000c'+n;
const text=(version:number)=>({'SKILL.md':`---\nname: demo\ndescription: Demo.\n---\nBody v${version}\n`,'a.md':`A v${version}\n`,'b.md':`B v${version}\n`});
function manifest(version:number){
 const files=Object.entries(text(version)).map(([path,body])=>({path,bytes:Buffer.byteLength(body),sha256:sha256(body),
  mediaType:'text/markdown' as const,requires:path==='SKILL.md'?['a.md','b.md']:[]}));
 const p={packageId:skillId,revisionId:revision(version),directoryName:'demo',packageHash:'',tasks:{},requiredCapabilities:[],files};
 p.packageHash=packageHash(p);return p;
}
/** A synthetic package reader that, like 0347, checks access on every call and returns the listed files. */
function clients(){
 const state={published:1,revoked:new Set<string>()};
 const user={auth:{getUser:async()=>({data:{user:{id:'actor',email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null})},
  from:()=>{const chain={select:()=>chain,eq:()=>chain,single:async()=>({data:{id:moduleId,active:true},error:null})};return chain;}} as unknown as SupabaseClient;
 const rpc=vi.fn(async(_name:string,args:{p_revision_id:string|null;p_path:string|null;p_paths?:string[]})=>{
  const version=args.p_revision_id?Number(args.p_revision_id.slice(-1)):state.published;
  const revisionId=revision(version);
  if(state.revoked.has(revisionId))return {data:null,error:{message:'Skill unavailable'}};
  const files=text(version) as Record<string,string>;
  if(args.p_paths)return {data:{files:Object.fromEntries(args.p_paths.map(path=>[path,Buffer.from(files[path]).toString('base64')]))},error:null};
  return {data:args.p_path===null?manifest(version):args.p_path===''?true:Buffer.from(files[args.p_path]).toString('base64'),error:null};
 });
 const source=(revisionId?:string)=>databaseSkillSource({userClient:user,privateClient:{rpc} as unknown as SupabaseClient,moduleId,skillId,revisionId});
 const batches=()=>rpc.mock.calls.filter(([,args])=>args.p_paths).map(([,args])=>args.p_paths);
 return {state,rpc,source,batches};
}
beforeEach(()=>clearSkillResourceCache());

it('loads a Skill in a new server instance with one listing and one checked batch read',async()=>{
 const c=clients(),source=c.source(revision(1));
 const [descriptor]=await source.list();
 const loaded=await activateSkill(source,identityOf(descriptor),{maxContextBytes:100000});
 expect(loaded.forModel()).toContain('A v1');
 expect(c.rpc).toHaveBeenCalledTimes(2);
 expect(c.batches()).toEqual([['SKILL.md','a.md','b.md']]);
});

it('still checks access once per load when every file is cached, and reads no content again',async()=>{
 const c=clients();
 await activateSkill(c.source(revision(1)),identityOf((await c.source(revision(1)).list())[0]),{maxContextBytes:100000});
 c.rpc.mockClear();
 const source=c.source(revision(1));const [descriptor]=await source.list();
 expect((await activateSkill(source,identityOf(descriptor),{maxContextBytes:100000})).forModel()).toContain('B v1');
 expect(await readSkillResource(source,identityOf(descriptor),'a.md',1000)).toBe('A v1\n');
 expect((await discoverSkills(source)).map(s=>s.public.name)).toEqual(['demo']);
 // One listing, then exactly one checked call per load, each with no file to read.
 expect(c.rpc).toHaveBeenCalledTimes(4);
 expect(c.batches()).toEqual([[],[],[]]);
});

it('refuses a revoked revision at once even when its files are cached',async()=>{
 const c=clients(),source=c.source(revision(1));
 const [descriptor]=await source.list();
 await activateSkill(source,identityOf(descriptor),{maxContextBytes:100000});
 c.state.revoked.add(revision(1));
 await expect(activateSkill(source,identityOf(descriptor),{maxContextBytes:100000})).rejects.toMatchObject({code:'UNAVAILABLE'});
 await expect(readSkillResource(source,identityOf(descriptor),'a.md',1000)).rejects.toMatchObject({code:'UNAVAILABLE'});
 expect(await discoverSkills(source)).toEqual([]);
});

it('never serves a new version from the previous version\'s cache',async()=>{
 const c=clients(),first=c.source();
 await activateSkill(first,identityOf((await first.list())[0]),{maxContextBytes:100000});
 c.state.published=2;c.rpc.mockClear();
 const next=c.source();const [descriptor]=await next.list();
 expect(descriptor.revisionId).toBe(revision(2));
 const loaded=await activateSkill(next,identityOf(descriptor),{maxContextBytes:100000});
 expect(loaded.forModel()).toContain('Body v2');expect(loaded.forModel()).not.toContain('v1');
 expect(c.batches()).toEqual([['SKILL.md','a.md','b.md']]);
});

it('refuses a batch reply that does not hold exactly the requested files',async()=>{
 const c=clients(),source=c.source(revision(1));
 const [descriptor]=await source.list();
 c.rpc.mockImplementationOnce(async()=>({data:{files:{'SKILL.md':Buffer.from(text(1)['SKILL.md']).toString('base64')}},error:null}));
 await expect(activateSkill(source,identityOf(descriptor),{maxContextBytes:100000})).rejects.toMatchObject({code:'SOURCE_FAILURE'});
 c.rpc.mockImplementationOnce(async()=>({data:{files:{'SKILL.md':Buffer.from('tampered').toString('base64'),
  'a.md':Buffer.from(text(1)['a.md']).toString('base64'),'b.md':Buffer.from(text(1)['b.md']).toString('base64')}},error:null}));
 await expect(activateSkill(source,identityOf(descriptor),{maxContextBytes:100000})).rejects.toMatchObject({code:'INTEGRITY_MISMATCH'});
});

it('caches a frozen descriptor only by its exact identity',async()=>{
 const load=vi.fn(async()=>manifest(1));
 const identity=identityOf(manifest(1));
 expect(await frozenDescriptor(identity,load)).toEqual(manifest(1));
 expect(await frozenDescriptor(identity,load)).toEqual(manifest(1));
 expect(load).toHaveBeenCalledTimes(1);
 // Another revision, or a listing that does not match the frozen identity, is never served from or put in the cache.
 await expect(frozenDescriptor(identityOf(manifest(2)),load)).rejects.toMatchObject({code:'UNAVAILABLE'});
 await expect(frozenDescriptor({...identity,packageHash:'0'.repeat(64)},load)).rejects.toMatchObject({code:'UNAVAILABLE'});
 expect(load).toHaveBeenCalledTimes(3);
});
