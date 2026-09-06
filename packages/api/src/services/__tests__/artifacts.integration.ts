/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {databaseArtifactStore} from '../artifacts/store';
import {publishSkillPackage} from '../skills/publication';
import {databaseResearchStore,type ResearchResult} from '../research/store';
import {makePackage,makeWorkflow} from './fixtures/artifacts';
const url=process.env.V3_LOCAL_REST!;
if(!url?.startsWith('http://127.0.0.1:')||!process.env.V3_LOCAL_DB?.endsWith('/v3_disposable'))throw new Error('disposable local environment required');
const sql=new pg.Client({connectionString:process.env.V3_LOCAL_DB});
const db=createClient(url,process.env.V3_LOCAL_SERVICE_JWT!,{auth:{persistSession:false}});
const owner=randomUUID(),actor=randomUUID(),other=randomUUID();
function user(id=actor){
 const client=createClient(url,process.env.V3_LOCAL_USER_JWT!,{auth:{persistSession:false}});
 // Synthetic Auth boundary only; all following HTTP/SQL/grants/transactions are real.
 vi.spyOn(client.auth,'getUser').mockResolvedValue({data:{user:{id,email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null} as never);return client;
}
async function fixture(n=3,social=false){
 const pack=makePackage(),moduleId=randomUUID();
 await sql.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[pack.id,`synthetic-${pack.id}`,owner]);
 await sql.query('insert into modules(id,title,skill_id,active) values($1,$2,$3,true)',[moduleId,'Synthetic',pack.id]);
 await publishSkillPackage(db,owner,pack);
 const flow=makeWorkflow(n,social),projectId=randomUUID(),roundId=randomUUID(),requestId=randomUUID();
 const options={userClient:user(),privateClient:db,moduleId,skillId:pack.id,registrations:{original:{revisionId:pack.revisionId,workflow:flow}}};
 const store=databaseArtifactStore(options);
 const start={projectId,roundId,requestId,registration:'original',account:social?'test:public-account':null};
 await store.start(start);
 return {pack,moduleId,flow,projectId,roundId,start,options,store};
}
type F=Awaited<ReturnType<typeof fixture>>;
const scope=(f:F)=>({projectId:f.projectId,roundId:f.roundId});
const read=(f:F)=>f.store.execute({action:'read',...scope(f)});
async function fill(f:F){for(const s of f.flow.steps){await f.store.execute({action:'save',...scope(f),requestId:randomUUID(),stepId:s.id,expectedVersion:0,body:`Confirmed ${s.title}`,evidenceIds:[]});await f.store.execute({action:'confirm',...scope(f),requestId:randomUUID(),stepId:s.id,expectedVersion:1});}}
const publish=(f:F,requestId=randomUUID())=>f.store.execute({action:'publish',...scope(f),requestId});
beforeAll(async()=>{await sql.connect();await sql.query("insert into profiles(id,email,role) values($1,'owner@example.test','admin'),($2,'actor@example.test','user'),($3,'other@example.test','user')",[owner,actor,other]);});
afterAll(async()=>{await sql.end();});
describe('V3-ARTIFACTS actual host → PostgREST → isolated SQL',()=>{
 it.each([3,6,8])('%i steps share save/confirmation/publication/report and cross-instance recovery',async n=>{
  const f=await fixture(n,n===6);await fill(f);const req=randomUUID(),first=await publish(f,req);
  f.store=databaseArtifactStore({...f.options,userClient:user()});expect(await publish(f,req)).toEqual(first);
  const r=await read(f),report=await f.store.execute({action:'report',...scope(f)});
  expect(Object.keys(r.steps)).toHaveLength(n);expect(report.available).toBe(true);expect(report.report.sections).toHaveLength(n);
  expect(await f.store.execute({action:'report',...scope(f)})).toEqual(report);
  expect(JSON.stringify(r)).not.toMatch(/METHOD_CANARY|references\/|manifest|requiredCapabilities/);
  expect((await sql.query('select count(*)::int n from artifact_versions where project_id=$1',[f.projectId])).rows[0].n).toBe(1);
  const v1round=f.roundId;f.roundId=randomUUID();
  await f.store.start({...f.start,roundId:f.roundId,requestId:randomUUID(),fromRoundId:v1round});
  await f.store.execute({action:'save',...scope(f),requestId:randomUUID(),stepId:'step-1',expectedVersion:1,body:'Second iteration',evidenceIds:[]});
  const draft=await read(f);expect(draft.currentVersion).toBe(1);expect(draft.steps['step-0'].valid).toBe(true);
  for(let i=1;i<n;i++){expect(draft.steps[`step-${i}`].valid).toBe(false);await f.store.execute({action:'confirm',...scope(f),requestId:randomUUID(),stepId:`step-${i}`,expectedVersion:i===1?2:1});}
  const v2request=randomUUID();expect((await publish(f,v2request)).version).toBe(2);
  f.store=databaseArtifactStore({...f.options,userClient:user()});expect((await publish(f,v2request)).version).toBe(2);
  expect(await f.store.execute({action:'report',projectId:f.projectId,roundId:v1round})).toEqual(report);
  console.log('artifact shared SQL contract',JSON.stringify({steps:n,versions:[1,2],dependencyReview:true,reportHash:report.hash,recovered:true,providerCalls:0,modelCalls:0}));
 });
 it('keeps late candidates separate, rejects save conflicts and invalidates only declared dependencies',async()=>{
  const f=await fixture();await fill(f);
  const before=await read(f);await f.store.execute({action:'candidate',...scope(f),requestId:randomUUID(),stepId:'step-0',body:'Late AI candidate',evidenceIds:[]});
  expect((await read(f)).steps).toEqual(before.steps);
  await f.store.execute({action:'save',...scope(f),requestId:randomUUID(),stepId:'step-1',expectedVersion:1,body:'User change',evidenceIds:[]});
  const after=await read(f);expect(after.steps['step-0'].valid).toBe(true);expect(after.steps['step-1'].valid).toBe(false);expect(after.steps['step-2'].valid).toBe(false);expect(after.confirmations).toHaveLength(3);
  await expect(f.store.execute({action:'save',...scope(f),requestId:randomUUID(),stepId:'step-1',expectedVersion:1,body:'Conflict must not win',evidenceIds:[]})).rejects.toThrow();
  expect((await read(f)).steps['step-1'].body).toBe('User change');await expect(publish(f)).rejects.toThrow();
 });
 it('preserves v1 while v2 drafts, abandons without overwrite and refuses history mutation',async()=>{
  const f=await fixture();await fill(f);await publish(f);const old=await f.store.execute({action:'report',...scope(f)});
  const oldRound=f.roundId;f.roundId=randomUUID();await f.store.start({...f.start,roundId:f.roundId,requestId:randomUUID(),fromRoundId:oldRound});
  expect((await read(f)).currentVersion).toBe(1);
  await f.store.execute({action:'save',...scope(f),requestId:randomUUID(),stepId:'step-0',expectedVersion:1,body:'v2 draft',evidenceIds:[]});
  await f.store.execute({action:'abandon',...scope(f),requestId:randomUUID()});
  expect(await f.store.execute({action:'report',projectId:f.projectId,roundId:oldRound})).toEqual(old);
  await expect(sql.query("update artifact_versions set report='{}' where project_id=$1",[f.projectId])).rejects.toThrow('immutable');
  await expect(sql.query('delete from artifact_confirmations where round_id=$1',[oldRound])).rejects.toThrow('immutable');
 });
 it('rejects cross-user/project/Skill/round, actor overrides and normal-role RPC/table reads',async()=>{
  const f=await fixture(),g=await fixture();await fill(f);
  const otherStore=databaseArtifactStore({...f.options,userClient:user(other)});
  for(const action of ['read','report','publish','abandon'] as const)await expect(otherStore.execute({action,...scope(f),...(['read','report'].includes(action)?{}:{requestId:randomUUID()})} as never)).rejects.toThrow();
  await expect(f.store.execute({action:'read',projectId:f.projectId,roundId:g.roundId})).rejects.toThrow();
  await expect(g.store.execute({action:'read',...scope(f)})).rejects.toThrow();
  await expect(f.store.execute({action:'read',...scope(f),actorId:actor} as never)).rejects.toThrow();
  for(const missing of ['p_module_id','p_skill_id']){
   const result=await db.rpc('artifact_transition',{p_actor_id:actor,p_module_id:f.moduleId,p_skill_id:f.pack.id,p_action:'read',p_project_id:f.projectId,p_round_id:f.roundId,[missing]:null});expect(result.error).not.toBeNull();
  }
  const ordinary=user();expect((await ordinary.from('artifact_rounds').select('*')).error).not.toBeNull();
  expect((await ordinary.rpc('artifact_transition',{p_actor_id:actor,p_module_id:f.moduleId,p_skill_id:f.pack.id,p_action:'read',p_project_id:f.projectId,p_round_id:f.roundId})).error).not.toBeNull();
  await expect(databaseArtifactStore({...f.options,privateClient:null}).execute({action:'read',...scope(f)})).rejects.toThrow();
 });
 it('rechecks disabled actor/module, unbinding and revocation while allowing owned historical reads',async()=>{
  const f=await fixture();await fill(f);await publish(f);
  await sql.query('update modules set active=false where id=$1',[f.moduleId]);
  await expect(f.store.start({...f.start,roundId:randomUUID(),requestId:randomUUID(),fromRoundId:f.roundId})).rejects.toThrow();
  expect((await f.store.execute({action:'report',...scope(f)})).available).toBe(true);
  await sql.query('update modules set active=true,skill_id=null where id=$1',[f.moduleId]);
  await expect(f.store.start({...f.start,roundId:randomUUID(),requestId:randomUUID(),fromRoundId:f.roundId})).rejects.toThrow();
  await sql.query('update modules set skill_id=$2 where id=$1',[f.moduleId,f.pack.id]);
  await sql.query('insert into skill_revision_revocations(revision_id,revoked_by) values($1,$2)',[f.pack.revisionId,owner]);
  await expect(f.store.start({...f.start,roundId:randomUUID(),requestId:randomUUID(),fromRoundId:f.roundId})).rejects.toThrow();
  expect((await read(f)).state).toBe('published');
  await sql.query("update profiles set status='disabled' where id=$1",[actor]);
  try{await expect(read(f)).rejects.toThrow();}finally{await sql.query("update profiles set status='active' where id=$1",[actor]);}
 });
 it('attaches actual research-store results by owner, preserves unknown cost and enforces evidence restrictions on history',async()=>{
  const f=await fixture(),planId=randomUUID(),operationId=randomUUID(),research=databaseResearchStore(db,actor);
  await research.create(planId,1000000,[{operationId,identityHash:'a'.repeat(64),maxQuoteUnits:1000000}]);
  const record=await research.reserve(planId,operationId,'a'.repeat(64),1000000);await research.dispatch(planId,operationId,record.token!);
  const result:ResearchResult={source:'agentkey',fixture:true,canonicalTool:'Synthetic/Profile',objects:[{id:'2096273963726835962',sourceUrl:'https://example.test/sample',fields:{name:'Synthetic object'},missingFields:['location'],observedAt:null}],fetchedAt:'2026-01-01T00:00:00Z',pagination:{complete:false,nextCursor:'synthetic-page-2'},error:null,cost:{unit:'agentkey-credit',quoted:1,actual:null,status:'unknown'}};
  await research.finish(planId,operationId,record.token!,'succeeded',result);
  const evidence=await f.store.execute({action:'researchEvidence',...scope(f),requestId:randomUUID(),planId,operationId});
  await fill(f);const original=(await read(f)).steps;
  const unused=await f.store.execute({action:'userEvidence',...scope(f),requestId:randomUUID(),body:'Not yet adopted',observedAt:null,supersedes:null});
  expect((await read(f)).steps).toEqual(original);
  await f.store.execute({action:'save',...scope(f),requestId:randomUUID(),stepId:'step-1',expectedVersion:1,body:'Uses research evidence',evidenceIds:[evidence.evidenceId]});
  for(const stepId of ['step-1','step-2'])await f.store.execute({action:'confirm',...scope(f),requestId:randomUUID(),stepId,expectedVersion:stepId==='step-1'?2:1});
  await publish(f);const report=await f.store.execute({action:'report',...scope(f)});
  expect(report.report.sources[0]).toMatchObject({cost:result.cost,pagination:result.pagination,license:'unknown'});
  expect((await read(f)).evidence.find((e:{id:string})=>e.id===evidence.evidenceId).payload.result).toEqual(result);
  const g=await fixture();await expect(g.store.execute({action:'researchEvidence',...scope(g),requestId:randomUUID(),planId,operationId})).rejects.toThrow();
  await expect(g.store.execute({action:'save',...scope(g),requestId:randomUUID(),stepId:'step-0',expectedVersion:0,body:'cross project',evidenceIds:[unused.evidenceId]})).rejects.toThrow();
  await f.store.execute({action:'restrictEvidence',...scope(f),requestId:randomUUID(),evidenceId:evidence.evidenceId,deleted:true,expiresAt:null});
  const denied=await f.store.execute({action:'report',...scope(f)});expect(denied).toMatchObject({available:false,reason:'EVIDENCE_UNAVAILABLE'});
  const state=await read(f);expect(state.steps['step-1'].body).toBeNull();expect(state.steps['step-2'].valid).toBe(false);expect(state.steps['step-2'].body).toBeNull();
  expect(state.evidence.find((e:{id:string})=>e.id===evidence.evidenceId).payload).toBeNull();
  expect(state.confirmations.filter((c:{stepId:string})=>c.stepId==='step-1').some((c:{body:string|null})=>c.body===null)).toBe(true);
  await f.store.execute({action:'restrictEvidence',...scope(f),requestId:randomUUID(),evidenceId:evidence.evidenceId,deleted:false,expiresAt:null});
  expect((await f.store.execute({action:'report',...scope(f)})).available).toBe(false);
 });
 it('time-based expiry propagates without mutation and revisions remain distinct from adoption',async()=>{
  const f=await fixture();const e=await f.store.execute({action:'userEvidence',...scope(f),requestId:randomUUID(),body:'Synthetic observation',observedAt:null,supersedes:null});
  await fill(f);await f.store.execute({action:'save',...scope(f),requestId:randomUUID(),stepId:'step-0',expectedVersion:1,body:'Observed',evidenceIds:[e.evidenceId]});
  for(const s of f.flow.steps)await f.store.execute({action:'confirm',...scope(f),requestId:randomUUID(),stepId:s.id,expectedVersion:s.id==='step-0'?2:1});
  const before=(await read(f)).steps;
  await f.store.execute({action:'userEvidence',...scope(f),requestId:randomUUID(),body:'Correction pending adoption',observedAt:null,supersedes:e.evidenceId});
  expect((await read(f)).steps).toEqual(before);
  // Controlled local SQL clock fixture, not a remote policy or invented license.
  await sql.query("update artifact_evidence_restrictions set expires_at=now()-interval '1 second' where evidence_id=$1",[e.evidenceId]);
  const after=await read(f);expect(Object.values(after.steps).every((s:any)=>s.valid===false)).toBe(true);
  await expect(publish(f)).rejects.toThrow();
 });
 it('pins old flow/report and upgrades only changed resource dependency closures in a new round',async()=>{
  const f=await fixture();await fill(f);await publish(f);const old=await f.store.execute({action:'report',...scope(f)}),oldRound=f.roundId;
  const newer=makePackage(f.pack.id,true);await publishSkillPackage(db,owner,newer);
  const flow=makeWorkflow(3);flow.version=2;flow.steps[2].dependsOn=[];
  f.store=databaseArtifactStore({...f.options,registrations:{original:{revisionId:newer.revisionId,workflow:flow}}});
  f.roundId=randomUUID();await f.store.start({...f.start,roundId:f.roundId,requestId:randomUUID(),fromRoundId:oldRound});
  const r=await read(f);expect(r.revisionId).toBe(newer.revisionId);expect(r.steps['step-0'].valid).toBe(false);expect(r.steps['step-1'].valid).toBe(false);
  expect(await f.store.execute({action:'report',projectId:f.projectId,roundId:oldRound})).toEqual(old);
 });
 it('keeps duplicate request IDs scoped and rejects changed replay payloads or another round',async()=>{
  const f=await fixture(),g=await fixture(),requestId=randomUUID();
  const command={action:'save' as const,...scope(f),requestId,stepId:'step-0',expectedVersion:0,body:'Once',evidenceIds:[]};
  const first=await f.store.execute(command);expect(await databaseArtifactStore(f.options).execute(command)).toEqual(first);
  await expect(f.store.execute({...command,body:'Changed replay'})).rejects.toThrow();
  expect(await g.store.execute({...command,...scope(g)})).toEqual(first);
  expect((await read(f)).steps['step-0'].body).toBe('Once');
  await expect(f.store.start({...f.start,roundId:randomUUID(),requestId:randomUUID()})).rejects.toThrow();
 });
 it('real SQL rejects invalid workflows and module kinds without any project residue',async()=>{
  const f=await fixture();
  for(const change of ['cycle','resource','capability','missing','report']){
   const flow=makeWorkflow(3);if(change==='cycle')flow.steps[0].dependsOn=['step-2'];
   if(change==='resource')flow.steps[0].resources=['absent.md'];
   if(change==='capability')(flow.steps[0].requiredCapabilities as string[])=['arbitrary.execute'];
   if(change==='missing')delete (flow.steps[0] as {minLength?:number}).minLength;
   if(change==='report')flow.report.sections[0].stepId='not-present';
   const projectId=randomUUID();
   // Another actor avoids the intentionally unique per-user/Skill project index.
   const result=await db.rpc('artifact_transition',{p_actor_id:other,p_module_id:f.moduleId,p_skill_id:f.pack.id,p_action:'start',p_project_id:projectId,p_round_id:randomUUID(),p_request_id:randomUUID(),p_payload:{account:null,revisionId:f.pack.revisionId,packageHash:f.pack.descriptor.packageHash,workflow:flow}});
   expect(result.error).not.toBeNull();expect((await sql.query('select count(*)::int n from artifact_projects where id=$1',[projectId])).rows[0].n).toBe(0);
  }
 });
 it('validates a dense 32-step acyclic workflow within a bounded SQL statement',async()=>{
  const pack=makePackage(),flow=makeWorkflow(32);
  flow.steps.forEach((step,i)=>{step.dependsOn=flow.steps.slice(0,i).map(s=>s.id);step.resources=[`references/step-${i%8}.md`];});
  await sql.query('set statement_timeout=2000');
  try{await sql.query('select artifact_validate_workflow($1,$2)',[flow,pack.descriptor]);}
  finally{await sql.query('set statement_timeout=0');}
 });
 it('rejects unverified Auth without a private RPC and never modifies ordinary text Skill state',async()=>{
  const f=await fixture(),u=user();vi.mocked(u.auth.getUser).mockResolvedValue({data:{user:{id:actor}},error:null} as never);
  const rpc=vi.spyOn(db,'rpc');rpc.mockClear();
  try{await expect(databaseArtifactStore({...f.options,userClient:u}).execute({action:'read',...scope(f)})).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();}finally{rpc.mockRestore();}
  const textId=randomUUID();await sql.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)',[textId,`ordinary-${textId}`,owner]);
  expect((await sql.query('select content_kind from skills where id=$1',[textId])).rows[0].content_kind).toBe('text');
  expect((await sql.query('select count(*)::int n from artifact_projects where skill_id=$1',[textId])).rows[0].n).toBe(0);
 });
 it('fixed flow identity cannot be silently edited even by an accidental privileged update',async()=>{
  const f=await fixture();await expect(sql.query("update artifact_rounds set workflow=jsonb_set(workflow,'{version}','999') where id=$1",[f.roundId])).rejects.toThrow('immutable');
 });
 async function race(f:F,actions:{action:string;payload:Record<string,unknown>;requestId?:string}[]){
  const clients=actions.map(()=>new pg.Client({connectionString:process.env.V3_LOCAL_DB}));await Promise.all(clients.map(c=>c.connect()));
  let locked=false;
  try{
   const pids=await Promise.all(clients.map(async c=>(await c.query('select pg_backend_pid() pid')).rows[0].pid));
   await sql.query('begin');await sql.query('select id from artifact_projects where id=$1 for update',[f.projectId]);locked=true;
   const pending=clients.map((c,i)=>c.query('select artifact_transition($1,$2,$3,$4,$5,$6,$7,$8) value',[actor,f.moduleId,f.pack.id,actions[i].action,f.projectId,f.roundId,actions[i].requestId??randomUUID(),actions[i].payload]));
   const settled=Promise.allSettled(pending);
   let waiting=0;for(let i=0;i<100;i++){
    waiting=(await sql.query("select count(*)::int n from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'",[pids])).rows[0].n;
    if(waiting===clients.length)break;await new Promise(r=>setTimeout(r,20));
   }
   expect(waiting).toBe(clients.length);await sql.query('commit');locked=false;
   const outcomes=await settled;console.log('SQL concurrent wait verified',JSON.stringify({pids,waiting,actions:actions.map(a=>a.action),outcomes:outcomes.map(o=>o.status)}));return outcomes;
  }finally{if(locked)await sql.query('rollback');await Promise.all(clients.map(c=>c.end()));}
 }
 it('two actual SQL connections compete for one saved revision, with cross-instance recovery',async()=>{
  const f=await fixture();const results=await race(f,[0,1].map(i=>({action:'save',payload:{stepId:'step-0',expectedVersion:0,body:`Writer ${i}`,evidenceIds:[]}})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  f.store=databaseArtifactStore({...f.options,userClient:user()});expect((await read(f)).steps['step-0'].version).toBe(1);
 });
 it('save/confirm competition cannot leave a valid snapshot of the overwritten draft',async()=>{
  const f=await fixture();await fill(f);
  await race(f,[{action:'save',payload:{stepId:'step-0',expectedVersion:1,body:'Concurrent draft',evidenceIds:[]}},{action:'confirm',payload:{stepId:'step-0',expectedVersion:1}}]);
  expect((await read(f)).steps['step-0']).toMatchObject({version:2,valid:false,body:'Concurrent draft'});
 });
 it('two concurrent publish requests recover exactly one formal version',async()=>{
  const f=await fixture();await fill(f);const requestId=randomUUID(),results=await race(f,[0,1].map(()=>({action:'publish',payload:{},requestId})));
  expect(results.every(r=>r.status==='fulfilled')).toBe(true);
  expect((await sql.query('select count(*)::int n from artifact_versions where project_id=$1',[f.projectId])).rows[0].n).toBe(1);
  expect((await read(f)).currentVersion).toBe(1);expect((await publish(f,requestId)).version).toBe(1);
 });
 it('publish/save competition is serial: published snapshot is complete or publish waits for review',async()=>{
  const f=await fixture();await fill(f);
  const outcomes=await race(f,[{action:'publish',payload:{}},{action:'save',payload:{stepId:'step-0',expectedVersion:1,body:'New unsaved candidate',evidenceIds:[]}}]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const state=await read(f),report=await f.store.execute({action:'report',...scope(f)});
  if(state.state==='published'){expect(report.available).toBe(true);expect(state.steps['step-0'].version).toBe(1);}else{expect(report.available).toBe(false);expect(state.steps['step-0'].valid).toBe(false);}
 });
 it('SQL publication failure rolls back report, pointer and request; a new instance retries safely',async()=>{
  const f=await fixture();await fill(f);const requestId=randomUUID();
  await sql.query("create function artifact_test_fault() returns trigger language plpgsql as $$ begin if NEW.id::text=TG_ARGV[0] and NEW.current_version>0 then raise exception 'synthetic pointer fault'; end if; return NEW; end $$");
  await sql.query(`create trigger artifact_test_fault before update on artifact_projects for each row execute function artifact_test_fault('${f.projectId}')`);
  try{await expect(publish(f,requestId)).rejects.toThrow();
   expect((await sql.query('select count(*)::int n from artifact_versions where project_id=$1',[f.projectId])).rows[0].n).toBe(0);
   expect((await read(f)).currentVersion).toBe(0);
   expect((await sql.query('select count(*)::int n from artifact_requests where project_id=$1 and request_id=$2',[f.projectId,requestId])).rows[0].n).toBe(0);
  }finally{await sql.query('drop trigger artifact_test_fault on artifact_projects');await sql.query('drop function artifact_test_fault()');}
  f.store=databaseArtifactStore({...f.options,userClient:user()});expect((await publish(f,requestId)).version).toBe(1);
 });
});
