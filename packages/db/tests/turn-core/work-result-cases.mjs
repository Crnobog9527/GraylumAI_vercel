/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-10b C1: a work_item conversation on kind=chat: the checks before a turn opens, and a Skill result saved by its turn.
// The old-row twin of the save is opc.integration ("saveWorkResult"); deletion behaves as for an old result (content-erasure suites).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {root} from '../runtime-view-perf/local-db.mjs';

export async function workResultCases(t){
 const {c,one,open,begin,record,close,account,policy,refusal,report}=t;
 const {Client}=createRequire(resolve(root,'package.json'))('pg');
 const peer=async()=>{const p=new Client({host:c.host,port:c.port,user:'postgres',database:c.database});await p.connect();return p;};
 const asService=async(run,client=c)=>{await client.query('set role service_role');
  try{return await run();}finally{await client.query('reset role');}};
 const save=(a,turn,client=c)=>asService(()=>one('select opc_work_result_turn($1,$2) v',[a.actor,turn],client),client);
 const check=(a,session,video=false)=>asService(()=>one('select opc_work_check($1,$2,$3) v',[a.actor,session,video]));
 const list=(a,f)=>asService(()=>one('select opc_work_results($1,$2) v',[a.actor,f.session]));
 const counts=async f=>(await c.query(`select (select count(*) from artifact_versions v join artifact_projects p on p.id=v.project_id
   where p.actor_id=$1 and p.work_kind='result')::int versions,
  (select count(*) from opc_result_links where turn_actor_id=$1 and step_id='result')::int links`,[f.actor])).rows[0];
 // A published Skill whose manifest names its hash, as a real package's does (the shared fixture's manifest is empty and immutable).
 const published=async actor=>{
  const skillId=randomUUID(),moduleId=randomUUID(),revisionId=randomUUID(),hash='b'.repeat(64),entry='a'.repeat(64);
  await c.query('begin'); // one now(): the published row must match its revision's time
  await c.query("insert into skills(id,skill_key,content_kind) values($1,$2,'directory')",[skillId,'work-'+skillId]);
  await c.query("insert into modules(id,title,skill_id,active) values($1,'Work fixture',$2,true)",[moduleId,skillId]);
  await c.query("insert into skill_revisions(id,skill_id,version,content,content_hash,published_by) values($1,$2,1,'fixture',$3,$4)",[revisionId,skillId,entry,actor]);
  await c.query(`insert into skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
   values($1,$2,$3,$4,$5,$6,0,$7)`,[revisionId,skillId,randomUUID(),JSON.stringify({packageHash:hash}),hash,entry,actor]);
  await c.query(`update skills set status='published',published_version=1,published_content='fixture',published_content_hash=$2,
   published_at=now(),published_by=$3 where id=$1`,[skillId,entry,actor]);
  await c.query('commit');
  return {moduleId,skillId,revisionId};};
 const workspace=async(credits=1000)=>{const a=await account(credits);
  const f=await one('select d7_test.artifacts($1) v',[a.actor]);
  // As opc_handoff binds a work item to its account: what bill2_scope_allowed asks of a work_item conversation.
  await c.query(`update artifact_projects w set source_project_id=i.account_project_id from opc_items i
   where i.work_item_id=w.id and w.id=$1`,[f.workItem]);
  return {a,f,skill:await published(a.actor),actor:a.actor};};
 const finished=async(w,{workSkill=w.skill,kind='completed',text='WORK_RESULT_BODY',delivered=true}={})=>{
  const o=await open(w.a,{session:w.f.session,pol:policy(workSkill?{workSkill}:{})});
  await begin(w.a,o.turnId,1);await record(w.a,o.turnId,1);
  await close(w.a,o.turnId,kind,{messages:[{role:'user',content:'请写'},{role:'assistant',content:text}],delivered});
  return o.turnId;};
 // Before opening: allowed, then an archived business and a script request on a non-video item, each refused; a read writes nothing.
 {
  const w=await workspace();
  // The bound Skill revision, not the module's latest: a newer published revision does not move a work item.
  const bound=await check(w.a,w.f.session,true);
  assert.deepEqual([bound.work.moduleId,bound.work.skillId,bound.work.revisionId],[w.f.module,w.f.skill,w.f.revision]);
  assert.equal(bound.work.brief,null,'no material saved yet');
  const newer=randomUUID();
  await c.query('begin');
  await c.query("insert into skill_revisions(id,skill_id,version,content,content_hash,published_by) values($1,$2,2,'newer',$3,$4)",[newer,w.f.skill,'c'.repeat(64),w.actor]);
  await c.query(`insert into skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
   values($1,$2,$3,'{}',$4,$5,1,$6)`,[newer,w.f.skill,randomUUID(),'d'.repeat(64),'c'.repeat(64),w.actor]);
  await c.query(`update skills set published_version=2,published_content='newer',published_content_hash=$2,published_at=now() where id=$1`,[w.f.skill,'c'.repeat(64)]);
  await c.query('commit');
  assert.equal((await check(w.a,w.f.session,true)).work.revisionId,w.f.revision,'the item keeps the revision it came from');
  // The newest material not revoked is what the turn reads.
  for(const revision of [1,2]) await c.query(`insert into runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
   values($1,$2,$3,'{}',$4,$5)`,[w.f.session,revision,randomUUID(),JSON.stringify({brief:'BRIEF_'+revision,material:'MATERIAL_'+revision,work:{}}),'e'.repeat(64)]);
  assert.deepEqual(await check(w.a,w.f.session,false).then(r=>[r.work.brief,r.work.material]),['BRIEF_2','MATERIAL_2']);
  await c.query('update runtime_scope_material set revoked=true where session_id=$1 and revision=2',[w.f.session]);
  assert.equal((await check(w.a,w.f.session,false)).work.brief,'BRIEF_1');
  assert.deepEqual(await check({actor:randomUUID()},w.f.session,true),{work:null},'another account reads nothing; turn_open refuses it');
  const free=await account();
  assert.deepEqual(await check(free,free.session,true),{work:null},'a free conversation has no work item');
  // An article item of the same plan's business: the fixture's item is a video with a saved script, whose type cannot change.
  const article=randomUUID(),item=randomUUID(),planId=randomUUID(),articleSession=randomUUID();
  await c.query(`insert into artifact_projects(id,actor_id,module_id,skill_id,account,work_title) values($1,$2,$3,$4,$5,'article')`,
   [article,w.actor,w.f.module,w.f.skill,'article-'+article]);
  await c.query(`insert into opc_plans(id,draft_id,version,source_version_id,request_id,request,body)
   select $1,p.draft_id,p.version+1,p.source_version_id,$2,p.request,$3 from opc_items i join opc_plans p on p.id=i.plan_id where i.work_item_id=$4`,
   [planId,randomUUID(),JSON.stringify([{id:item,contentType:'article'}]),w.f.workItem]);
  await c.query(`insert into opc_items(work_item_id,plan_id,item_key,account_project_id,source_version_id,brief,day)
   select $1,$2,$3,i.account_project_id,i.source_version_id,'article brief',current_date from opc_items i where i.work_item_id=$4`,
   [article,planId,item,w.f.workItem]);
  await c.query(`insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')`,
   [articleSession,w.actor,JSON.stringify({kind:'work_item',workItemId:article}),randomUUID()]);
  await check(w.a,articleSession,false);
  assert.match(await refusal(check(w.a,articleSession,true)),/OPC_VIDEO_TYPE_REQUIRED/);
  await c.query('update opc_businesses set archived_at=now() where actor_id=$1',[w.actor]);
  assert.match(await refusal(check(w.a,w.f.session,false)),/OPC_BUSINESS_ARCHIVED/);
 }
 // A save, repeated and raced: one version, one link, one evidence row, the same id each time.
 {
  const w=await workspace(),turn=await finished(w),before=await counts(w);
  assert.deepEqual(before,{versions:0,links:0});
  const first=await save(w.a,turn);
  assert.deepEqual(await save(w.a,turn),first);
  assert.deepEqual(await counts(w),{versions:1,links:1});
  const [saved]=await list(w.a,w.f);
  assert.deepEqual([saved.artifactId,saved.body,saved.turnId],[first.artifactId,'WORK_RESULT_BODY',Number(turn)]);
  const raced=await finished(w,{text:'WORK_RESULT_RACED'}),p1=await peer(),p2=await peer();
  try{
   const [one1,two]=await Promise.all([save(w.a,raced,p1),save(w.a,raced,p2)]);
   assert.deepEqual(one1,two);
  }finally{await p1.end();await p2.end();}
  assert.deepEqual(await counts(w),{versions:2,links:2});
  // The result holds the billing row (0432's foreign key), as a finalized report does.
  await c.query('begin');
  await c.query('delete from turn_call_raw where turn_id=$1',[turn]);await c.query('delete from turn_calls where turn_id=$1',[turn]);
  assert.match(await refusal(c.query('delete from turns where actor_id=$1 and id=$2',[w.actor,turn])),/opc_result_links_turn_fkey/);
  await c.query('rollback');
 }
 // Refused, and nothing written: a foreign or unknown turn, an unfinished one, a failed one, no Skill, an ordinary conversation, an
 // archived business. A failed save leaves the turn and the balance as they were.
 {
  const w=await workspace(),other=await workspace(),turn=await finished(w);
  assert.match(await refusal(save(other.a,turn)),/OPC_RESULT_DENIED/);
  assert.match(await refusal(save(w.a,987654321)),/OPC_RESULT_DENIED/);
  const running=await open(w.a,{session:w.f.session,pol:policy({workSkill:w.skill})});
  assert.match(await refusal(save(w.a,running.turnId)),/OPC_RESULT_DENIED/);
  await close(w.a,running.turnId,'failed',{messages:[],delivered:false});
  assert.match(await refusal(save(w.a,running.turnId)),/OPC_RESULT_DENIED/);
  assert.match(await refusal(save(w.a,await finished(w,{workSkill:null}))),/OPC_SKILL_RESULT_REQUIRED/);
  const plain=await account(),o=await open(plain);
  await close(plain,o.turnId);
  assert.match(await refusal(save(plain,o.turnId)),/OPC_RESULT_DENIED/);
  await c.query('update opc_businesses set archived_at=now() where actor_id=$1',[w.actor]);
  assert.match(await refusal(save(w.a,turn)),/OPC_BUSINESS_ARCHIVED/);
  assert.deepEqual(await counts(w),{versions:0,links:0});
 }
 // Deletion: the conversation's delete cleans the link's evidence and counts the saved version, which stays readable to its owner as an
 // old result does; a new save of its turns is refused, and the delete's cleanup repeats safely.
 {
  const w=await workspace(),turn=await finished(w),other=await finished(w,{text:'WORK_RESULT_UNSAVED'});
  await save(w.a,turn);
  const marked=await one('select content_erasure_mark_session($1,$2) v',[w.actor,w.f.session]);
  assert.equal(marked.status,'deleted');
  assert.equal(marked.preservedSavedVersions,1);
  assert.match(await refusal(save(w.a,other)),/OPC_RESULT_DENIED/);
  const [kept]=await list(w.a,w.f);
  assert.deepEqual([kept.sourceAvailable,kept.body],[false,'WORK_RESULT_BODY']);
  assert.equal(await one(`select bool_and(e.erased_at is not null and e.payload is null) v from artifact_evidence e
   join opc_result_links l on l.evidence_id=e.id where l.turn_actor_id=$1`,[w.actor]),true,'the link evidence is cleaned with the conversation');
  assert.equal((await one('select content_erasure_mark_session($1,$2) v',[w.actor,w.f.session])).alreadyDeleted,true);
  // Racing: a delete that holds the session makes the save wait; once it commits the save is refused.
  const r=await workspace(),rt=await finished(r),p1=await peer(),p2=await peer();
  try{
   await p1.query('begin');await p1.query('select content_erasure_mark_session($1,$2)',[r.actor,r.f.session]);
   const late=save(r.a,rt,p2).then(()=>null,e=>e.message);
   await new Promise(done=>setTimeout(done,200));
   await p1.query('commit');
   assert.match(await late,/OPC_RESULT_DENIED/);
  }finally{await p1.end();await p2.end();}
  assert.deepEqual(await counts(r),{versions:0,links:0});
 }
 report.checks.push('V2-10b: opc_work_check allows, refuses archived and non-video; a turn result saved once under repeat and race, listed by turn',
  'V2-10b: foreign, unfinished, failed, Skill-less, ordinary and archived saves refused with nothing written',
  'V2-10b: a conversation delete covers the turn result (evidence cleaned, saved version counted and readable, racing save refused)');
}
