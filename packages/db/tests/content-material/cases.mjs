/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture,outcome,call,evidence} from '../erasure-b2a/cases.mjs';
import {runtimeFixture,erase} from '../content-erasure/cases.mjs';

const latest=async(db,session)=>(await db.query(
 'SELECT * FROM runtime_scope_material WHERE session_id=$1 ORDER BY revision DESC LIMIT 1',[session])).rows[0];
const count=async(db,session)=>(await db.query(
 'SELECT count(*)::int n FROM runtime_scope_material WHERE session_id=$1',[session])).rows[0].n;
const legacy=async(db,label)=>(await db.query('SELECT v FROM a1_test.legacy WHERE label=$1',[label])).rows[0].v;
const def=async(db,sig)=>(await db.query('SELECT pg_get_functiondef($1::regprocedure) d',[sig])).rows[0].d;

// A completed, settled execution created directly in the work-item session (same pattern as R9).
async function workExecution(db,body){
 const f=await runtimeFixture(db,{settled:true});
 const art=(await db.query('SELECT a1_test.link(d7_test.artifacts($1)) v',[f.actor])).rows[0].v;
 const scope=(await db.query('SELECT scope FROM runtime_sessions WHERE id=$1',[art.session])).rows[0].scope;
 const run=await rpc(db,'bill2_prepare',f.actor,randomUUID(),{...f.payload,scope}),execution=randomUUID();
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,result,billing_run_id)
  VALUES($1,$2,$3,$4,'{}',0,'completed',$5,$6)`,[execution,f.actor,art.session,randomUUID(),{...outcome,body},run.id]);
 await db.query('UPDATE bill2_runs SET session_ref=$2 WHERE id=$1',[run.id,art.session]);
 const c=await call(db,{...f,run:run.id});
 await rpc(db,'bill2_record',f.actor,run.id,c.id,evidence(c));
 await rpc(db,'bill2_close',f.actor,run.id,'delivered',outcome);
 await rpc(db,'bill2_finalize',f.actor,run.id);
 return {...f,art,execution,run:run.id,session:art.session};
}

export async function runCases(db,report){
 // Backfill: one header-only revision appended; frozen history untouched; pending binding skipped.
 const plain=await legacy(db,'plain'),pending=await legacy(db,'pending');
 const head=await latest(db,plain.session);
 assert.equal(head.revision,'2');
 assert.equal(head.request_id,(await db.query("SELECT md5($1||':material-reproject-v1')::uuid u",[plain.session])).rows[0].u);
 assert.doesNotMatch(head.content.brief,/A1_LEGACY_SAVED_BODY/);
 assert.match(head.content.brief,/^内容类型：video\n标题：independent title\n简报：independent brief$/);
 const first=(await db.query('SELECT content FROM runtime_scope_material WHERE session_id=$1 AND revision=1',[plain.session])).rows[0];
 assert.match(first.content.brief,/A1_LEGACY_SAVED_BODY/,'frozen revision evidence is never rewritten');
 assert.equal(await count(db,pending.session),2,'unfinished legacy video binding keeps its revision current');
 report.checks.push('legacy saved-body sessions get one header-only revision; history kept; pending video binding skipped');
 const videoDone=await legacy(db,'videodone'),videoHead=await latest(db,videoDone.session);
 assert.equal(videoHead.revision,'2','a finished video-preparation revision is reprojected');
 assert.doesNotMatch(videoHead.content.brief,/A1_VIDEO_BOUND_BODY/);
 assert.match(videoHead.content.brief,/^内容类型：video\n标题：independent title\n简报：independent brief$/);
 report.checks.push('a finished legacy video-preparation body is reprojected to header-only material');

 // New work items from a handoff start with content type and title, not only the brief.
 assert.match(await def(db,'opc_handoff(uuid,uuid,uuid,uuid,jsonb)'),/opc_work_material_payload\(wid\)/);
 const h=(await db.query('SELECT a1_test.link(d7_test.artifacts($1)) v',[pending.fixture.actor])).rows[0].v;
 const ctx=(await db.query(`SELECT d.draft_id,a.platform,a.account_key,a.revision,i.plan_id FROM opc_drafts d,opc_items i
  JOIN opc_accounts a ON a.project_id=i.account_project_id WHERE d.project_id=$1 AND i.work_item_id=$2`,[h.project,h.workItem])).rows[0];
 const key=randomUUID();
 const body=[{id:key,platform:ctx.platform,account:ctx.account_key,title:'A1 交接标题',brief:'A1 交接简报',day:'2026-10-14',contentType:'video'}];
 const plan=(await db.query(`INSERT INTO opc_plans(id,draft_id,version,source_version_id,request_id,request,body)
  VALUES(gen_random_uuid(),$1,2,$2,gen_random_uuid(),jsonb_build_object('sourceVersionId',$2::uuid),$3) RETURNING id`,
  [ctx.draft_id,h.version,JSON.stringify(body)])).rows[0].id;
 const handed=await rpc(db,'opc_handoff',pending.fixture.actor,ctx.draft_id,randomUUID(),plan,
  JSON.stringify([{platform:ctx.platform,account:ctx.account_key,expectedRevision:Number(ctx.revision)}]));
 const fresh=await latest(db,handed[0].sessionId);
 assert.equal(fresh.revision,'1');assert.equal(await count(db,handed[0].sessionId),1);
 assert.match(fresh.content.brief,/^内容类型：video\n标题：A1 交接标题\n简报：A1 交接简报$/);
 report.checks.push('a new handoff starts its topic material with content type, title and brief');

 // Both save paths keep their D7 guards and no longer write scope material.
 for(const sig of ['opc_content_from_execution(uuid,uuid,uuid,bigint,text,text,uuid,uuid)',
  'opc_content_manual_save(uuid,uuid,uuid,bigint,uuid,text,text,text,text)']){
  const d=await def(db,sig);
  assert.match(d,/-- D7 read boundary/);assert.match(d,/-- A1 saved bodies stay out of scope material/);
  assert.doesNotMatch(d,/runtime_material\(/);
 }
 report.checks.push('content save functions keep D7 read boundary and contain no material write');

 // Long final script saved manually and from an execution: no material revision, body never projected.
 const long='长'.repeat(19980)+'A1_LONG_BODY';
 const w=await workExecution(db,long);
 const before=await count(db,w.session);
 const fromRun=await rpc(db,'opc_content_from_execution',w.actor,w.art.workItem,randomUUID(),1,'script','final',w.execution,w.art.content);
 assert.equal(fromRun.version,2);
 const manual=await rpc(db,'opc_content_manual_save',w.actor,w.art.workItem,randomUUID(),2,fromRun.id,'script','final','t',long);
 assert.equal(manual.version,3);
 assert.equal(await count(db,w.session),before,'final saves append no scope material');
 const material=(await db.query('SELECT coalesce(string_agg(content::text,\'\'),\'\') t FROM runtime_scope_material WHERE session_id=$1',[w.session])).rows[0].t;
 assert.doesNotMatch(material,/A1_LONG_BODY/);
 report.checks.push('near-20000-character final saves (manual and from execution) write no scope material');

 // Item edits still refresh the header material; the library exposes the bound version.
 const edit=await rpc(db,'opc_library_edit',w.actor,randomUUID(),'item',w.art.workItem,1,
  {title:'A1 标题',brief:'A1 简报',day:'2026-10-13',contentType:'video'});
 assert.equal(edit.revision,2);
 const refreshed=await latest(db,w.session);
 assert.equal(refreshed.content.brief,'内容类型：video\n标题：A1 标题\n简报：A1 简报');
 const lib=await rpc(db,'opc_library',w.actor,'',null,null);
 const items=lib.businesses.flatMap(b=>b.accounts.flatMap(a=>a.items));
 const item=items.find(i=>i.workItemId===w.art.workItem);
 assert.equal(item.sourceVersionId,w.art.version);
 assert.equal(lib.businesses.find(b=>b.accounts.some(a=>a.items.some(i=>i.workItemId===w.art.workItem))).sourceVersionId,w.art.version);
 report.checks.push('item edit still writes header material; library items expose the bound positioning version');

 await briefAdoption(db,report);
}

async function briefAdoption(db,report){
 const original='简报更新：面向新手的三步拍摄法';
 const w=await workExecution(db,'整理本选题\n'+original+'\n待办：拍样片');
 const adopt=(rid,brief='用户改过的简报',orig=original,f=w,exec=w.execution,rev=1)=>
  rpc(db,'opc_brief_adoption',f.actor,rid,f.art.workItem,rev,exec,orig,brief);
 const rid=randomUUID();
 const result=await adopt(rid);
 assert.equal(result.revision,2);
 assert.deepEqual(await adopt(rid),result,'replay returns the same result');
 const ed=(await db.query('SELECT * FROM opc_item_edits WHERE work_item_id=$1',[w.art.workItem])).rows[0];
 assert.equal(ed.brief,'用户改过的简报');assert.equal(ed.title,'independent title');assert.equal(ed.content_type,'video');
 const events=(await db.query("SELECT * FROM opc_data_events WHERE actor_id=$1 AND action='brief_adoption'",[w.actor])).rows;
 assert.equal(events.length,1);assert.equal(events[0].original,original);assert.equal(events[0].adopted,'用户改过的简报');
 assert.equal(events[0].execution_id,w.execution);assert.equal(events[0].target_project_id,w.art.workItem);
 assert.equal((await latest(db,w.session)).content.brief,'内容类型：video\n标题：independent title\n简报：用户改过的简报');
 report.checks.push('allow: brief adopted from execution saves user text, records AI original vs adopted, refreshes material, replays');

 await assert.rejects(adopt(rid,'另一个简报'),/OPC_REQUEST_CONFLICT/);
 await assert.rejects(adopt(randomUUID(),'旧版本上的修改'),/OPC_VERSION_CONFLICT/);
 await assert.rejects(adopt(randomUUID(),'z','不在回复里的原文',w,w.execution,2),/OPC_DATA_SOURCE_DENIED/);
 await assert.rejects(adopt(randomUUID(),'x'.repeat(2001),original,w,w.execution,2),/OPC_DATA_EVENT_INVALID/);
 const other=await fixture(db);
 await assert.rejects(adopt(randomUUID(),'z',original,{...w,actor:other.actor},w.execution,2),/OPC_DATA_SOURCE_DENIED|BILL2_ACTOR/);
 const elsewhere=await workExecution(db,original);
 await assert.rejects(adopt(randomUUID(),'z',original,w,elsewhere.execution,2),/OPC_DATA_SOURCE_DENIED/);
 for(const role of ['anon','authenticated']){
  await db.query('SET ROLE '+role);
  await assert.rejects(adopt(randomUUID(),'z',original,w,w.execution,2),/permission denied/);
  await db.query('RESET ROLE');
 }
 report.checks.push('deny: request conflict, stale revision, fabricated original, over-long brief, foreign actor, other session, client roles');

 // Erasing the source answer (internal D7 path) removes the adoption copies; the saved brief stays.
 await erase(db,w);
 assert.equal((await db.query("SELECT count(*)::int n FROM opc_data_events WHERE actor_id=$1 AND action='brief_adoption'",[w.actor])).rows[0].n,0);
 assert.equal((await db.query('SELECT brief FROM opc_item_edits WHERE work_item_id=$1',[w.art.workItem])).rows[0].brief.length>0,true);
 await assert.rejects(adopt(rid),/OPC_DATA_SOURCE_DENIED|CONTENT_ERASED/);
 report.checks.push('D7 erasure of the source execution removes brief_adoption copies; replay cannot revive them');
}
