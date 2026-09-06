import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { skillsRouter } from '../../routers/skills';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { packageHash, packageHashPayload, activateSkill, discoverSkills, type PackageDescriptor } from '../skills/loader';
import { publishSkillPackage, type PackagePublication } from '../skills/publication';
import { databaseSkillSource } from '../skills/databaseSource';
import { resolveActiveModulePrompt } from '../chatRuntime';
import { databaseResearchStore } from '../research/store';

const url=process.env.V3_LOCAL_REST!;
if(!url?.startsWith('http://127.0.0.1:')||!process.env.V3_LOCAL_DB?.endsWith('/v3_disposable'))throw new Error('explicit disposable environment required');
const sql=new pg.Client({connectionString:process.env.V3_LOCAL_DB});
const admin=createClient(url,process.env.V3_LOCAL_SERVICE_JWT!,{db:{schema:'public'},auth:{persistSession:false}});
const user=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
// Standalone local PostgREST has no GoTrue. Auth boundary uses a synthetic verified identity;
// every subsequent module / private RPC call uses actual HTTP and database grants.
const actor=randomUUID(),viewer=randomUUID();
vi.spyOn(user.auth,'getUser').mockResolvedValue({data:{user:{id:viewer,email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null} as never);
const source=(moduleId:string,skillId:string,revisionId?:string)=>databaseSkillSource({userClient:user,privateClient:admin,moduleId,skillId,revisionId});
async function fixture(index:number,skillId:string=randomUUID(),expectedVersion=0):Promise<PackagePublication>{
 const base=new URL('./fixtures/standard-skills/',import.meta.url);
 const catalog=JSON.parse(await readFile(new URL('catalog.json',base),'utf8'));
 const item=catalog[index];const d:PackageDescriptor={...item.descriptor,packageId:skillId,revisionId:randomUUID()};d.packageHash=packageHash(d);
 const files=await Promise.all(d.files.map(async f=>({path:f.path,base64:(await readFile(new URL(`${item.root}/${f.path}`,base))).toString('base64')})));
 return {id:skillId,revisionId:d.revisionId,requestId:randomUUID(),expectedVersion,resourcePlanReviewed:true,descriptor:d,files};
}
async function seed(p:PackagePublication){
 await sql.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[p.id,`fixture-${p.id}`,actor]);
 const moduleId=randomUUID();await sql.query('insert into modules(id,title,skill_id,active) values($1,$2,$3,true)',[moduleId,'Synthetic module',p.id]);return moduleId;
}
async function rawPublish(client:pg.Client,p:PackagePublication){return client.query('select atomic_publish_skill_package($1,$2,$3,$4,$5,$6,$7,$8)',[p.id,actor,p.revisionId,p.requestId,p.expectedVersion,p.descriptor,packageHashPayload(p.descriptor as PackageDescriptor),JSON.stringify(p.files)]);}
beforeAll(async()=>{await sql.connect();await sql.query("insert into profiles(id,email,role) values($1,'admin@example.test','admin'),($2,'viewer@example.test','user')",[actor,viewer]);});
afterAll(async()=>{await sql.end();});

describe('V3 real PostgreSQL and PostgREST',()=>{
 it('publishes two real sample directories and loads complete resources, current and pinned history',async()=>{
  for(const index of [0,2]){
   const p=await fixture(index);const m=await seed(p);await publishSkillPackage(admin,actor,p);
   const src=source(m,p.id);const found=await discoverSkills(src);expect(found).toHaveLength(1);
   const loaded=await activateSkill(src,found[0].selection,{task:index===0?'gather':undefined,maxContextBytes:10000});
   const selected=loaded.resourceIdentities();
   for(const r of selected){const bytes=p.files.find(f=>f.path===r.path)!;expect(loaded.forModel()).toContain(JSON.stringify(Buffer.from(bytes.base64,'base64').toString()).slice(1,-1));}
   expect(JSON.stringify(loaded)).not.toContain('resources');
   expect(selected.some(x=>x.path==='references/unrelated.md')).toBe(false);
   if(index===0){
    const p2=await fixture(1,p.id,1);await publishSkillPackage(admin,actor,p2);
    const current=await discoverSkills(source(m,p.id));expect(current[0].selection.revisionId).toBe(p2.revisionId);
    const old=await discoverSkills(source(m,p.id,p.revisionId));expect(old[0].selection.revisionId).toBe(p.revisionId);
    const pinned=await activateSkill(src,found[0].selection,{task:'gather',maxContextBytes:10000});expect(pinned.forModel()).toBe(loaded.forModel());
   }
   await expect(activateSkill(src,found[0].selection,{task:index===0?'gather':undefined,maxContextBytes:2})).rejects.toMatchObject({code:'CAPACITY_EXCEEDED'});
  }
 });
 it('denies ordinary roles private columns/tables/RPC while preserving public metadata',async()=>{
  for(const role of ['anon','authenticated']){
   await sql.query(`set role ${role}`);
   try{
    for(const table of ['skills','skill_revisions','skill_packages','skill_package_files','skill_revision_revocations','research_plans','research_operations']){
     const columns=table==='skills'?['published_content','draft_content','audit_metadata','published_content_hash']:['*'];
     for(const column of columns)await expect(sql.query(`select ${column} from ${table}`)).rejects.toMatchObject({code:'42501'});
    }
    await expect(sql.query('select read_skill_package($1,$2,$3)',[viewer,randomUUID(),randomUUID()])).rejects.toMatchObject({code:'42501'});
    await sql.query('select id,skill_key,status,published_version from skills');
   }finally{await sql.query('reset role');}
  }
  const direct=await user.from('skills').select('published_content');expect(direct.error).not.toBeNull();
  const rpc=await user.rpc('read_skill_package',{p_actor_id:viewer,p_module_id:randomUUID(),p_skill_id:randomUUID()});expect(rpc.error).not.toBeNull();
  const acl=await sql.query("select has_column_privilege('anon','skills','published_content','SELECT') a,has_column_privilege('authenticated','skills','published_content','SELECT') b");expect(acl.rows[0]).toEqual({a:false,b:false});
 });
 it('rolls back invalid publication, rejects stale drafts/replays and prevents content mutation',async()=>{
  const p=await fixture(0);await seed(p);await publishSkillPackage(admin,actor,p);await publishSkillPackage(admin,actor,p);
  const bad=await fixture(1,p.id,1);bad.files[1].base64=Buffer.from('tampered').toString('base64');
  await expect(rawPublish(sql,bad)).rejects.toThrow();
  expect((await sql.query('select published_version from skills where id=$1',[p.id])).rows[0].published_version).toBe(1);
  expect((await sql.query('select count(*)::int n from skill_revisions where skill_id=$1',[p.id])).rows[0].n).toBe(1);
  const stale=await fixture(1,p.id,0);await expect(rawPublish(sql,stale)).rejects.toThrow('stale');
  await expect(sql.query("update skill_package_files set bytes=decode('','base64') where revision_id=$1",[p.revisionId])).rejects.toThrow('immutable');
  await expect(sql.query('delete from skill_packages where revision_id=$1',[p.revisionId])).rejects.toThrow('immutable');
  await expect(sql.query("update skills set draft_content='partial edit' where id=$1",[p.id])).rejects.toThrow('complete');
  await expect(sql.query('select atomic_publish_skill($1,$2)',[p.id,actor])).rejects.toThrow();
  const conflict={...p,files:p.files.map((f,i)=>i?f:{...f,base64:Buffer.from('different').toString('base64')})};await expect(rawPublish(sql,conflict)).rejects.toThrow('conflict');
 });
 it('rolls back revision and file inserts when publication fails at pointer advance',async()=>{
  const p=await fixture(0);await seed(p);await publishSkillPackage(admin,actor,p);const next=await fixture(1,p.id,1);
  await sql.query(`create function public.v3_fault() returns trigger language plpgsql as $$ begin if NEW.id::text=TG_ARGV[0] then raise exception 'synthetic pointer fault'; end if; return NEW; end $$`);
  await sql.query(`create trigger v3_fault before update on skills for each row execute function public.v3_fault('${p.id}')`);
  try{await expect(rawPublish(sql,next)).rejects.toThrow('synthetic pointer fault');}
  finally{await sql.query('drop trigger v3_fault on skills');await sql.query('drop function public.v3_fault()');}
  const rows=await sql.query('select published_version,published_content_hash from skills where id=$1',[p.id]);expect(rows.rows[0].published_version).toBe(1);
  expect((await sql.query('select count(*)::int n from skill_revisions where skill_id=$1',[p.id])).rows[0].n).toBe(1);
  expect((await sql.query('select count(*)::int n from skill_package_files where revision_id=$1',[next.revisionId])).rows[0].n).toBe(0);
 });
 it('serializes truly concurrent publishers across distinct connections with one stale failure',async()=>{
  const p=await fixture(0);await seed(p);const q=await fixture(1,p.id,0);
  const a=new pg.Client({connectionString:process.env.V3_LOCAL_DB}),b=new pg.Client({connectionString:process.env.V3_LOCAL_DB});await Promise.all([a.connect(),b.connect()]);
  try{
   const ids=await Promise.all([a.query('select pg_backend_pid() id'),b.query('select pg_backend_pid() id')]);expect(ids[0].rows[0].id).not.toBe(ids[1].rows[0].id);
   await a.query('begin');await a.query('select id from skills where id=$1 for update',[p.id]);
   const pending=rawPublish(b,q).then(()=>false,()=>true);
   let blocked=false;for(let i=0;i<100;i++){const r=await sql.query('select wait_event_type from pg_stat_activity where pid=$1',[ids[1].rows[0].id]);if(r.rows[0]?.wait_event_type==='Lock'){blocked=true;break;}await new Promise(r=>setTimeout(r,20));}expect(blocked).toBe(true);
   await rawPublish(a,p);await a.query('commit');expect(await pending).toBe(true);
   console.log('concurrent publisher backend IDs',ids.map(r=>r.rows[0].id));
  }finally{await Promise.all([a.end(),b.end()]);}
 });
 it.each(['archive','revoke','disable','rebind','actor-denied'])('rechecks live admission after discovery: %s',async(mode)=>{
  const p=await fixture(0);const m=await seed(p);await publishSkillPackage(admin,actor,p);const src=source(m,p.id);const [found]=await discoverSkills(src);
  if(mode==='archive')await sql.query("update skills set status='archived',archived_by=$2,archived_at=now() where id=$1",[p.id,actor]);
  if(mode==='revoke')await admin.rpc('revoke_skill_revision',{p_revision_id:p.revisionId,p_actor_id:actor});
  if(mode==='disable')await sql.query('update modules set active=false where id=$1',[m]);
  if(mode==='rebind')await sql.query('update modules set skill_id=null where id=$1',[m]);
  if(mode==='actor-denied')await sql.query("update profiles set status='disabled' where id=$1",[viewer]);
  try{await expect(activateSkill(src,found.selection,{task:'gather',maxContextBytes:10000})).rejects.toThrow();}
  finally{await sql.query("update profiles set status='active' where id=$1",[viewer]);}
  if(mode==='revoke'){
    const restored=await fixture(0,p.id,1);await publishSkillPackage(admin,actor,restored);
    expect((await discoverSkills(source(m,p.id)))[0].selection.revisionId).toBe(restored.revisionId);
    await expect(activateSkill(src,found.selection,{task:'gather',maxContextBytes:10000})).rejects.toThrow();
  }
 });
 it('keeps legitimate text runtime via private client and rejects directory/revoked/missing service',async()=>{
  const id=randomUUID();await sql.query("insert into skills(id,skill_key,draft_content) values($1,$2,'Private text method')",[id,id]);const m=randomUUID();await sql.query("insert into modules(id,title,skill_id,active) values($1,'text',$2,true)",[m,id]);
  await admin.rpc('atomic_publish_skill',{p_skill_id:id,p_published_by:actor});
  const prompt=await resolveActiveModulePrompt(admin,{moduleId:m});expect(prompt.content).toBe('Private text method');
  const rev=(await sql.query('select id from skill_revisions where skill_id=$1',[id])).rows[0].id;await admin.rpc('revoke_skill_revision',{p_revision_id:rev,p_actor_id:actor});
  await expect(resolveActiveModulePrompt(admin,{moduleId:m})).rejects.toThrow();
  const p=await fixture(0);const d=await seed(p);await publishSkillPackage(admin,actor,p);await expect(resolveActiveModulePrompt(admin,{moduleId:d})).rejects.toThrow();
  await expect(discoverSkills(databaseSkillSource({userClient:user,privateClient:null,moduleId:d,skillId:p.id}))).rejects.toThrow();
 });
 it('runs protected administrator payload publication through actual profile/RPC HTTP',async()=>{
  const p=await fixture(0);await seed(p);
  const jwt=(id:string)=>{const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const b=Buffer.from(JSON.stringify({role:'authenticated',sub:id,exp:Math.floor(Date.now()/1000)+120})).toString('base64url');return `${a}.${b}.${createHmac('sha256',process.env.V3_LOCAL_JWT_SECRET!).update(`${a}.${b}`).digest('base64url')}`;};
  const caller=(id:string)=>{const scoped=createClient(url,jwt(id),{auth:{persistSession:false}});return skillsRouter.createCaller({headers:new Headers(),user:{id,email:id===actor?'admin@example.test':'viewer@example.test',app_metadata:{provider:'email'},user_metadata:{}},isEmailVerified:true,authProvider:'email',supabase:scoped,supabaseAuth:scoped,supabasePublic:user,supabaseAdmin:admin,hasSupabaseAdminPrivileges:true} as never);};
  await expect(caller(viewer).publishPackage(p)).rejects.toMatchObject({code:'FORBIDDEN'});
  const published=await caller(actor).publishPackage(p);expect(published.revisionId).toBe(p.revisionId);
  await caller(actor).revokeRevision({revisionId:p.revisionId});
 });
 it('serializes dispatch, resumes prepared safely, and atomically freezes on excess actual cost',async()=>{
  const store=databaseResearchStore(admin,viewer),plan=randomUUID(),ops=[randomUUID(),randomUUID()];
  await store.create(plan,3000000,ops.map(operationId=>({operationId,identityHash:'c'.repeat(64),maxQuoteUnits:1000000})));
  const [a,b]=await Promise.all(ops.map(o=>store.reserve(plan,o,'c'.repeat(64),1000000)));
  const dispatched=await Promise.all([store.dispatch(plan,ops[0],a.token!),store.dispatch(plan,ops[1],b.token!)]);
  expect(dispatched.filter(Boolean)).toHaveLength(1);const index=dispatched.indexOf(true);
  await store.finish(plan,ops[index],[a,b][index].token!,'succeeded',{source:'agentkey',fixture:true,canonicalTool:'Fixture/Search',objects:[],pagination:{complete:true,nextCursor:null},fetchedAt:new Date().toISOString(),error:null,cost:{unit:'agentkey-credit',quoted:1,actual:2,status:'reported'}});
  expect(await store.dispatch(plan,ops[1-index],[a,b][1-index].token!)).toBe(false);
  expect((await databaseResearchStore(admin,viewer).get(plan,ops[index]))?.result?.cost.actual).toBe(2);
  await expect(store.reserve(plan,randomUUID(),'c'.repeat(64),1)).rejects.toThrow();
 });
 it('atomically reserves cross-instance budgets, de-duplicates and recovers saved results',async()=>{
  const store=databaseResearchStore(admin,viewer);const plan=randomUUID();
  const ops=[randomUUID(),randomUUID()];await store.create(plan,100,ops.map(operationId=>({operationId,identityHash:'a'.repeat(64),maxQuoteUnits:70})));const r=await Promise.allSettled(ops.map(o=>store.reserve(plan,o,'a'.repeat(64),70)));expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const i=r.findIndex(x=>x.status==='fulfilled');const claim=(r[i] as PromiseFulfilledResult<Awaited<ReturnType<typeof store.reserve>>>).value;
  const reclaim=await store.reserve(plan,ops[i],'a'.repeat(64),70);expect(reclaim.claimed).toBe(true);
  await expect(store.dispatch(plan,ops[i],claim.token!)).rejects.toThrow();claim.token=reclaim.token;
  expect(await store.dispatch(plan,ops[i],claim.token!)).toBe(true);expect(await store.dispatch(plan,ops[i],claim.token!)).toBe(false);
  await store.finish(plan,ops[i],claim.token!,'unknown',null);expect((await databaseResearchStore(admin,viewer).get(plan,ops[i]))?.state).toBe('unknown');
  await expect(databaseResearchStore(admin,actor).get(plan,ops[i])).rejects.toThrow();
  await store.cancel(plan);await expect(store.reserve(plan,randomUUID(),'b'.repeat(64),1)).rejects.toThrow();
 });
});
