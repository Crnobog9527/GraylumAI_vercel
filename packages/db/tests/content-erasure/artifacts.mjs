/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc} from '../erasure-b2a/cases.mjs';
import {erase} from './cases.mjs';
export async function runArtifacts(db,report){
 const seed=async()=>{const f=await fixture(db);return (await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;};
 const f=await seed();
 assert.equal(await rpc(db,'opc_source_allowed',f.actor,f.version),true);
 assert.equal(await rpc(db,'opc_content_allowed',f.actor,f.content),true);
 assert.match(JSON.stringify(await rpc(db,'opc_library',f.actor,'',null,null)),/D7_INDEPENDENT_SAVED_BODY/);
 assert.equal((await erase(db,f,'session',f.session)).status,'deleted');
 assert.match(JSON.stringify(await rpc(db,'opc_library',f.actor,'',null,null)),/D7_INDEPENDENT_SAVED_BODY/,
  'independent saved content stays listed without a live session join');
 assert.equal((await erase(db,f,'artifact',f.project)).status,'deleted');
 assert.equal((await erase(db,f,'artifact',f.project)).alreadyDeleted,true);
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
}
