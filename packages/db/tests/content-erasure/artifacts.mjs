/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc} from '../erasure-b2a/cases.mjs';
import {erase} from './cases.mjs';
export async function runArtifacts(db,report){
 const seed=async()=>{const f=await fixture(db);return (await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;};
 const f=await seed();
 const conversation=randomUUID(),turn=randomUUID(),unrelated=randomUUID();
 await db.query("INSERT INTO conversations(id,user_id,title) VALUES($1,$2,'KEEP_OTHER_CONVERSATION')",[unrelated,f.actor]);
 await assert.rejects(db.query('UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=now() WHERE id=$1',
  [unrelated]),/ACCOUNT_ERASURE_NOT_CLOSED/);
 await db.query(`INSERT INTO conversations(id,user_id,title,summary,summary_metadata,skill_mode,module_id)
  VALUES($1,$2,'GUIDED_PRIVATE_TITLE','GUIDED_PRIVATE_SUMMARY','{"text":"GUIDED_PRIVATE_METADATA"}',true,$3)`,
  [conversation,f.actor,f.module]);
 await db.query("INSERT INTO artifact_chats VALUES($1,$2,$3,'s')",[conversation,f.project,f.round]);
 await db.query(`INSERT INTO artifact_chat_turns(request_id,conversation_id,step_id,body,evidence_ids)
  VALUES($1,$2,'s','GUIDED_PRIVATE_TURN','[]')`,[turn,conversation]);
 await db.query(`INSERT INTO conversation_context_snapshots(conversation_id,snapshot_type,content,metadata)
  VALUES($1,'rolling_summary','GUIDED_PRIVATE_SNAPSHOT','{"text":"GUIDED_PRIVATE_METADATA"}')`,[conversation]);
 assert.match(JSON.stringify(await rpc(db,'artifact_chat',f.actor,'stats',null,{})),new RegExp(conversation));

 assert.match(JSON.stringify(await rpc(db,'artifact_query',f.actor,'projects',null,null)),new RegExp(f.project));
 assert.equal(await rpc(db,'opc_source_allowed',f.actor,f.version),true);
 assert.equal(await rpc(db,'opc_content_allowed',f.actor,f.content),true);
 assert.match(JSON.stringify(await rpc(db,'opc_library',f.actor,'',null,null)),/D7_INDEPENDENT_SAVED_BODY/);
 assert.equal((await erase(db,f,'session',f.session)).status,'deleted');
 assert.match(JSON.stringify(await rpc(db,'opc_library',f.actor,'',null,null)),/D7_INDEPENDENT_SAVED_BODY/,
  'independent saved content stays listed without a live session join');
 assert.equal((await erase(db,f,'artifact',f.project)).status,'deleted');
 assert.equal((await erase(db,f,'artifact',f.project)).alreadyDeleted,true);
 assert.doesNotMatch(JSON.stringify(await rpc(db,'artifact_query',f.actor,'projects',null,null)),new RegExp(f.project));
 const replacement=randomUUID();
 await db.query(`INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account,work_title)
  VALUES($1,$2,$3,$4,'replacement','NEW_GUIDED_PROJECT')`,[replacement,f.actor,f.module,f.skill]);
 const projects=await rpc(db,'artifact_query',f.actor,'projects',null,null);
 const eligible=projects.filter(p=>p.moduleId===f.module&&p.skillId===f.skill);
 assert.ok(eligible.some(p=>p.projectId===replacement),'replacement remains selectable under the same Skill');
 assert.ok(eligible.every(p=>p.projectId!==f.project),'Skill re-entry cannot select the erased non-social project');
 report.checks.push('project listing omits erased guided artifacts and retains a replacement under the same Skill');

 const guided=(await db.query('SELECT title,summary,summary_metadata,erased_at,is_deleted FROM conversations WHERE id=$1',[conversation])).rows[0];
 assert.equal((await db.query('SELECT title FROM conversations WHERE id=$1',[unrelated])).rows[0].title,'KEEP_OTHER_CONVERSATION');
 assert.equal(guided.title,null);assert.equal(guided.summary,null);assert.equal(guided.summary_metadata,null);
 assert.ok(guided.erased_at);assert.equal(guided.is_deleted,'true');
 const chatTurn=(await db.query('SELECT body,erased_at FROM artifact_chat_turns WHERE request_id=$1',[turn])).rows[0];
 assert.equal(chatTurn.body,null);assert.ok(chatTurn.erased_at);
 const snapshot=(await db.query('SELECT content,metadata,erased_at FROM conversation_context_snapshots WHERE conversation_id=$1',[conversation])).rows[0];
 assert.equal(snapshot.content,null);assert.equal(snapshot.metadata,null);assert.ok(snapshot.erased_at);
 assert.doesNotMatch(JSON.stringify(await rpc(db,'artifact_chat',f.actor,'stats',null,{})),new RegExp(conversation));
 for(const action of ['read','context','submit','attach'])
  await assert.rejects(rpc(db,'artifact_chat',f.actor,action,conversation,{projectId:f.project,roundId:f.round}),/CONTENT_ERASED/);
 await assert.rejects(db.query(`INSERT INTO artifact_chat_turns(request_id,conversation_id,step_id,body,evidence_ids)
  VALUES($1,$2,'s','LATE_GUIDED_BODY','[]')`,[randomUUID(),conversation]),/CONTENT_ERASED/);
 await assert.rejects(db.query("UPDATE conversations SET is_deleted='false' WHERE id=$1",[conversation]));
 report.checks.push('guided artifact chats scrub turns/snapshots/conversation text, disappear from stats, and deny read/replay/late insert/restore');

 await assert.rejects(rpc(db,'artifact_query',f.actor,'read',f.project,f.round),/CONTENT_ERASED/);
 assert.equal(await rpc(db,'opc_source_allowed',f.actor,f.version),false);
 assert.equal(await rpc(db,'opc_content_allowed',f.actor,f.content),false);
 assert.equal(await rpc(db,'content_erasure_saved_readable',f.actor,f.content),true);
 const library=await rpc(db,'opc_library',f.actor,'',null,null);
 assert.match(JSON.stringify(library),/D7_INDEPENDENT_SAVED_BODY/);
 assert.doesNotMatch(JSON.stringify(library),/D7_SOURCE_BODY/);
 const stored=(await db.query('SELECT report,report_hash,erased_at FROM artifact_versions WHERE id=$1',[f.version])).rows[0];
 assert.equal(stored.report,null);assert.equal(stored.report_hash,null);assert.ok(stored.erased_at);
 await db.query('UPDATE modules SET active=false WHERE id=$1',[f.module]);
 assert.equal(await rpc(db,'content_erasure_saved_readable',f.actor,f.content),false,'deletion does not bypass current package access');
 report.checks.push('real FK artifact family erasure, source read denied, independent saved body stays listed, package revocation still denied');
 const g=await seed();
 const second=randomUUID(),third=randomUUID();
 await db.query(`INSERT INTO opc_content_versions(id,actor_id,work_item_id,kind,version,status,body,request_id,source_content_id)
 VALUES($1,$3,$4,'script',2,'final','DELETE_ALL_SCRIPT_VERSIONS',$5,$6),
 ($2,$3,$4,'storyboard',1,'final','KEEP_INDEPENDENT_STORYBOARD',$7,$1)`,
 [second,third,g.actor,g.workItem,randomUUID(),g.content,randomUUID()]);
 await db.query(`INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
  VALUES($1,1,$2,'{}','{"brief":"DELETE_COPIED_MATERIAL"}',$3)`,[g.session,g.content,'a'.repeat(64)]);
 await db.query('INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES($1,$2,$3,$4)',
  [g.actor,randomUUID(),{}, {id:g.content,body:'DELETE_CACHED_BODY'}]);
 assert.equal((await erase(db,g,'content',g.content)).status,'deleted');
 assert.equal((await db.query('SELECT content FROM runtime_scope_material WHERE session_id=$1',[g.session])).rows[0].content,null);
 assert.equal((await db.query('SELECT result FROM opc_library_requests WHERE actor_id=$1',[g.actor])).rows[0].result,null);
 assert.equal((await db.query('SELECT count(*) n FROM opc_content_versions WHERE id=ANY($1::uuid[]) AND body IS NULL AND erased_at IS NOT NULL',[[g.content,second]])).rows[0].n,'2');
 assert.equal((await db.query('SELECT body FROM opc_content_versions WHERE id=$1',[third])).rows[0].body,'KEEP_INDEPENDENT_STORYBOARD');
 assert.equal(await rpc(db,'opc_content_allowed',g.actor,third),false,'source ancestry invalidated');
 assert.equal(await rpc(db,'content_erasure_saved_readable',g.actor,third),true,'independent saved descendant remains readable');
 assert.equal((await erase(db,g,'content',second)).alreadyDeleted,true);
 report.checks.push('whole saved-kind family clears every version; independent downstream body retained with source unavailable');
 const items=library=>library.businesses.flatMap(b=>b.accounts.flatMap(a=>a.items));
 const remaining=items(await rpc(db,'opc_library',g.actor,'',null,null)).find(i=>i.workItemId===g.workItem);
 assert.ok(remaining);assert.deepEqual(remaining.content.map(c=>c.id),[third]);
 assert.equal(remaining.content[0].body,'KEEP_INDEPENDENT_STORYBOARD');
 assert.equal(remaining.content[0].sourceAvailable,false);
 await erase(db,g,'artifact',g.workItem);
 for(const search of ['', 'independent'])
  assert.ok(items(await rpc(db,'opc_library',g.actor,search,null,null)).every(i=>i.workItemId!==g.workItem));
 report.checks.push('library filters erased content versions/work-item roots in refresh and search, retaining live descendants with erased sources');

}
