/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-10b C2: a work item's saved content by turn (0450): the turn twins of *_from_execution, video material, deletion, erasure.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function workContentCases(t){
 const {c,one,open,begin,record,close,account,policy,refusal,report}=t;
 const asService=async run=>{await c.query('set role service_role');try{return await run();}finally{await c.query('reset role');}};
 const call=(sql,args)=>asService(()=>one(`select ${sql} v`,args));
 const workspace=async()=>{const a=await account(1000),f=await one('select d7_test.artifacts($1) v',[a.actor]);
  await c.query(`update artifact_projects w set source_project_id=i.account_project_id from opc_items i
   where i.work_item_id=w.id and w.id=$1`,[f.workItem]);
  return {a,f,actor:a.actor,item:f.workItem,session:f.session};};
 const turn=async(w,{text='CONTENT_BODY',kind='completed',extra={},request=randomUUID(),user='请写'}={})=>{
  const o=await open(w.a,{session:w.session,request,pol:policy(extra)});
  await begin(w.a,o.turnId,1);await record(w.a,o.turnId,1);
  await close(w.a,o.turnId,kind,kind==='completed'?{messages:[{role:'user',content:user},{role:'assistant',content:text}]}:{messages:[],delivered:false});
  return {id:o.turnId,request};};
 const save=(w,{request=randomUUID(),expected,kind='script',status='final',id,source=null})=>
  call('opc_content_from_turn($1,$2,$3,$4,$5,$6,$7,$8)',[w.actor,w.item,request,expected,kind,status,id,source]);
 const latest=async(w,kind)=>Number(await one('select coalesce(max(version),0) v from opc_content_versions where work_item_id=$1 and kind=$2',[w.item,kind]));
 const prepare=(w,request,script,{story=true,edit=false}={})=>call('opc_video_material_prepare($1,$2,$3,$4,$5,$6,$7,$8)',
  [w.actor,w.item,request,script,story,edit,0,0]);
 const results=(w,request,id,script,{story=true,edit=false}={})=>call('opc_video_results_from_turn($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [w.actor,w.item,request,id,script,0,0,story,edit]);
 const work=(w,request)=>call('opc_work_check($1,$2,$3,$4)',[w.actor,w.session,false,request]);
 const hold=m=>({workMaterial:{revision:m.work.materialRevision,hash:m.work.materialHash}});
 const version=id=>one('select to_jsonb(c.*) v from opc_content_versions c where id=$1',[id]);
 // Saved by its turn: repeated safely, with the turn's reply, in the library; every refusal of the execution twin, nothing written.
 {
  const w=await workspace(),other=await workspace(),r=await turn(w),e=await latest(w,'script'),request=randomUUID();
  const saved=await save(w,{request,expected:e,id:r.id});
  assert.deepEqual([saved.body,saved.version,saved.status],['CONTENT_BODY',e+1,'final']);
  assert.deepEqual(await save(w,{request,expected:e,id:r.id}),saved,'a repeat returns the same version');
  const row=await version(saved.id);
  assert.deepEqual([row.turn_id,row.turn_actor_id,row.execution_id],[Number(r.id),w.actor,null]);
  const library=await one("select opc_library_before_workspace_ui($1,'',null,null) v",[w.actor]);
  assert.ok(JSON.stringify(library).includes(`"turnId":${Number(r.id)}`),'the library names the turn');
  assert.match(await refusal(save(w,{request,expected:e+1,id:r.id})),/OPC_REQUEST_CONFLICT/);
  assert.match(await refusal(save(w,{expected:e,id:(await turn(w)).id})),/OPC_VERSION_CONFLICT/);
  assert.match(await refusal(save(other,{expected:0,id:r.id})),/OPC_CONTENT_DENIED/);
  const failed=await turn(w,{kind:'failed'});
  assert.match(await refusal(save(w,{expected:e+1,id:failed.id})),/OPC_CONTENT_DENIED/);
  const running=await open(w.a,{session:w.session});
  assert.match(await refusal(save(w,{expected:e+1,id:running.turnId})),/OPC_CONTENT_DENIED/);
  await close(w.a,running.turnId,'failed',{messages:[],delivered:false});
  assert.match(await refusal(save(w,{expected:0,kind:'bad',id:r.id})),/OPC_CONTENT_INVALID|violates/);
  // One source only, and the billing row is held, as a turn result's.
  await c.query('begin');
  assert.match(await refusal(c.query('update opc_content_versions set execution_id=$2 where id=$1',[saved.id,randomUUID()])),/one_source|foreign key|immutable|ARTIFACT/i);
  await c.query('rollback');
  await c.query('begin');
  await c.query('delete from turn_call_raw where turn_id=$1',[r.id]);await c.query('delete from turn_calls where turn_id=$1',[r.id]);
  assert.match(await refusal(c.query('delete from turns where actor_id=$1 and id=$2',[w.actor,r.id])),/opc_content_versions_turn_fkey/);
  await c.query('rollback');
  // A manual revision of a turn's script keeps a root, as of an execution's.
  await call('opc_content_manual_save($1,$2,$3,$4,$5,$6,$7,$8,$9)',[w.actor,w.item,randomUUID(),e+1,saved.id,'script','final','手改','手改正文']);
  await c.query('update opc_businesses set archived_at=now() where actor_id=$1',[w.actor]);
  assert.match(await refusal(save(w,{expected:e+2,id:r.id})),/OPC_BUSINESS_ARCHIVED/);
 }
 // The size limit of a saved content (retired suite content-material, 0229): a body of exactly 20000 characters is saved, 20001 is refused, for a
 // turn's reply and for a manual revision alike; a title of 160 is saved, 161 refused. Nothing is written by a refusal.
 {
  const w=await workspace(),count=async()=>Number(await one('select count(*) v from opc_content_versions where work_item_id=$1',[w.item]));
  const exact=await turn(w,{text:'a'.repeat(20000)}),over=await turn(w,{text:'a'.repeat(20001)});
  const first=await save(w,{expected:await latest(w,'script'),id:exact.id});
  assert.equal(first.body.length,20000,'a reply of exactly 20000 characters is saved whole');
  const before=await count();
  assert.match(await refusal(save(w,{expected:await latest(w,'script'),id:over.id})),/OPC_CONTENT_INVALID/,'20001 characters are refused');
  assert.equal(await count(),before,'a refusal writes nothing');
  const e=await latest(w,'script');
  const ok=await call('opc_content_manual_save($1,$2,$3,$4,$5,$6,$7,$8,$9)',[w.actor,w.item,randomUUID(),e,first.id,'script','final','t'.repeat(160),'b'.repeat(20000)]);
  assert.deepEqual([ok.body.length,ok.version],[20000,e+1],'a manual revision of exactly 20000 characters with a 160-character title is saved');
  const again=await latest(w,'script');
  for(const [body,title] of [['b'.repeat(20001),'标题'],['b','t'.repeat(161)]])
   assert.match(await refusal(call('opc_content_manual_save($1,$2,$3,$4,$5,$6,$7,$8,$9)',[w.actor,w.item,randomUUID(),again,first.id,'script','final',title,body])),/OPC_CONTENT_INVALID/);
  assert.equal(await latest(w,'script'),again,'a refused manual revision writes nothing');
  report.checks.push('content size: a reply or a manual revision of exactly 20000 characters is saved, 20001 refused (OPC_CONTENT_INVALID), a title of 160 saved and 161 refused; a refusal writes nothing');
 }
 // A storyboard or editing saved from chat reads the source its turn froze; any other is refused.
 {
  const w=await workspace(),script=await save(w,{expected:await latest(w,'script'),id:(await turn(w)).id});
  const r=await turn(w,{text:'STORYBOARD_BODY',extra:{workSource:{contentId:script.id,kind:'script'}}}),e=await latest(w,'storyboard');
  assert.match(await refusal(save(w,{kind:'storyboard',expected:e,id:(await turn(w)).id})),/OPC_CONTENT_SOURCE/);
  assert.match(await refusal(save(w,{kind:'storyboard',expected:e,id:r.id,source:randomUUID()})),/OPC_CONTENT_SOURCE/);
  const story=await save(w,{kind:'storyboard',expected:e,id:r.id});
  assert.equal((await version(story.id)).source_content_id,script.id);
  const source=await call('opc_work_source($1,$2,$3)',[w.actor,w.session,'storyboard']);
  assert.deepEqual([source.status,source.contentId],['ready',story.id]);
  assert.deepEqual(await call('opc_work_source($1,$2,$3)',[w.a.actor,w.a.session,'script']),{status:'none'});
 }
 // CONTENT-CONVERSATION-2 (0541): a topic-window turn is given the final script and that script's newest storyboard as a list
 // (opc_work_check 'sources', frozen as policy.workSources); a storyboard and editing advice are saved from it, the check after the
 // open covers every listed source, and deleting one reaches the turns given it.
 {
  const w=await workspace(),script=await save(w,{expected:await latest(w,'script'),id:(await turn(w,{text:'LIST_SCRIPT'})).id});
  const list=sources=>({workSources:sources.map(s=>({contentId:s.contentId,kind:s.kind}))});
  let sources=(await work(w,randomUUID())).work.sources;
  assert.deepEqual(sources.map(s=>[s.kind,s.contentId,s.body]),[['script',script.id,'LIST_SCRIPT']],'a final script, no storyboard yet');
  // A request that claimed video material keeps the old package flow: no list.
  const claimed=randomUUID();await prepare(w,claimed,script.id);
  assert.deepEqual((await work(w,claimed)).work.sources,[]);
  const r=await turn(w,{text:'LIST_STORY',extra:list(sources)});
  assert.match(await refusal(save(w,{kind:'editing',expected:await latest(w,'editing'),id:r.id})),/OPC_CONTENT_SOURCE/,'no storyboard was given');
  const story=await save(w,{kind:'storyboard',expected:await latest(w,'storyboard'),id:r.id});
  assert.equal((await version(story.id)).source_content_id,script.id);
  sources=(await work(w,randomUUID())).work.sources;
  assert.deepEqual(sources.map(s=>[s.kind,s.contentId]),[['script',script.id],['storyboard',story.id]]);
  const both=await turn(w,{text:'LIST_EDIT',extra:list(sources)});
  const edit=await save(w,{kind:'editing',expected:await latest(w,'editing'),id:both.id});
  assert.equal((await version(edit.id)).source_content_id,story.id,'editing advice reads the listed storyboard');
  const story2=await save(w,{kind:'storyboard',expected:await latest(w,'storyboard'),id:both.id});
  assert.equal((await version(story2.id)).source_content_id,script.id,'a revised storyboard reads the listed script');
  const verify=id=>call('opc_work_verify($1,$2)',[w.actor,id]);
  const opened=await open(w.a,{session:w.session,pol:policy(list(sources))});
  assert.equal(await verify(opened.turnId),true);
  await close(w.a,opened.turnId,'failed',{messages:[],delivered:false});
  const scope=(await one("select content_erasure_scope($1,'content',$2) v",[w.actor,story.id])).turns.map(Number);
  assert.ok(scope.includes(Number(both.id)),'deleting the storyboard reaches the turn given it in the list');
  const hash=(await one("select content_erasure_preview($1,'content',$2) v",[w.actor,story.id])).previewHash;
  await one("select content_erasure_confirm($1,'content',$2,$3) v",[w.actor,story.id,hash]);
  const after=await open(w.a,{session:w.session,pol:policy(list(sources))});
  assert.equal(await verify(after.turnId),false,'a listed source was deleted');
  await close(w.a,after.turnId,'failed',{messages:[],delivered:false});
  report.checks.push('CONTENT-CONVERSATION-2 0541: a video topic window is given its final script and storyboard as a list; storyboard and editing saved from it; verify and content delete cover every listed source');
 }
 // Video: a claim reads its own revision, holds it from other requests, freezes it; the package saves once.
 {
  const w=await workspace(),script=await save(w,{expected:await latest(w,'script'),id:(await turn(w,{text:'定稿口播稿'})).id});
  const request=randomUUID(),material=await prepare(w,request,script.id);
  const claim=await work(w,request);
  assert.equal(claim.work.videoPackage,true);assert.equal(claim.work.brief,'已定稿口播稿：定稿口播稿');
  assert.equal(claim.work.materialRevision,material.revision);
  // Nothing is used up by a turn: another request reads the newest material and is not held back by a claim that has not opened.
  assert.equal((await work(w,randomUUID())).work.materialRevision,material.revision);
  assert.deepEqual(await prepare(w,request,script.id).then(m=>m.revision),material.revision,'a repeated claim replays');
  // Admission refused definitely: the claim can be abandoned; once a turn holds it, it cannot.
  const other=randomUUID();
  const pkg=await turn(w,{request,text:JSON.stringify({storyboard:'分镜正文'}),extra:hold(claim),user:'[OPC_VIDEO_PACKAGE_V1] 只生成分镜'});
  assert.match(await refusal(call('opc_video_material_prepare($1,$2,$3,$4,$5,$6,$7,$8)',[w.actor,w.item,request,script.id,false,false,0,0])),/OPC_CONTENT_PENDING/);
  assert.equal((await work(w,other)).work.videoPackage,false,'after the claimant opened, normal dialogue resumes');
  assert.deepEqual((await call('opc_video_turn_check($1,$2,$3,$4)',[w.actor,w.item,pkg.id,script.id])).valid,true);
  const first=await results(w,request,pkg.id,script.id);
  assert.deepEqual(await results(w,request,pkg.id,script.id),first);
  const story=await version(first.storyboard.id);
  assert.deepEqual([story.body,story.source_content_id,story.turn_id,story.status],['分镜正文',script.id,Number(pkg.id),'final']);
  assert.match(await refusal(prepare(w,randomUUID(),script.id)),/OPC_CONTENT_ALREADY_GENERATED/);
 }
 // A claim that never opened, left behind: it blocks a second claim while young; after ten minutes it is abandoned (material revoked) so it cannot pay later.
 {
  const w=await workspace(),script=await save(w,{expected:await latest(w,'script'),id:(await turn(w,{text:'STALE'})).id}),old=randomUUID();
  await prepare(w,old,script.id);
  assert.match(await refusal(prepare(w,randomUUID(),script.id)),/OPC_CONTENT_ALREADY_GENERATED/,'a young claim blocks');
  await c.query('alter table opc_video_material_bindings disable trigger artifact_immutable');
  await c.query("update opc_video_material_bindings set created_at=now()-interval '11 minutes' where actor_id=$1 and request_id=$2",[w.actor,old]);
  await c.query('alter table opc_video_material_bindings enable trigger artifact_immutable');
  const fresh=randomUUID();
  assert.ok((await prepare(w,fresh,script.id)).revision,'an old unopened claim is skipped');
  // The old request must not pay a second time after the new one: its material is revoked with the new claim.
  assert.match(await refusal(work(w,old)),/OPC_CONTENT_BINDING/,'the old request cannot open any more');
  assert.match(await refusal(prepare(w,old,script.id)),/OPC_CONTENT_BINDING/,'nor claim again');
  assert.equal((await work(w,fresh)).work.materialRevision,(await prepare(w,fresh,script.id)).revision,'the new one reads its own revision');
 }
 // Refused packages: another turn, no frozen material, a reply that is not the package, an open claim blocks a second, a failed one retries.
 {
  const w=await workspace(),script=await save(w,{expected:await latest(w,'script'),id:(await turn(w,{text:'S'})).id});
  const r1=randomUUID();await prepare(w,r1,script.id);const claim=await work(w,r1);
  assert.match(await refusal(prepare(w,randomUUID(),script.id)),/OPC_CONTENT_ALREADY_GENERATED/,'the claim is unopened');
  const running=await open(w.a,{session:w.session,request:r1,pol:policy(hold(claim))});
  assert.match(await refusal(prepare(w,randomUUID(),script.id)),/OPC_CONTENT_ALREADY_GENERATED/,'the claim is running');
  await close(w.a,running.turnId,'failed',{messages:[],delivered:false});
  const r2=randomUUID();await prepare(w,r2,script.id);
  const claim2=await work(w,r2),bare=await turn(w,{request:r2,text:'不是 JSON'});
  assert.match(await refusal(call('opc_video_turn_check($1,$2,$3,$4)',[w.actor,w.item,bare.id,script.id])),/OPC_CONTENT_BINDING/);
  await c.query('update turns set policy=policy||$2 where id=$1',[bare.id,JSON.stringify(hold(claim2))]);
  assert.match(await refusal(results(w,r2,bare.id,script.id)),/OPC_CONTENT_RESPONSE_INVALID/);
  const stranger=await turn(w,{text:'{}'});
  assert.match(await refusal(results(w,r2,stranger.id,script.id)),/OPC_REQUEST_CONFLICT/);
 }
 // Deleting a content family takes its producing turn's reply and raw body, and what was given it; other turns stay.
 {
  const w=await workspace(),keep=await turn(w,{text:'KEEP_ME'}),e=await latest(w,'script'),r=await turn(w,{text:'ERASE_ME'});
  const script=await save(w,{expected:e,id:r.id});
  const request=randomUUID();await prepare(w,request,script.id);const claim=await work(w,request);
  const pkg=await turn(w,{request,text:JSON.stringify({storyboard:'ERASE_STORY'}),extra:hold(claim)});
  const first=await results(w,request,pkg.id,script.id);
  const scope=(await one("select content_erasure_scope($1,'content',$2) v",[w.actor,script.id])).turns.map(Number);
  assert.ok(scope.includes(Number(r.id))&&scope.includes(Number(pkg.id)));
  assert.ok(!scope.includes(Number(keep.id)));
  const previewHash=async()=>(await one("select content_erasure_preview($1,'content',$2) v",[w.actor,script.id])).previewHash;
  await one("select content_erasure_confirm($1,'content',$2,$3) v",[w.actor,script.id,await previewHash()]);
  const texts=(await c.query("select turn_id,content,visible from session_messages where session_id=$1 and role='assistant' order by seq",[w.session])).rows;
  {const m=texts.find(x=>Number(x.turn_id)===Number(keep.id));assert.deepEqual([m.content,m.visible],['KEEP_ME',true]);}
  for(const id of [r.id,pkg.id]){const m=texts.find(x=>Number(x.turn_id)===Number(id));assert.deepEqual([m.content,m.visible],['',false]);}
  assert.equal(Number(await one('select count(*) v from turn_call_raw where turn_id=any($1)',[[r.id,pkg.id]])),0);
  assert.equal(Number(await one('select count(*) v from turn_call_raw where turn_id=$1',[keep.id])),1);
  assert.equal((await version(script.id)).body,null);
  assert.equal(await one('select opc_content_allowed($1,$2) v',[w.actor,first.storyboard.id]),false,'a descendant loses its source');
  assert.match(await refusal(save(w,{expected:e+1,id:r.id})),/OPC_CONTENT_DENIED|OPC_CONTENT_INVALID/);
  await one("select content_erasure_confirm($1,'content',$2,$3) v",[w.actor,script.id,await previewHash()]);
 }
 // A turn that opened later had the reply in its history, a turn that read the claimed revision held the script: both go. A running one
 // would write after the cleanup, so the delete waits for it.
 {
  const w=await workspace(),e=await latest(w,'script'),r=await turn(w,{text:'ERASE_FIRST'});
  const script=await save(w,{expected:e,id:r.id}),request=randomUUID();
  await prepare(w,request,script.id);const claim=await work(w,request);
  const pkg=await turn(w,{request,text:JSON.stringify({storyboard:'S'}),extra:hold(claim)});
  const reading=await work(w,randomUUID());
  assert.equal(reading.work.materialRevision,claim.work.materialRevision);
  const later=await turn(w,{text:'重复：ERASE_FIRST',extra:hold(reading)});
  const scope=(await one("select content_erasure_scope($1,'content',$2) v",[w.actor,script.id])).turns.map(Number);
  assert.ok([r.id,pkg.id,later.id].every(id=>scope.includes(Number(id))));
  const running=await open(w.a,{session:w.session});
  const hash=async()=>(await one("select content_erasure_preview($1,'content',$2) v",[w.actor,script.id])).previewHash;
  assert.match(await refusal(one("select content_erasure_confirm($1,'content',$2,$3) v",[w.actor,script.id,await hash()])),/CONTENT_ERASURE_BUSY/);
  assert.equal((await version(script.id)).body,'ERASE_FIRST','a refused delete changed nothing');
  await close(w.a,running.turnId,'failed',{messages:[],delivered:false});
  await one("select content_erasure_confirm($1,'content',$2,$3) v",[w.actor,script.id,await hash()]);
  const held=await one("select count(*)::int v from session_messages where session_id=$1 and content like '%ERASE_FIRST%'",[w.session]);
  assert.equal(held,0,'no copy stays in the conversation');
 }
 // Read, then deleted, then opened: the check after the open finds it, before anything is sent.
 {
  const w=await workspace(),script=await save(w,{expected:await latest(w,'script'),id:(await turn(w,{text:'GONE'})).id}),request=randomUUID();
  await prepare(w,request,script.id);const claim=await work(w,request);
  const opened=await open(w.a,{session:w.session,request,pol:policy({...hold(claim),workSource:{contentId:script.id,kind:'script'}})});
  const verify=id=>call('opc_work_verify($1,$2)',[w.actor,id]);
  assert.equal(await verify(opened.turnId),true);
  await close(w.a,opened.turnId,'failed',{messages:[],delivered:false});
  const held=randomUUID(),late=await open(w.a,{session:w.session,request:held,pol:policy({workSource:{contentId:script.id,kind:'script'},...hold(claim)})});
  await close(w.a,late.turnId,'failed',{messages:[],delivered:false});
  const hash=(await one("select content_erasure_preview($1,'content',$2) v",[w.actor,script.id])).previewHash;
  await one("select content_erasure_confirm($1,'content',$2,$3) v",[w.actor,script.id,hash]);
  const after=await open(w.a,{session:w.session,pol:policy({workSource:{contentId:script.id,kind:'script'}})});
  assert.equal(await verify(after.turnId),false,'the deleted source');
  await close(w.a,after.turnId,'failed',{messages:[],delivered:false});
  const material=await open(w.a,{session:w.session,pol:policy(hold(claim))});
  assert.equal(await verify(material.turnId),false,'the erased material');
  await close(w.a,material.turnId,'failed',{messages:[],delivered:false});
 }
 // A resumed package: it has its own request id, is saved under the request that claimed the material, and blocks a second one.
 {
  const w=await workspace(),script=await save(w,{expected:await latest(w,'script'),id:(await turn(w,{text:'R'})).id}),request=randomUUID();
  await prepare(w,request,script.id);const claim=await work(w,request);
  const first=await open(w.a,{session:w.session,request,pol:policy(hold(claim))});
  await c.query("update turns set state='paused',pause_reason='waiting_credits' where actor_id=$1 and id=$2",[w.actor,first.turnId]);
  await c.query('set role service_role');
  const next=await one('select turn_open($1,$2,$3,$4,$5,$6) v',[w.actor,w.session,randomUUID(),'chat',JSON.stringify(policy(hold(claim))),first.turnId]);
  await c.query('reset role');
  assert.equal(await one('select opc_turn_root_request($1,$2) v',[w.actor,next.turnId]),request);
  assert.equal(Number((await one('select to_jsonb(t) v from opc_turn_latest($1,$2) t',[w.actor,request])).id),Number(next.turnId));
  assert.match(await refusal(prepare(w,randomUUID(),script.id)),/OPC_CONTENT_ALREADY_GENERATED/,'the resumed turn still holds the claim');
  await begin(w.a,next.turnId,1);await record(w.a,next.turnId,1);
  await close(w.a,next.turnId,'completed',{messages:[{role:'user',content:'[OPC_VIDEO_PACKAGE_V1] x'},{role:'assistant',content:JSON.stringify({storyboard:'RESUMED'})}]});
  const saved=await results(w,request,next.turnId,script.id);
  assert.equal((await version(saved.storyboard.id)).turn_id,Number(next.turnId));
  // The turn it continued holds raw responses of the same reply: deleting the version reaches back along the chain.
  const scope=(await one("select content_erasure_scope($1,'content',$2) v",[w.actor,saved.storyboard.id])).turns.map(Number);
  assert.ok(scope.includes(Number(first.turnId))&&scope.includes(Number(next.turnId)));
 }
 // A conversation delete keeps the saved versions readable, refuses a new save, and is not the local fast path.
 {
  const w=await workspace(),r=await turn(w,{text:'SESSION_SAVED'}),left=await turn(w),e=await latest(w,'script');
  const script=await save(w,{expected:e,id:r.id});
  const marked=await one('select content_erasure_mark_session($1,$2) v',[w.actor,w.session]);
  assert.equal(marked.status,'deleted');assert.ok(Number(marked.preservedSavedVersions)>=1);
  assert.equal((await version(script.id)).body,'SESSION_SAVED');
  assert.equal(await one('select content_erasure_saved_readable($1,$2) v',[w.actor,script.id]),true);
  assert.equal(await one('select opc_content_allowed($1,$2) v',[w.actor,script.id]),false);
  assert.match(await refusal(save(w,{expected:e+1,id:left.id})),/OPC_CONTENT_DENIED/);
 }
 // Account erasure: the proofs count a version saved by turn, the scrub clears it, another account keeps its own.
 {
  const w=await workspace(),other=await workspace();
  const script=await save(w,{expected:await latest(w,'script'),id:(await turn(w,{text:'ACCOUNT_BODY'})).id});
  const kept=await save(other,{expected:await latest(other,'script'),id:(await turn(other,{text:'OTHER_BODY'})).id});
  assert.ok(Number(await one('select account_erasure_body_remaining($1) v',[w.actor]))>0);
  await c.query("update profiles set status='deleted',is_deleted='true',deleted_at=now() where id=$1",[w.actor]);
  await c.query("insert into account_erasure_requests(profile_id,request_id,confirmed_at) values($1,$2,now()-interval '1 minute')",[w.actor,randomUUID()]);
  assert.equal(await one('select content_erasure_saved_readable($1,$2) v',[w.actor,script.id]),false,'an account being erased reads nothing');
  await one('select account_erasure_scrub_content($1) v',[w.actor]);
  await one('select account_erasure_scrub_turns($1) v',[w.actor]);
  await one('select account_erasure_scrub_runtime($1) v',[w.actor]);
  for(let i=0;i<8;i++)await one('select account_erasure_prune_business($1) v',[w.actor]);
  assert.equal(await one('select count(*)::int v from opc_content_versions where id=$1 and body is not null',[script.id]),0);
  assert.equal((await version(kept.id)).body,'OTHER_BODY');
 }
 report.checks.push('V2-10b C2: content saved by turn, repeated, refused like its execution twin, FK and one source',
  'V2-10b C2: a claimed revision is read by its own request and holds no other back; package saved once; open claim blocks a second claim, failed claim retries',
  'V2-10b C2: content delete takes the producing turns, session delete keeps saved versions, account erasure clears them');
}
