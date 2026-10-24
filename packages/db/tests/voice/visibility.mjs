/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// DB-PERF PR-2A (0352): the combined display fence answers exactly what the three separate checks answer, in one call.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {runtimeFixture} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0]?.v;
const PROFILE={tone:'像跟朋友聊天',samples:['VOICE_CANARY sample one','VOICE_CANARY sample two']};

export async function runVisibility({db,report}) {
 const svc=async(name,...args)=>{await db.query('SET ROLE service_role');try{return await rpc(db,name,...args);}finally{await db.query('RESET ROLE');}};
 const refusal=async promise=>{try{await promise;return null;}catch(error){return error.message;}};
 const outcome=async promise=>{try{return await promise;}catch(error){return {refused:error.message};}};
 const f=await runtimeFixture(db,{});
 const visibility=(voice,library,actor=f.actor)=>svc('runtime_execution_visibility',actor,f.execution,voice,library);
 // What the host used to compute with three calls, for the same flags.
 async function separate(voice,library,actor=f.actor){
  const content=await refusal(svc('content_erasure_visible',actor,f.execution));
  if(content)return {refused:content};
  if(voice&&await one(db,'SELECT count(*)::int v FROM runtime_voice_sources_gone($1,ARRAY[$2]::uuid[])',[actor,f.execution]))return 'voice';
  if(library&&await one(db,'SELECT count(*)::int v FROM runtime_library_sources_gone($1,ARRAY[$2]::uuid[])',[actor,f.execution]))return 'library';
  return 'visible';
 }
 // Every flag combination: the one call answers what the separate calls answer, and that is the expected rule.
 async function same(expected){
  for(const [voice,library] of [[false,false],[true,false],[false,true],[true,true]]){
   const combined=await outcome(visibility(voice,library)),old=await separate(voice,library);
   assert.deepEqual(combined,old,`flags ${voice}/${library}`);
   assert.equal(old.refused??old,typeof expected==='function'?expected(voice,library):expected,`flags ${voice}/${library}`);
  }
 }

 // Nothing frozen: visible whatever the flags say.
 await same('visible');
 // A confirmed voice version and a ready library document, both frozen by the execution and both still there.
 const authored=await one(db,'SELECT voice_test.doc($1,$2) v',[f.actor,'visibility-voice.md']);void authored;
 const begun=await svc('voice_generation_begin',f.actor,randomUUID(),[]);
 await svc('voice_generation_finish',f.actor,begun.version.id,JSON.stringify(PROFILE),null,true);
 await svc('voice_profile_confirm',f.actor,begun.version.id,(await svc('voice_state',f.actor)).revision,JSON.stringify(PROFILE));
 await db.query('INSERT INTO runtime_voice_references(execution_id,actor_id,version_id) VALUES($1,$2,$3)',[f.execution,f.actor,begun.version.id]);
 const document=await one(db,'SELECT voice_test.doc($1,$2,$3) v',[f.actor,'visibility-library.md','reference']);
 await db.query('INSERT INTO runtime_library_references(execution_id,actor_id,document_id,content_version,ordinal) VALUES($1,$2,$3,1,1)',
  [f.execution,f.actor,document]);
 await same('visible');
 // A newer content version is not a deletion (#1022 decision C).
 await db.query('UPDATE library_documents SET content_version=content_version+1 WHERE id=$1',[document]);
 await same('visible');
 report.checks.push('0352: visible while nothing frozen is gone, including after a newer library content version');

 // Only the library document is deleted: reported only when the host asks for the library check.
 await svc('library_delete',f.actor,document,false,false,false);
 await same((voice,library)=>library?'library':'visible');
 // The voice version is deleted too: voice first, as the host checked it first.
 await svc('voice_profile_delete',f.actor,begun.version.id);
 await same((voice,library)=>voice?'voice':library?'library':'visible');
 report.checks.push('0352: a deleted library document and a deleted voice version are each reported on their own, voice first');

 // Only the voice version is gone, on a second execution with no library reference.
 const g=await runtimeFixture(db,{});
 await one(db,'SELECT voice_test.doc($1,$2) v',[g.actor,'visibility-voice-g.md']);
 const begunG=await svc('voice_generation_begin',g.actor,randomUUID(),[]);
 await svc('voice_generation_finish',g.actor,begunG.version.id,JSON.stringify(PROFILE),null,true);
 await svc('voice_profile_confirm',g.actor,begunG.version.id,(await svc('voice_state',g.actor)).revision,JSON.stringify(PROFILE));
 await db.query('INSERT INTO runtime_voice_references(execution_id,actor_id,version_id) VALUES($1,$2,$3)',[g.execution,g.actor,begunG.version.id]);
 await svc('voice_profile_delete',g.actor,begunG.version.id);
 assert.equal(await svc('runtime_execution_visibility',g.actor,g.execution,true,true),'voice');
 assert.equal(await svc('runtime_execution_visibility',g.actor,g.execution,false,true),'visible');
 report.checks.push('0352: a deleted voice version alone is reported as voice');

 // Content erasure comes first and raises exactly as content_erasure_visible does, whatever else is gone.
 await rpc(db,'content_erasure_mark_session',f.actor,f.session);
 await same('CONTENT_ERASED');
 // Another account's execution is not found, as before.
 const other=await runtimeFixture(db,{});
 assert.equal(await refusal(visibility(true,true,other.actor)),await refusal(svc('content_erasure_visible',other.actor,f.execution)));
 assert.equal(await refusal(visibility(true,true,other.actor)),'CONTENT_NOT_FOUND');
 report.checks.push('0352: content erasure and a foreign execution refuse exactly as content_erasure_visible does');

 for(const role of ['anon','authenticated']){
  await db.query(`SET ROLE ${role}`);
  try{await assert.rejects(rpc(db,'runtime_execution_visibility',g.actor,g.execution,false,false),/permission denied/);}
  finally{await db.query('RESET ROLE');}
 }
 report.checks.push('0352: only service_role may call the combined fence');
}
